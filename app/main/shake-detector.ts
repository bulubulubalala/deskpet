/**
 * 文件职责：窗口晃动检测（T2.3-C1）——把主进程收到的窗口位移判成「用户在甩窗口」。
 *
 * 为什么要独立成一个纯模块：窗口 move 事件一秒能来上百条，判定逻辑（滑窗、方向反转、
 * 冷却）必须能不起 Electron 就单测；主进程只负责喂坐标、命中后上报 sidecar。
 * 依赖方向：main 内部纯逻辑，不 import electron、不发网络请求（CODE_STYLE §1.2）。
 * 谁调用：app/main/index.ts 的 createPetWindow({ onMoving }) 回调。
 */

/** 判定窗口：只在这段时间内的连续位移里数方向反转。 */
export const SHAKE_WINDOW_MS = 800;
/** 方向反转次数门槛：来回 4 次（= 5 段方向）才算甩，避免拖动时的手抖。 */
export const SHAKE_MIN_REVERSALS = 4;
/** 单步位移门槛（像素）：小于它的移动不算一个方向样本。 */
export const SHAKE_MIN_STEP_PX = 15;
/** 命中后的冷却：一次甩动只记一次，别把余震记成一串。 */
export const SHAKE_COOLDOWN_MS = 1500;

interface DirectionSample {
  readonly at: number;
  readonly dirX: number;
  readonly dirY: number;
}

export interface ShakeDetectorOptions {
  readonly windowMs?: number;
  readonly minReversals?: number;
  readonly minStepPx?: number;
  readonly cooldownMs?: number;
}

/**
 * 有状态的晃动判定：push 一次窗口位置，返回是否命中一次晃动。
 *
 * 主方向只取一条轴（|dx| ≥ |dy| 记 x，否则记 y）：斜着甩也不会被算成两条轴同时反转。
 */
export class ShakeDetector {
  private readonly windowMs: number;
  private readonly minReversals: number;
  private readonly minStepPx: number;
  private readonly cooldownMs: number;
  private samples: DirectionSample[] = [];
  private last: { x: number; y: number } | null = null;
  private cooldownUntil = 0;

  constructor(options: ShakeDetectorOptions = {}) {
    this.windowMs = options.windowMs ?? SHAKE_WINDOW_MS;
    this.minReversals = options.minReversals ?? SHAKE_MIN_REVERSALS;
    this.minStepPx = options.minStepPx ?? SHAKE_MIN_STEP_PX;
    this.cooldownMs = options.cooldownMs ?? SHAKE_COOLDOWN_MS;
  }

  /** 喂一个窗口位置；命中一次晃动返回 true（同一次甩动只可能返回一次）。 */
  push(x: number, y: number, at: number): boolean {
    const previous = this.last;
    this.last = { x, y };
    if (previous === null) {
      return false;
    }
    const dx = x - previous.x;
    const dy = y - previous.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < this.minStepPx) {
      return false;
    }
    if (at < this.cooldownUntil) {
      return false;
    }
    this.samples.push(directionOf(dx, dy, at));
    this.prune(at);
    if (countReversals(this.samples) < this.minReversals) {
      return false;
    }
    this.samples = [];
    this.cooldownUntil = at + this.cooldownMs;
    return true;
  }

  /** 清空状态（窗口重建时调用，避免旧样本跨窗口粘连）。 */
  reset(): void {
    this.samples = [];
    this.last = null;
    this.cooldownUntil = 0;
  }

  private prune(at: number): void {
    while (this.samples.length > 0 && at - (this.samples[0]?.at ?? at) > this.windowMs) {
      this.samples.shift();
    }
  }
}

/** 只保留主方向的符号：横向位移更大时看 x，否则看 y。 */
function directionOf(dx: number, dy: number, at: number): DirectionSample {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { at, dirX: Math.sign(dx), dirY: 0 };
  }
  return { at, dirX: 0, dirY: Math.sign(dy) };
}

/** 数方向变化次数：同一方向连着来多少次都只算一段。 */
function countReversals(samples: readonly DirectionSample[]): number {
  let count = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1];
    const after = samples[index];
    if (before === undefined || after === undefined) {
      continue;
    }
    if (before.dirX !== after.dirX || before.dirY !== after.dirY) {
      count += 1;
    }
  }
  return count;
}
