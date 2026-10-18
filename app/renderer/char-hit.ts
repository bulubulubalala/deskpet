/**
 * 文件职责：立绘部位点击的纯几何与「串」状态（T2.3-C2），不碰 DOM，方便单测。
 *
 * 为什么单独一个文件：命中判定（归一化坐标 → 部位）与连击分档（streak / kind）都是纯逻辑，
 * 真机点不准时先用 vitest 把算法钉死；DOM 只负责把点击坐标递进来（见 index.ts）。
 * 依赖方向：renderer 内部模块；只 import type（不 import main 的实现）。
 */
import type { CharHitRegion } from "../main/ipc";

export type CharHitKind = "single" | "double" | "hold";

/** 两次点击间隔 ≤ 这个值算同一串（方案 §4.3）。 */
export const HIT_STREAK_GAP_MS = 1200;
/** 双击判定。 */
export const HIT_DOUBLE_GAP_MS = 300;
/** 长按判定。 */
export const HIT_HOLD_MS = 600;

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** object-fit: contain 下图片实际画在元素里的矩形（把点击坐标换算成素材归一化坐标）。 */
export function contentBox(
  rect: ElementRect,
  naturalWidth: number,
  naturalHeight: number,
): ElementRect | null {
  if (naturalWidth <= 0 || naturalHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

export function toNormalizedPoint(
  box: ElementRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}

/** 命中哪个部位：按定义顺序取最后一个命中的（后定义的框叠在上面）。 */
export function locateRegion(
  regions: readonly CharHitRegion[],
  x: number,
  y: number,
): CharHitRegion | null {
  let found: CharHitRegion | null = null;
  for (const region of regions) {
    const [rx = 0, ry = 0, rw = 0, rh = 0] = region.rect;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
      found = region;
    }
  }
  return found;
}

export interface HitStreak {
  streak: number;
  gap_ms: number;
  kind: CharHitKind;
}

/** 连击分档：间隔超时归零；双击 / 长按只改 kind（方案 §4.3 第 1 条）。 */
export class HitStreakTracker {
  private lastAt = 0;
  private streak = 0;

  next(now: number, holdMs: number): HitStreak {
    const gap = this.lastAt === 0 ? -1 : now - this.lastAt;
    this.streak = gap >= 0 && gap <= HIT_STREAK_GAP_MS ? this.streak + 1 : 1;
    this.lastAt = now;
    return { streak: this.streak, gap_ms: gap < 0 ? 0 : gap, kind: kindOf(gap, holdMs) };
  }

  reset(): void {
    this.lastAt = 0;
    this.streak = 0;
  }
}

export function kindOf(gapMs: number, holdMs: number): CharHitKind {
  if (holdMs > HIT_HOLD_MS) {
    return "hold";
  }
  if (gapMs >= 0 && gapMs <= HIT_DOUBLE_GAP_MS) {
    return "double";
  }
  return "single";
}

/** 本地兜底台词：LLM 来不及 / 不可用时先用角色包里的 reactions（方案 §4.3 降级）。 */
export function localReaction(region: CharHitRegion, streak: number): string {
  const lines = region.reactions;
  if (lines.length === 0) {
    return "";
  }
  const index = Math.min(lines.length - 1, Math.max(0, streak - 1));
  return lines[index] ?? lines[0] ?? "";
}
