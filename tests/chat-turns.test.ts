/**
 * 文件职责：ChatTurns 的单测——文字帧字段、事件翻成 chatEvent、取消/断线的收尾。
 *
 * 为什么全用 fake：这里要精确控制「连接开没开」「帧发没发出去」「第几个事件到达」，
 * 真实链路要走 sidecar 进程与模型；断言的是主进程这一层的翻译与记账，不是合成质量。
 * 依赖方向：tests -> app/main/chat-turns.ts + ../shared/contracts/ipc（不启动 Electron、不联网）。
 */
import { describe, expect, it } from "vitest";

import { ChatTurns, CODE_SYS_UNAVAILABLE, type ChatTurnsDeps } from "../app/main/chat-turns";
import type { MainLogger } from "../app/main/logger";
import type {
  ChatEventEnvelope,
  ChatSendRequest,
  VoiceStreamEvent,
  VoiceTextInput,
} from "../app/shared/contracts/ipc";

const logger: MainLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
};

const REQUEST: ChatSendRequest = {
  session_id: "s-1",
  char_id: "snow",
  text: "在吗",
};

interface Fake {
  turns: ChatTurns;
  events: ChatEventEnvelope[];
  frames: VoiceTextInput[];
  state: { starts: number; open: boolean; acceptFrame: boolean };
}

function setup(overrides: Partial<ChatTurnsDeps> = {}): Fake {
  const frames: VoiceTextInput[] = [];
  const events: ChatEventEnvelope[] = [];
  const state = { starts: 0, open: true, acceptFrame: true };
  const turns = new ChatTurns({
    socket: {
      isOpen: () => state.open,
      sendText: (frame) => {
        if (!state.acceptFrame) {
          return false;
        }
        frames.push(frame);
        return true;
      },
    },
    turn: {
      startText: () => {
        state.starts += 1;
        return Promise.resolve();
      },
    },
    logger,
    emitChatEvent: (envelope) => events.push(envelope),
    ...overrides,
  });
  return { turns, events, frames, state };
}

