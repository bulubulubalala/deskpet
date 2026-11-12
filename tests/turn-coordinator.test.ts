/**
 * 文件职责：TurnCoordinator 的单测——起轮先取消、状态如实转发、取消去重、断线回空闲。
 *
 * 为什么全用 fake：这里只该关心「顺序与次数」，不该关心 sidecar 真的收到什么；
 * 一条连接上的顺序由 sidecar 保证，主进程这边能断言的只有调了几次 cancel、转发了几帧。
 * 依赖方向：tests -> app/main/turn-coordinator.ts + ../shared/contracts/ipc（不启动 Electron、不联网）。
 */
import { describe, expect, it } from "vitest";

import { TurnCoordinator } from "../app/main/turn-coordinator";
import type { VoiceState, VoiceStatePayload } from "../app/shared/contracts/ipc";

function setup(): {
  turn: TurnCoordinator;
  counters: { cancels: number };
  emitted: VoiceStatePayload[];
} {
  const emitted: VoiceStatePayload[] = [];
  const counters = { cancels: 0 };
  const turn = new TurnCoordinator({
    cancel: () => {
      counters.cancels += 1;
    },
    emit: (payload) => emitted.push(payload),
  });
  return { turn, counters, emitted };
}

describe("TurnCoordinator", () => {
  it("默认空闲、默认文字模式", () => {
    const { turn } = setup();
    expect(turn.getPhase()).toBe("idle");
    expect(turn.getMode()).toBe("text");
    expect(turn.isBusy()).toBe(false);

    turn.setMode("voice");
    expect(turn.getMode()).toBe("voice");
  });

  it("把 sidecar 报的状态原样转发并更新 phase", () => {
    const { turn, emitted } = setup();
    turn.onState("listening");
    expect(turn.getPhase()).toBe("listening");
    expect(turn.isBusy()).toBe(true);
    expect(emitted).toEqual([{ state: "listening" }]);

    turn.onState("idle");
    expect(emitted).toEqual([{ state: "listening" }, { state: "idle" }]);
    expect(turn.isBusy()).toBe(false);
  });

  it("同一个状态重复报只转发一次（界面不用重排）", () => {
    const { turn, emitted } = setup();
    turn.onState("thinking");
    turn.onState("thinking");
    expect(emitted).toEqual([{ state: "thinking" }]);
  });

  it("未知状态按空闲兜底（协议向前兼容）", () => {
    const { turn, emitted } = setup();
    turn.onState("speaking");
    emitted.length = 0;
    turn.onState("teleporting");
    expect(turn.getPhase()).toBe("idle");
    expect(emitted).toEqual([{ state: "idle" }]);
  });

  it("空闲时起文字轮不发取消", async () => {
    const { turn, counters } = setup();
    await turn.startText();
    expect(counters.cancels).toBe(0);
  });

  it("忙时起文字轮先取消旧轮；取消事件在真正发取消之前同步到达", async () => {
    const { turn, counters } = setup();
    let cancelledWhenNotified = -1;
    turn.onCancel(() => {
      cancelledWhenNotified = counters.cancels;
    });
    turn.onState("speaking");

    await turn.startText();

    expect(counters.cancels).toBe(1);
    expect(cancelledWhenNotified).toBe(0);
  });

  it("忙时起语音轮同样先取消", async () => {
    const { turn, counters } = setup();
    turn.onState("thinking");
    await turn.startVoice();
    expect(counters.cancels).toBe(1);
  });

  it("并发取消只发一次，并发的第二个调用等第一次结束", async () => {
    const { turn, counters } = setup();
    turn.onState("speaking");
    await Promise.all([turn.cancelAll(), turn.cancelAll(), turn.cancelAll()]);
    expect(counters.cancels).toBe(1);
  });

  it("取消之后可以再次取消（下一轮仍能被打断）", async () => {
    const { turn, counters } = setup();
    turn.onState("speaking");
    await turn.cancelAll();
    await turn.cancelAll();
    expect(counters.cancels).toBe(2);
  });

  it("取消回调只通知，不改 phase——状态由 sidecar 如实汇报", async () => {
    const { turn } = setup();
    let notified = 0;
    turn.onCancel(() => {
      notified += 1;
    });
    turn.onState("speaking");
    await turn.cancelAll();
    expect(notified).toBe(1);
    // 本地不假装 cancelling：sidecar 会先报 cancelling 再报 idle
    expect(turn.getPhase()).toBe("speaking");
  });

  it("取消回调可以退订", async () => {
    const { turn } = setup();
    let notified = 0;
    const off = turn.onCancel(() => {
      notified += 1;
    });
    off();
    await turn.cancelAll();
    expect(notified).toBe(0);
  });

  it("取消失败不挡住新轮", async () => {
    const emitted: VoiceStatePayload[] = [];
    const turn = new TurnCoordinator({
      cancel: () => {
        throw new Error("socket 已关");
      },
      emit: (payload) => emitted.push(payload),
    });
    turn.onState("speaking");
    await expect(turn.cancelAll()).resolves.toBeUndefined();
    await expect(turn.startText()).resolves.toBeUndefined();
  });

  it("连接断了本地回到空闲（避免界面永远停在 speaking）", () => {
    const { turn, emitted } = setup();
    turn.onState("speaking");
    turn.onSocketClosed();
    expect(turn.getPhase()).toBe("idle");
    expect(emitted.at(-1)).toEqual({ state: "idle" });
  });

  it("subscribe 收到每一次 phase 变化", () => {
    const { turn } = setup();
    const seen: VoiceState[] = [];
    const off = turn.subscribe((phase) => seen.push(phase));
    turn.onState("listening");
    turn.onState("idle");
    off();
    turn.onState("thinking");
    expect(seen).toEqual(["listening", "idle"]);
  });
});
