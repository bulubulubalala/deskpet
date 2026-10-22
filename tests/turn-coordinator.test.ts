/**
 * 文件职责：单一话筒（T2.6）的状态机单测。
 *
 * 覆盖：默认文字模式、HTTP / WS 状态互不覆盖、迟到 idle 丢弃、取消后接管新轮、
 * 订阅回调（触摸冷却队列靠它等 idle）。全部用注入时钟，不碰 Electron / 网络。
 */

import { describe, expect, it } from "vitest";

import { TurnCoordinator, VOICE_STALE_IDLE_MS } from "../app/main/turn-coordinator";
import type { VoiceStatePayload } from "../app/main/ipc";

const T0 = 1_000_000;

function make(now: () => number = () => T0) {
  const emitted: VoiceStatePayload[] = [];
  const calls = { http: 0, voice: 0 };
  const coordinator = new TurnCoordinator({
    cancelHttp: () => {
      calls.http += 1;
      return Promise.resolve();
    },
    cancelVoice: () => {
      calls.voice += 1;
    },
    emit: (payload) => {
      emitted.push(payload);
    },
    now,
  });
  return { coordinator, emitted, calls };
}

describe("TurnCoordinator", () => {
  it("默认文字模式、空闲", () => {
    const { coordinator } = make();
    expect(coordinator.getMode()).toBe("text");
    expect(coordinator.getPhase()).toBe("idle");
    expect(coordinator.isBusy()).toBe(false);
  });

  it("HTTP 轮的状态只由 HTTP 改；WS 的 thinking 被忽略", async () => {
    const { coordinator, emitted } = make();
    await coordinator.startHttp();
    coordinator.onHttpState({ state: "thinking" });
    expect(coordinator.getPhase()).toBe("thinking");
    coordinator.onWsState("speaking");
    expect(coordinator.getPhase()).toBe("thinking");
    coordinator.onHttpState({ state: "speaking", detail: "正在说" });
    expect(coordinator.getPhase()).toBe("speaking");
    coordinator.onHttpState({ state: "idle" });
    expect(coordinator.getPhase()).toBe("idle");
    expect(emitted.map((item) => item.state)).toEqual(["thinking", "speaking", "idle"]);
  });

  it("语音开口立刻 listening；HTTP 的状态被忽略；说完转 thinking", async () => {
    const { coordinator, emitted } = make();
    await coordinator.startVoice();
    expect(coordinator.getPhase()).toBe("listening");
    coordinator.onHttpState({ state: "thinking" });
    expect(coordinator.getPhase()).toBe("listening");
    coordinator.markVoiceEnd();
    expect(coordinator.getPhase()).toBe("thinking");
    coordinator.onWsState("speaking");
    coordinator.onWsState("idle");
    expect(coordinator.getPhase()).toBe("idle");
    expect(emitted.map((item) => item.state)).toEqual([
      "listening",
      "thinking",
      "speaking",
      "idle",
    ]);
  });

  it("刚开口 1s 内忽略上一轮迟到的 WS idle", async () => {
    let now = T0;
    const { coordinator } = make(() => now);
    await coordinator.startVoice();
    now = T0 + VOICE_STALE_IDLE_MS - 1;
    coordinator.onWsState("idle");
    expect(coordinator.getPhase()).toBe("listening");
    now = T0 + VOICE_STALE_IDLE_MS;
    coordinator.onWsState("idle");
    expect(coordinator.getPhase()).toBe("idle");
  });

  it("cancelAll 只停在 cancelling，随后 startHttp 接管新轮", async () => {
    const { coordinator, emitted, calls } = make();
    await coordinator.startHttp();
    coordinator.onHttpState({ state: "speaking" });
    await coordinator.cancelAll();
    expect(coordinator.getPhase()).toBe("cancelling");
    expect(calls).toEqual({ http: 1, voice: 1 });
    await coordinator.startHttp();
    coordinator.onHttpState({ state: "thinking" });
    expect(coordinator.getPhase()).toBe("thinking");
    expect(emitted.map((item) => item.state)).toEqual(["speaking", "cancelling", "thinking"]);
  });

  it("finishCancel 落回 idle；订阅者收到 idle", async () => {
    const { coordinator } = make();
    const phases: string[] = [];
    coordinator.subscribe((phase) => phases.push(phase));
    await coordinator.startVoice();
    await coordinator.cancelAll();
    coordinator.finishCancel();
    expect(coordinator.getPhase()).toBe("idle");
    expect(phases).toEqual(["listening", "cancelling", "idle"]);
  });

  it("取消期间两条流水线的状态都不推进界面", async () => {
    const { coordinator } = make();
    await coordinator.startHttp();
    coordinator.onHttpState({ state: "thinking" });
    await coordinator.cancelAll();
    const before = coordinator.getPhase();
    coordinator.onHttpState({ state: "idle" });
    coordinator.onWsState("thinking");
    expect(coordinator.getPhase()).toBe(before);
  });
});