describe("ChatTurns", () => {
  it("没连上时拒收，给出能看懂的原因，且不抢话筒", async () => {
    const fake = setup();
    fake.state.open = false;
    const response = await fake.turns.send(REQUEST);
    expect(response.accepted).toBe(false);
    expect(response.reason).toContain("还没连上");
    expect(fake.state.starts).toBe(0);
    expect(fake.frames).toHaveLength(0);
  });

  it("连上时先起轮再发一条文字帧，字段与 sidecar 的 TextInput 对齐", async () => {
    const fake = setup();
    const response = await fake.turns.send({ ...REQUEST, app_context: ["正在写代码"] });
    expect(response).toEqual({ accepted: true, session_id: "s-1" });
    expect(fake.state.starts).toBe(1);
    expect(fake.turns.session).toBe("s-1");
    expect(fake.frames).toHaveLength(1);
    expect(fake.frames[0]).toMatchObject({
      t: "text",
      text: "在吗",
      char_id: "snow",
      tts_enabled: true,
      input_mode: "text",
      app_context: ["正在写代码"],
    });
    expect(typeof fake.frames[0]?.client_ts).toBe("number");
  });

  it("语音输出开关关掉后帧里带 tts_enabled:false", async () => {
    const fake = setup();
    fake.turns.setTtsEnabled(false);
    await fake.turns.send(REQUEST);
    expect(fake.frames[0]?.tts_enabled).toBe(false);
  });

  it("帧写不进去时如实拒收，并放弃这一轮", async () => {
    const fake = setup();
    fake.state.acceptFrame = false;
    const response = await fake.turns.send(REQUEST);
    expect(response.accepted).toBe(false);
    expect(response.reason).toContain("连接断了");
    expect(fake.turns.busy).toBe(false);
  });

  it("互动/主动开口这类可选字段原样透传", async () => {
    const fake = setup();
    await fake.turns.send({
      ...REQUEST,
      text: "",
      proactive: true,
      proactive_kind: "idle_chat",
      screen_text: "看屏幕",
      interaction: {
        gesture: "stroke",
        regions: [{ id: "head", name: "头" }],
        count: 2,
        duration_ms: 800,
      },
    });
    expect(fake.frames[0]).toMatchObject({
      proactive: true,
      proactive_kind: "idle_chat",
      screen_text: "看屏幕",
      interaction: { gesture: "stroke" },
    });
  });

  it("没有在跑的文字轮时不认领任何事件（语音轮照旧走 voiceEvent）", () => {
    const fake = setup();
    expect(fake.turns.handleEvent({ t: "llm.end" })).toBe(false);
  });

  it("台词/记忆/动作/结束按顺序翻成 chatEvent，seq 从 1 递增", async () => {
    const fake = setup();
    await fake.turns.send(REQUEST);
    expect(fake.turns.handleEvent({ t: "llm.s", i: 0, text: "在", intensity: 0.5 })).toBe(true);
    expect(
      fake.turns.handleEvent({ t: "llm.s", i: 1, text: "在的", emotion: "joy", intensity: 0.8 }),
    ).toBe(true);
    expect(fake.turns.handleEvent({ t: "llm.m", kind: "preference", text: "喜欢猫" })).toBe(true);
    expect(fake.turns.handleEvent({ t: "llm.a", act: "nod" })).toBe(true);
    expect(fake.turns.handleEvent({ t: "llm.end" })).toBe(true);

    expect(fake.events.map((item) => item.event.t)).toEqual(["s", "s", "m", "a", "end"]);
    expect(fake.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(fake.events[0]?.event).toEqual({ t: "s", i: 0, text: "在", intensity: 0.5 });
    expect(fake.events[1]?.event).toEqual({
      t: "s",
      i: 1,
      text: "在的",
      emotion: "joy",
      intensity: 0.8,
    });
    expect(fake.events[2]?.event).toEqual({
      t: "m",
      kind: "preference",
      text: "喜欢猫",
      importance: 0,
    });
    expect(fake.turns.busy).toBe(false);
  });

  it("记忆事件里不认识的 kind 归为事实", async () => {
    const fake = setup();
    await fake.turns.send(REQUEST);
    fake.turns.handleEvent({ t: "llm.m", kind: "diary", text: "今天下雨" });
    expect(fake.events[0]?.event).toEqual({
      t: "m",
      kind: "fact",
      text: "今天下雨",
      importance: 0,
    });
  });

  it("ASR 事件不认领（文字轮不该有识别结果）", async () => {
    const fake = setup();
    await fake.turns.send(REQUEST);
    const asr: VoiceStreamEvent = { t: "asr.partial", text: "你" };
    expect(fake.turns.handleEvent(asr)).toBe(false);
  });

  it("错误事件先报错再收尾，之后不再认领", async () => {
    const fake = setup();
    await fake.turns.send(REQUEST);
    expect(fake.turns.handleEvent({ t: "error", code: "DP-TTS-001", user_hint: "没声了" })).toBe(
      true,
    );
    expect(fake.events.map((item) => item.event.t)).toEqual(["e", "end"]);
    expect(fake.events[0]?.event).toMatchObject({
      t: "e",
      code: "DP-TTS-001",
      user_hint: "没声了",
      recoverable: true,
    });
    expect(fake.turns.busy).toBe(false);
    expect(fake.turns.handleEvent({ t: "llm.end" })).toBe(false);
  });

  it("取消/换轮之后放弃认领，但不再补一个假的结束事件", async () => {
    const fake = setup();
    await fake.turns.send(REQUEST);
    fake.turns.abandon();
    expect(fake.turns.busy).toBe(false);
    expect(fake.turns.handleEvent({ t: "llm.s", i: 0, text: "迟到", intensity: 0 })).toBe(false);
    expect(fake.events).toHaveLength(0);
  });

  it("中途断线：给界面一条可重试的错误 + 结束", async () => {
    const fake = setup();
    await fake.turns.send(REQUEST);
    fake.turns.onSocketClosed();
    expect(fake.events.map((item) => item.event.t)).toEqual(["e", "end"]);
    expect(fake.events[0]?.event).toMatchObject({
      t: "e",
      code: CODE_SYS_UNAVAILABLE,
      recoverable: true,
    });
    expect(fake.turns.busy).toBe(false);
  });

  it("没在跑的时候断线不吵人", () => {
    const fake = setup();
    fake.turns.onSocketClosed();
    expect(fake.events).toHaveLength(0);
  });

  it("新一轮的 seq 从 1 重新开始", async () => {
    const fake = setup();
    await fake.turns.send(REQUEST);
    fake.turns.handleEvent({ t: "llm.end" });
    await fake.turns.send({ ...REQUEST, session_id: "s-2" });
    fake.turns.handleEvent({ t: "llm.end" });
    expect(fake.events.map((item) => item.seq)).toEqual([1, 1]);
    expect(fake.events.at(-1)?.session_id).toBe("s-2");
  });
});
