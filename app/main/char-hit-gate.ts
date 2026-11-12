/**
 * 文件职责：触摸的「要不要花一次 LLM」闸门（T2.3-C2b，C2c 改按手势串计数）。
 *
 * 为什么单独一个模块：这是纯逻辑——只吃 (count, now)，不碰 Electron、不碰网络、不起定时器，
 * 所以单测直接喂一条时间轴就能验证去抖 / 冷却 / 每分钟上限，不必用假计时器。
 * 真正的 setTimeout 由 ipc-handlers.ts 负责，到点回来调 flush()。
 * 谁调用：app/main/ipc-handlers.ts 的 deskpet:ui:char-hit 处理。
 */

/** 一串触摸攒到这个数就本地吞掉，一次 LLM 都不发（方案 §4.3「你可以不理他」）。 */
export const HIT_IGNORE_COUNT = 10;
/** 去抖：最后一击之后再等这么久才发起，让「一口气戳 5 下」只花一次 LLM 并带上 5。 */
export const HIT_DEBOUNCE_MS = 600;
/** 冷却：一次真实发起之后这么久内不再发起（期间的触摸只进 usage.db 与观察）。 */
export const HIT_COOLDOWN_MS = 8000;
/** 频率上限的窗口与次数：全局每分钟最多 4 次，免得被反复戳刷屏。 */
export const HIT_RATE_WINDOW_MS = 60_000;
export const HIT_RATE_MAX = 4;
/** 力度上限：渲染层已经算过一次，这里再夹一道，防止异常值进提示词或统计。 */
export const HIT_COUNT_MAX = 999;
/**
 * 定时器可能比 dueAt 早一两毫秒回来（Node 的 setTimeout 只保证「不早于」的近似，且它走单调时钟，
 * Date.now() 是墙上时钟）。真机跑三次有一次 5 连击被静默吞掉，就是踩在这条缝上：容差之内照发。
 */
export const HIT_FLUSH_TOLERANCE_MS = 5;

/** 被闸门吞掉的三种原因：太密（冷却）/ 太频繁（每分钟上限）/ 太欠（≥10 下）。 */
export type HitGateIgnoreReason = "overloaded" | "cooling" | "rate_limited";

export type HitGateDecision =
  { kind: "ignored"; reason: HitGateIgnoreReason } | { kind: "pending"; delayMs: number };

/** 把外部传来的力度夹成 1..HIT_COUNT_MAX；非法值当 1（宁可多回一次，也别崩）。 */
export function clampTouchCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.trunc(value);
  if (rounded < 1) {
    return 1;
  }
  return Math.min(rounded, HIT_COUNT_MAX);
}

/**
 * 触摸闸门：记住最近几次真实发起的时间，决定这次触摸是「排进队列」还是「只记账」。
 *
 * 语义（写进需求 §6.11 的落地段）：
 * - 一串触摸只在最后一击之后 HIT_DEBOUNCE_MS 发起一次，携带整串的力度（早一两毫秒回来自带容差）；
 * - 冷却期内的触摸直接吞掉（不补发：8 秒后才冒一句「你手欠」已经不叫回应了）；
 * - 每分钟最多 HIT_RATE_MAX 次，超了吞掉；
 * - 力度 ≥ HIT_IGNORE_COUNT 直接吞掉，并取消已经排上的那一次。
 */
export class CharHitGate {
  private pendingCount = 0;
  private dueAt = 0;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private callTimes: number[] = [];

  /** 报一次触摸；返回 ignored 时调用方不必起定时器。 */
  onHit(count: number, now: number, debounceMs: number = HIT_DEBOUNCE_MS): HitGateDecision {
    const value = clampTouchCount(count);
    if (value >= HIT_IGNORE_COUNT) {
      this.clearPending();
      return { kind: "ignored", reason: "overloaded" };
    }
    this.prune(now);
    if (this.callTimes.length >= HIT_RATE_MAX) {
      this.clearPending();
      return { kind: "ignored", reason: "rate_limited" };
    }
    if (now < this.lastCallAt + HIT_COOLDOWN_MS) {
      return { kind: "ignored", reason: "cooling" };
    }
    this.pendingCount = Math.max(this.pendingCount, value);
    const debounce = Math.max(0, Math.trunc(debounceMs));
    this.dueAt = Math.max(now + debounce, this.lastCallAt + HIT_COOLDOWN_MS);
    return { kind: "pending", delayMs: Math.max(0, this.dueAt - now) };
  }

  /**
   * 冷却结束时刻；已经撞上每分钟上限时返回 Infinity（排队也没意义，直接丢）。
   * 供 T2.6 的 demand 排队用：冷却期内不丢，等 lastCall 满 8s 再发。
   */
  cooldownEndsAt(now: number): number {
    this.prune(now);
    if (this.callTimes.length >= HIT_RATE_MAX) {
      return Number.POSITIVE_INFINITY;
    }
    return this.lastCallAt + HIT_COOLDOWN_MS;
  }

  /** 现在是否处在冷却期（T2.6：冷却期的 demand 不提前 cancel，排队等冷却结束）。 */
  isCooling(now: number): boolean {
    this.prune(now);
    return this.callTimes.length < HIT_RATE_MAX && now < this.lastCallAt + HIT_COOLDOWN_MS;
  }

  /** 每分钟上限已满（排队也没意义）。 */
  isRateLimited(now: number): boolean {
    this.prune(now);
    return this.callTimes.length >= HIT_RATE_MAX;
  }

  /** 当前分钟窗口内还剩几次真实互动额度。 */
  remainingCalls(now: number): number {
    this.prune(now);
    return Math.max(0, HIT_RATE_MAX - this.callTimes.length);
  }

  /** 还有没有排着队等发的一次。定时器早回来时，调用方靠它区分「再等一会儿」与「这串已经被吞了」。 */
  hasPending(): boolean {
    return this.pendingCount > 0;
  }

  /** 待发的一次还差多少毫秒到点；没有待发的返回 0（调用方据此重排定时器）。 */
  remainingMs(now: number): number {
    if (this.pendingCount === 0) {
      return 0;
    }
    return Math.max(0, this.dueAt - now);
  }

  /** 定时器到点时问一次「现在能发了吗」；没到点或已经被吞掉都返回 null。 */
  flush(now: number): { count: number } | null {
    if (this.pendingCount === 0 || now + HIT_FLUSH_TOLERANCE_MS < this.dueAt) {
      return null;
    }
    this.prune(now);
    if (this.callTimes.length >= HIT_RATE_MAX) {
      this.clearPending();
      return null;
    }
    const count = this.pendingCount;
    this.clearPending();
    this.lastCallAt = now;
    this.callTimes.push(now);
    return { count };
  }

  /** 注销时清干净，免得旧定时器在下一次注册里乱发。 */
  reset(): void {
    this.clearPending();
  }

  private clearPending(): void {
    this.pendingCount = 0;
    this.dueAt = 0;
  }

  private prune(now: number): void {
    const cutoff = now - HIT_RATE_WINDOW_MS;
    this.callTimes = this.callTimes.filter((at) => at > cutoff);
  }
}
