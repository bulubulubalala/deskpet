/**
 * 文件职责：ChatOrchestrator 的单测——事件顺序、音频推送、打断作废、降级与语音状态镜像。
 *
 * 为什么全用 fake：真实链路要走 sidecar 进程、模型与网络；这里要精确控制「哪一拍被我打断」
 * 与「第几次合成失败」，只有注入假客户端才能断言。
 * 依赖方向：tests -> app/main/chat-orchestrator.ts + ./ipc 类型（不启动 Electron、不联网）。
 */
import { describe, expect, it } from "vitest";

import type { CharacterVoiceLoader, CharacterVoiceProfile } from "../app/main/character-voice";
import { ChatOrchestrator } from "../app/main/chat-orchestrator";
import type {
  ChatEvent,
  ChatEventEnvelope,
  ChatSentenceEvent,
  ChatSendRequest,
  TtsAudioMessage,
  VoiceStatePayload,
} from "../app/main/ipc";
import type { MainLogger } from "../app/main/logger";
import {
  SidecarCancelledError,
  SidecarHttpError,
  SidecarUnavailableError,
  type AsrRequest,
  type AsrResult,
  type ChatStreamHandlers,
  type SidecarClient,
  type TtsAudioResult,
  type TtsCancelResult,
  type TtsSynthesisRequest,
} from "../app/main/sidecar-client";

const logger: MainLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const PROFILE: CharacterVoiceProfile = {
  charId: "amber",
  voiceId: "D:/voices/amber.wav",
  lang: "zh",
  emotions: new Map([["joy", [1, 0, 0, 0, 0, 0, 0, 0]]]),
  voiceMissing: false,
};

class FakeVoice {
  readonly loads: string[] = [];
  profile: CharacterVoiceProfile = PROFILE;
  loadError: Error | null = null;

  load(charId: string): Promise<CharacterVoiceProfile> {
    this.loads.push(charId);
    if (this.loadError !== null) {
      return Promise.reject(this.loadError);
    }
    return Promise.resolve(this.profile);
  }
}

class FakeClient {
  events: ChatEvent[] = [];
  streamError: Error | null = null;
  ttsError: Error | null = null;
  asrError: Error | null = null;
  asrResult: AsrResult = { text: "你好", confidence: 0.9, durationS: 1.2, language: "zh" };
  gate: Promise<void> | null = null;
  ttsGate: Promise<void> | null = null;
  readonly synthesized: TtsSynthesisRequest[] = [];
  readonly cancelled: string[] = [];
  readonly asrRequests: AsrRequest[] = [];
  streamChatCalls = 0;
  synthStarted = 0;

