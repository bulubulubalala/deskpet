/**
 * 文件职责：sidecar 存活状态机（纯逻辑：无定时器、无 IO、不 import electron）。
 *
 * 规则（需求 §7.2）：心跳连续失败 3 次 → 判离线并自动重启；自动重启预算 3 次，
 * 预算用尽仍失败 → failed（UI 明示失败并给排障指引，不无限重启）。
 * 为什么一次成功要把重启预算清零：否则长时间运行下偶发抖动累计 3 次，
 * 应用就永久失去自愈能力，只能整程序重启——那不符合「能自愈的绝不打扰用户」。
 * 依赖方向：main 内部纯模块；谁调用：app/main/engine.ts；tests/heartbeat.test.ts 直接单测。
 */

export type EngineState = "starting" | "online" | "offline" | "restarting" | "failed";

export interface HeartbeatSnapshot {
  readonly state: EngineState;
  /** 当前连续失败次数（每次都从 0 重新数，达到上限时已复位）。 */
  readonly consecutiveFailures: number;
  readonly restartsUsed: number;
  readonly maxRestarts: number;
  readonly lastOkAtMs: number | null;
  readonly lastFailureAtMs: number | null;
  readonly lastError: string | null;
}

/** 状态机给出的动作：什么都不做 / 申请重启 / 判死（不再自动重启）。 */
export type HeartbeatDecision =
  { readonly kind: "none" } | { readonly kind: "restart" } | { readonly kind: "fatal" };

export interface HeartbeatOptions {
  readonly maxFailures: number;
  readonly maxRestarts: number;
}

export class HeartbeatMonitor {
  private state: EngineState = "starting";
  private failures = 0;
  private restartsUsed = 0;
  private lastOkAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: HeartbeatOptions) {}

  /** 心跳成功：回到 online，失败计数与重启预算一起清零。 */
  recordSuccess(nowMs: number): HeartbeatDecision {
    this.failures = 0;
    this.restartsUsed = 0;
    this.state = "online";
    this.lastOkAtMs = nowMs;
    this.lastError = null;
    return { kind: "none" };
  }

  /** 心跳失败：够 maxFailures 次就申请重启；预算用尽则判死。 */
  recordFailure(nowMs: number, error: string): HeartbeatDecision {
    this.failures += 1;
    this.lastFailureAtMs = nowMs;
    this.lastError = error;
    // 已经判死的实例不再反复申请重启：重启预算用尽后只有用户手动重启或改配置才能救
    if (this.state === "failed") {
      return { kind: "fatal" };
    }
    if (this.failures < this.options.maxFailures) {
      return { kind: "none" };
    }
    this.failures = 0;
    if (this.restartsUsed >= this.options.maxRestarts) {
      this.state = "failed";
      return { kind: "fatal" };
    }
    this.restartsUsed += 1;
    this.state = "offline";
    return { kind: "restart" };
  }

  /** 重启开始（自动或手动）：进入 restarting，失败计数复位。 */
  noteRestarting(): void {
    this.state = "restarting";
    this.failures = 0;
  }

  /** 重启本身失败（例如 sidecar 起不来）：直接判死，避免把「起不来」当成「心跳抖动」重试 3 次。 */
  noteRestartFailed(error: string): void {
    this.state = "failed";
    this.lastError = error;
  }

  snapshot(): HeartbeatSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      restartsUsed: this.restartsUsed,
      maxRestarts: this.options.maxRestarts,
      lastOkAtMs: this.lastOkAtMs,
      lastFailureAtMs: this.lastFailureAtMs,
      lastError: this.lastError,
    };
  }
}
