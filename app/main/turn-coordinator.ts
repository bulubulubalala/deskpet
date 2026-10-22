/**
 * 文件职责：语音 / 文字 / 触摸共用的「话筒」状态（T2.6）。
 *
 * 为什么需要它：HTTP 文字轮与 WS 语音轮各自推 voice.state；以前两个生产者直接写给渲染层，
 * 迟到的 idle 会把新一轮的 thinking 盖掉。这里把两条流收成一份：只有当前 source 的状态能改
 * phase，取消期间的状态全部丢弃；文本发送 / 语音开口 / demand 触摸都先经过 start*()。
 *
 * 依赖方向：只依赖 ./ipc 的类型；不 import electron、不碰网络，便于单测。
 */

import { VOICE_STATES, type UiInputMode, type VoiceState, type VoiceStatePayload } from "./ipc";

/** 刚开口后的这段时间内，上一轮 cancel 迟到的 idle 不能把 listening 打回空闲。 */
export const VOICE_STALE_IDLE_MS = 1000;

export type TurnSource = "http" | "voice" | "none";

export interface TurnCoordinatorDeps {
  /** 取消 HTTP 轮（orchestrator.cancel）；没有在途轮次也应安全返回。 */
  cancelHttp: () => Promise<void>;
  /** 取消 WS 语音轮（发 cancel）；没有连接时应是空操作。 */
  cancelVoice: () => void;
  /** 把聚合后的状态推给渲染层（唯一 voiceState 出口）。 */
  emit: (payload: VoiceStatePayload) => void;
  /** 测试注入时钟。 */
  now?: () => number;
}

/**
 * 单一话筒：
 * - `startHttp()` / `startVoice()` 会先取消在途轮次，再接管 source；
 * - `cancelAll()` 只发取消、停在 cancelling，等调用方决定是开新轮还是 `finishCancel()`；
 * - 只有当前 source（或空闲时的第一条）状态能改 phase，旧流水线的迟到事件一律忽略。
 */
export class TurnCoordinator {
  private mode: UiInputMode = "text";
  private phase: VoiceState = "idle";
  private detail = "";
  private source: TurnSource = "none";
  private cancelling = false;
  private cancelTask: Promise<void> | null = null;
  private voiceStartedAt = 0;
  private readonly listeners = new Set<(phase: VoiceState) => void>();

  constructor(private readonly deps: TurnCoordinatorDeps) {}

  getMode(): UiInputMode {
    return this.mode;
  }

  getPhase(): VoiceState {
    return this.phase;
  }

  /** 有轮次在跑（含 cancelling）；idle 才算空闲。 */
  isBusy(): boolean {
    return this.phase !== "idle";
  }

  /** 订阅 phase 变化：触摸冷却队列靠它在「回到 idle」时补发。 */
  subscribe(listener: (phase: VoiceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setMode(mode: UiInputMode): void {
    this.mode = mode;
  }

  /** 文字发送 / demand 触摸起新轮：先取消在途轮次，再交给 HTTP 编排。 */
  async startHttp(): Promise<void> {
    if (this.cancelTask !== null) {
      await this.cancelTask;
    }
    if (this.cancelling) {
      // 取消已经完成，只是调用方还没 finishCancel：直接接管，避免再取消一次
      this.cancelling = false;
    } else if (this.isBusy()) {
      await this.cancelAll();
    }
    this.cancelling = false;
    this.source = "http";
  }

  /** 语音开口：先取消在途轮次，再开始听；立刻把界面切到 listening。 */
  async startVoice(): Promise<void> {
    if (this.cancelTask !== null) {
      await this.cancelTask;
    }
    if (this.cancelling) {
      this.cancelling = false;
    } else if (this.isBusy()) {
      await this.cancelAll();
    }
    this.cancelling = false;
    this.source = "voice";
    this.voiceStartedAt = this.now();
    this.setPhase("listening", "");
  }

  /** 一句说完（audio.end）：先亮「在想」，ASR 结果回来前界面不空白。 */
  markVoiceEnd(): void {
    if (this.source === "voice" && (this.phase === "listening" || this.phase === "idle")) {
      this.setPhase("thinking", "");
    }
  }

  /** HTTP 编排的状态：不是当前 source 就丢弃（例如 WS 正在说话时的 HTTP idle）。 */
  onHttpState(payload: VoiceStatePayload): void {
    if (this.cancelling) {
      return;
    }
    if (this.source !== "http" && this.source !== "none") {
      return;
    }
    this.source = payload.state === "idle" ? "none" : "http";
    this.setPhase(payload.state, payload.detail ?? "");
  }

  /** WS 语音状态：不是当前 source 就丢弃；刚开口的 1s 内忽略上一轮迟到的 idle。 */
  onWsState(raw: string): void {
    const state: VoiceState = (VOICE_STATES as readonly string[]).includes(raw)
      ? (raw as VoiceState)
      : "idle";
    if (this.cancelling) {
      return;
    }
    if (this.source !== "voice" && this.source !== "none") {
      return;
    }
    if (state === "idle") {
      if (this.source === "voice" && this.phase === "listening") {
        if (this.now() - this.voiceStartedAt < VOICE_STALE_IDLE_MS) {
          return;
        }
      }
      this.source = "none";
    } else {
      this.source = "voice";
    }
    this.setPhase(state, "");
  }

  /** 取消两条流水线：只停在 cancelling，调用方随后 start* 或 finishCancel。 */
  async cancelAll(): Promise<void> {
    if (this.cancelTask !== null) {
      await this.cancelTask;
      return;
    }
    if (this.cancelling || this.phase === "idle") {
      return;
    }
    this.cancelling = true;
    this.source = "none";
    this.setPhase("cancelling", "");
    this.cancelTask = (async (): Promise<void> => {
      try {
        await this.deps.cancelHttp();
      } catch {
        // 取消失败不能挡住新轮：HTTP 侧会把活动标记清掉，最坏只是旧流被忽略
      }
      this.deps.cancelVoice();
    })();
    try {
      await this.cancelTask;
    } finally {
      this.cancelTask = null;
    }
  }

  /** 没有后续新轮的取消（停止按钮 / 切走正在听的语音）：落回 idle。 */
  finishCancel(): void {
    if (!this.cancelling || this.cancelTask !== null) {
      return;
    }
    this.cancelling = false;
    this.source = "none";
    this.setPhase("idle", "");
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setPhase(state: VoiceState, detail: string): void {
    if (this.phase === state && this.detail === detail) {
      return;
    }
    this.phase = state;
    this.detail = detail;
    this.deps.emit(detail === "" ? { state } : { state, detail });
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
