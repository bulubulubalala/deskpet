/**
 * 文件职责：文字轮 / 语音轮 / 触摸轮共用的「当前这一轮」记账（D1 之后不再生产状态）。
 *
 * 为什么还需要它：D1 之前 HTTP 文字轮与 WS 语音轮各推一份 voice.state，两个生产者互相覆盖，
 * 于是这里长出了「本地先亮 listening / thinking / cancelling / idle」和「刚开口 1 秒内忽略
 * 迟到 idle」这些补丁。现在两条轮次都走 sidecar 的同一条 /ws/voice 流水线，状态由 sidecar
 * 单方面产出，主进程只剩两件事：
 * 1) 起新轮之前把旧轮取消掉（发一条 cancel；sidecar 在连接上按顺序先停旧轮再开新轮）；
 * 2) 把 sidecar 报的状态原样转给渲染层，并记住模式供切换与触发判断。
 *
 * 原来的「这条状态属于哪条流水线」仲裁已删除：连接上只有一条流水线，顺序由 sidecar 保证，
 * 不再需要猜迟到帧是谁的。
 *
 * 依赖方向：只依赖 ../shared/contracts/ipc 的类型；不 import electron、不碰网络，便于单测。
 */

import {
  VOICE_STATES,
  type UiInputMode,
  type VoiceState,
  type VoiceStatePayload,
} from "../shared/contracts/ipc";

export interface TurnCoordinatorDeps {
  /** 取消在途轮次（WS cancel）；没有在途轮次时应是空操作。 */
  cancel: () => void;
  /** 把 sidecar 报的状态原样转给渲染层（唯一 voiceState 出口）。 */
  emit: (payload: VoiceStatePayload) => void;
}

/**
 * 单一话筒：
 * - `startText()` / `startVoice()` 先取消在途轮次，再让新轮开始；
 * - `onState()` 只做校验与转发，phase 的真实值始终来自 sidecar；
 * - `cancelAll()` 只发取消，phase 由 sidecar 决定何时回到 idle。
 */
export class TurnCoordinator {
  private mode: UiInputMode = "text";
  private phase: VoiceState = "idle";
  private detail = "";
  private cancelTask: Promise<void> | null = null;
  private readonly listeners = new Set<(phase: VoiceState) => void>();
  private readonly cancelListeners = new Set<() => void>();

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

  /**
   * 订阅「取消已发出」：文字轮据此放弃认领后续事件。
   *
   * 为什么不订阅 phase：取消时 sidecar 会先报 cancelling → idle，而新轮可能已经开始，
   * 按状态判断会把新轮一起放弃；取消动作本身才是准确信号。
   */
  onCancel(listener: () => void): () => void {
    this.cancelListeners.add(listener);
    return () => {
      this.cancelListeners.delete(listener);
    };
  }

  setMode(mode: UiInputMode): void {
    this.mode = mode;
  }

  /** 文字发送 / demand 触摸起新轮：先取消在途轮次，新轮由 sidecar 接续。 */
  async startText(): Promise<void> {
    await this.startTurn();
  }

  /** 语音开口：先取消在途轮次，listening 由 sidecar 报。 */
  async startVoice(): Promise<void> {
    await this.startTurn();
  }

  /** sidecar 报来的状态：未知值按 idle 兜底（协议向前兼容）。 */
  onState(raw: string): void {
    const state: VoiceState = (VOICE_STATES as readonly string[]).includes(raw)
      ? (raw as VoiceState)
      : "idle";
    this.setPhase(state, "");
  }

  /** 连接断了：不会再有状态帧，本地回到空闲（避免界面永远停在 speaking）。 */
  onSocketClosed(): void {
    this.setPhase("idle", "");
  }

  /** 取消当前轮次：不发状态，等 sidecar 如实汇报 cancelling → idle。 */
  async cancelAll(): Promise<void> {
    if (this.cancelTask !== null) {
      await this.cancelTask;
      return;
    }
    for (const listener of this.cancelListeners) {
      listener();
    }
    this.cancelTask = Promise.resolve().then(() => {
      try {
        this.deps.cancel();
      } catch {
        // 取消失败不能挡住新轮：最坏只是旧轮的结果晚到，由 sidecar 的 generation 丢弃
      }
    });
    try {
      await this.cancelTask;
    } finally {
      this.cancelTask = null;
    }
  }

  private async startTurn(): Promise<void> {
    if (this.cancelTask !== null) {
      await this.cancelTask;
    }
    if (this.isBusy()) {
      await this.cancelAll();
    }
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