  streamChat(_request: ChatSendRequest, handlers: ChatStreamHandlers): Promise<void> {
    this.streamChatCalls += 1;
    const run = (): void => {
      if (handlers.signal?.aborted === true) {
        throw new SidecarCancelledError();
      }
      for (const event of this.events) {
        handlers.onEvent(event);
      }
      if (this.streamError !== null) {
        throw this.streamError;
      }
    };
    if (this.gate === null) {
      try {
        run();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return this.gate.then(run);
  }

  synthesize(request: TtsSynthesisRequest): Promise<TtsAudioResult> {
    this.synthStarted += 1;
    if (this.ttsGate === null) {
      return this.finishSynthesize(request);
    }
    return this.ttsGate.then(() => this.finishSynthesize(request));
  }

  cancelTts(requestId: string): Promise<TtsCancelResult> {
    this.cancelled.push(requestId);
    return Promise.resolve({ cancelled: true });
  }

  transcribe(request: AsrRequest): Promise<AsrResult> {
    this.asrRequests.push(request);
    if (this.asrError !== null) {
      return Promise.reject(this.asrError);
    }
    return Promise.resolve(this.asrResult);
  }

  private finishSynthesize(request: TtsSynthesisRequest): Promise<TtsAudioResult> {
    if (this.ttsError !== null) {
      return Promise.reject(this.ttsError);
    }
    this.synthesized.push(request);
    return Promise.resolve({
      audio: Buffer.from([1, 2, 3]),
      contentType: "audio/wav",
      requestId: request.requestId,
      genMs: 10,
      audioMs: 100,
      rtf: 0.1,
      voice: request.voiceId,
    });
  }
}

function sentence(
  i: number,
  text: string,
  emotion?: string,
  intensity?: number,
): ChatSentenceEvent {
  return {
    t: "s",
    i,
    text,
    ...(emotion === undefined ? {} : { emotion }),
    intensity: intensity ?? 0.5,
  };
}

interface Sink {
  readonly envelopes: ChatEventEnvelope[];
  readonly states: VoiceStatePayload[];
  readonly audio: TtsAudioMessage[];
}

function setup(
  client: FakeClient,
  voice = new FakeVoice(),
): {
  orchestrator: ChatOrchestrator;
  sink: Sink;
} {
  const sink: Sink = { envelopes: [], states: [], audio: [] };
  const orchestrator = new ChatOrchestrator({
    client: client as unknown as SidecarClient,
    voice: voice as unknown as CharacterVoiceLoader,
    logger,
    emitChatEvent: (envelope) => {
      sink.envelopes.push(envelope);
    },
    emitVoiceState: (payload) => {
      sink.states.push(payload);
    },
    emitAudio: (message) => {
      sink.audio.push(message);
    },
  });
  return { orchestrator, sink };
}

const REQUEST: ChatSendRequest = { session_id: "s1", char_id: "amber", text: "你好" };

describe("ChatOrchestrator", () => {
  it("一轮对话：事件按序编号、逐句合成推音频、状态回到 idle", async () => {
    const client = new FakeClient();
    client.events = [sentence(0, "第一句", "joy", 1), sentence(1, "第二句"), { t: "end" }];
    const { orchestrator, sink } = setup(client);

    const response = await orchestrator.send(REQUEST);

    expect(response).toEqual({ accepted: true, session_id: "s1" });
    expect(sink.envelopes.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(sink.envelopes.map((item) => item.event.t)).toEqual(["s", "s", "end"]);
    expect(sink.audio.map((item) => item.text)).toEqual(["第一句", "第二句"]);
    expect(sink.audio[0]?.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(client.synthesized[0]?.requestId).toBe("s1:0:1");
    expect(client.synthesized[0]?.voiceId).toBe("D:/voices/amber.wav");
    // 情感标签 joy 的基向量是 [1,0,...]，强度 1 → 原样；第二句没标签 → 8 维零向量
    expect(client.synthesized[0]?.emoVector).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(client.synthesized[1]?.emoVector).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sink.states.map((item) => item.state)).toEqual(["thinking", "speaking", "idle"]);
  });

  it("同一时间只允许一轮：第二轮被拒并说明原因", async () => {
    const client = new FakeClient();
    const gate = deferred();
    client.gate = gate.promise;
    const { orchestrator, sink } = setup(client);

    const first = orchestrator.send(REQUEST);
    const second = await orchestrator.send({ ...REQUEST, text: "再说一句" });

    expect(second.accepted).toBe(false);
    expect(second.reason).toContain("打断");
    expect(client.streamChatCalls).toBe(1);
    expect(sink.states.at(-1)?.state).toBe("thinking");

    await orchestrator.cancel({ session_id: "s1" });
    gate.resolve();
    await first;
  });

  it("打断后：合成结果作废、通知 sidecar 取消、状态回 idle", async () => {
    const client = new FakeClient();
    client.events = [sentence(0, "这一句会被打断")];
    const ttsGate = deferred();
    client.ttsGate = ttsGate.promise;
    const { orchestrator, sink } = setup(client);

    const sending = orchestrator.send(REQUEST);
    for (let i = 0; i < 20 && client.synthStarted === 0; i += 1) {
      await tick();
    }
    expect(client.synthStarted).toBe(1);

    const cancelled = await orchestrator.cancel({ session_id: "s1" });
    expect(cancelled).toEqual({ cancelled: true });
    expect(client.cancelled).toEqual(["s1:0:1"]);
    expect(sink.states.at(-1)?.state).toBe("idle");

    ttsGate.resolve();
    await sending;
    expect(sink.audio).toHaveLength(0);
  });

  it("没有进行中的回复时打断返回 cancelled=false", async () => {
    const { orchestrator } = setup(new FakeClient());
    expect(await orchestrator.cancel({ session_id: "s1" })).toEqual({
      cancelled: false,
      reason: "当前没有进行中的回复",
    });
  });

  it("流失败：按 sidecar 的 code 发 e 事件并以 end 收尾", async () => {
    const client = new FakeClient();
    client.streamError = new SidecarHttpError(503, "DP-LLM-003", "模型超时", "等会儿再说");
    const { orchestrator, sink } = setup(client);

    await orchestrator.send(REQUEST);

    expect(sink.envelopes.map((item) => item.event.t)).toEqual(["e", "end"]);
    expect(sink.envelopes[0]?.event).toMatchObject({
      code: "DP-LLM-003",
      user_hint: "等会儿再说",
      recoverable: true,
    });
    expect(sink.states.at(-1)?.state).toBe("idle");
  });

  it("引擎不可用：用 DP-SYS-503 提示，不重播也不停在说话", async () => {
    const client = new FakeClient();
    client.streamError = new SidecarUnavailableError("连不上");
    const { orchestrator, sink } = setup(client);

    await orchestrator.send(REQUEST);

    expect(sink.envelopes[0]?.event).toMatchObject({ code: "DP-SYS-503" });
    expect(sink.envelopes.map((item) => item.event.t)).toEqual(["e", "end"]);
  });

  it("连续合成失败到第 3 次才提示一次", async () => {
    const client = new FakeClient();
    client.ttsError = new SidecarHttpError(500, "DP-TTS-500", "引擎没起来", "引擎侧看日志");
    client.events = [sentence(0, "一"), sentence(1, "二"), sentence(2, "三")];
    const { orchestrator, sink } = setup(client);

    await orchestrator.send(REQUEST);

    const errors = sink.envelopes.filter((item) => item.event.t === "e");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toMatchObject({ code: "DP-TTS-500", user_hint: "引擎侧看日志" });
    expect(sink.audio).toHaveLength(0);
  });

  it("角色没有参考音时纯文字继续（不报错、不合成）", async () => {
    const client = new FakeClient();
    client.events = [sentence(0, "只有文字"), { t: "end" }];
    const voice = new FakeVoice();
    voice.profile = { ...PROFILE, voiceId: "", voiceMissing: true };
    const { orchestrator, sink } = setup(client, voice);

    expect(await orchestrator.send(REQUEST)).toEqual({ accepted: true, session_id: "s1" });
    expect(client.synthStarted).toBe(0);
    expect(sink.audio).toHaveLength(0);
    expect(sink.envelopes.map((item) => item.event.t)).toEqual(["s", "end"]);
  });

  it("读角色音色失败也不打断对话", async () => {
    const client = new FakeClient();
    client.events = [sentence(0, "照常说")];
    const voice = new FakeVoice();
    voice.loadError = new Error("voice.json 坏了");
    const { orchestrator, sink } = setup(client, voice);

    await expect(orchestrator.send(REQUEST)).resolves.toEqual({
      accepted: true,
      session_id: "s1",
    });
    expect(sink.audio).toHaveLength(0);
  });

  it("startListening 会打断在途一轮并进入 listening", async () => {
    const client = new FakeClient();
    const gate = deferred();
    client.gate = gate.promise;
    client.events = [sentence(0, "晚到的台词")];
    const { orchestrator, sink } = setup(client);

    const sending = orchestrator.send(REQUEST);
    const state = await orchestrator.startListening();

    expect(state.state).toBe("listening");
    expect(sink.states.at(-1)?.state).toBe("listening");
    gate.resolve();
    await sending;
    expect(sink.audio).toHaveLength(0);
    // 用户在听，状态就必须停在 listening（被打断那一轮不许把它拉回 idle）
    expect(sink.states.at(-1)?.state).toBe("listening");
  });

  it("stopListening：识别出文本才算 heard", async () => {
    const client = new FakeClient();
    const { orchestrator, sink } = setup(client);

    const heard = await orchestrator.stopListening({
      session_id: "s1",
      sample_rate: 16000,
      pcm: new Uint8Array([1, 2, 3, 4]),
    });

    expect(heard).toEqual({ text: "你好", confidence: 0.9, heard: true, language: "zh" });
    expect(client.asrRequests[0]?.sampleRate).toBe(16000);
    expect(client.asrRequests[0]?.pcm.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(sink.states.map((item) => item.state)).toEqual(["thinking", "idle"]);
  });

  it("stopListening：空文本或零置信度按没听清处理", async () => {
    const client = new FakeClient();
    client.asrResult = { text: "  ", confidence: 0, durationS: 0.1, language: null };
    const { orchestrator } = setup(client);

    const result = await orchestrator.stopListening({
      session_id: "s1",
      sample_rate: 16000,
      pcm: new Uint8Array([0, 0]),
    });

    expect(result).toEqual({ text: "", confidence: 0, heard: false });
  });

  it("stopListening：空 PCM 按关麦处理，回到 idle 且不调 ASR", async () => {
    const client = new FakeClient();
    const { orchestrator, sink } = setup(client);

    const result = await orchestrator.stopListening({
      session_id: "s1",
      sample_rate: 16000,
      pcm: new Uint8Array(0),
    });

    expect(result).toEqual({ text: "", confidence: 0, heard: false });
    expect(client.asrRequests).toHaveLength(0);
    // 本来就是 idle：setState 会去重，不广播；用状态本身验证「关麦后回到 idle」
    expect(sink.states).toHaveLength(0);
    expect(orchestrator.getVoiceState().state).toBe("idle");
  });

  it("stopListening：识别报错也按没听清处理，不抛给渲染层", async () => {
    const client = new FakeClient();
    client.asrError = new SidecarUnavailableError("识别服务没起来");
    const { orchestrator } = setup(client);

    const result = await orchestrator.stopListening({
      session_id: "s1",
      sample_rate: 16000,
      pcm: new Uint8Array([0, 0]),
    });

    expect(result).toEqual({ text: "", confidence: 0, heard: false });
  });
});
