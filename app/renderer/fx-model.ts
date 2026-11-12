/**
 * 文件职责：触摸反馈的纯时间 / 几何模型（涟漪、抚摸轨迹），不碰 DOM，方便单测。
 *
 * 为什么把「多大、多亮、还在不在」抽出来：canvas 里的绘制永远是错的，能对的是数；
 * 把数算在纯函数里，真机觉得太快太亮时只改常量，不用碰绘制代码。
 * 谁调用：app/renderer/stage-fx.ts（每帧问它要参数），tests/fx-model.test.ts。
 */

/** 一圈涟漪的寿命、两环之间的错开时间、半径与透明度（T2.41 触摸反馈）。 */
export const RIPPLE_DURATION_MS = 300;
export const RIPPLE_STAGGER_MS = 80;
export const RIPPLE_START_RADIUS_PX = 6;
export const RIPPLE_END_RADIUS_PX = 22;
export const RIPPLE_ALPHA = 0.35;
export const RIPPLE_WIDTH_PX = 1.5;

/** 轨迹点的存活时间、环形缓冲上限、粗细与透明度（只给 stroke / knead 用）。 */
export const TRAIL_LIFE_MS = 400;
export const TRAIL_MAX_POINTS = 48;
export const TRAIL_WIDTH_PX = 1.6;
export const TRAIL_TAIL_WIDTH_PX = 0.4;
export const TRAIL_ALPHA = 0.55;

/** 部位没配颜色时的暖白，跟角色台词气泡的纸色是一套。 */
export const DEFAULT_FX_COLOR = "#f2c9a6";

export interface FxPoint {
  readonly x: number;
  readonly y: number;
  /** 采样时刻（performance.now()）。 */
  readonly t: number;
}

export interface Ripple {
  readonly x: number;
  readonly y: number;
  readonly bornAt: number;
  readonly color: string;
  /** 第二环晚一点出生：两环错开才是「荡开」，同时出现只是一个环。 */
  readonly delayMs: number;
}

export interface RippleFrame {
  readonly radius: number;
  readonly alpha: number;
}

export interface TrailSegment {
  readonly from: FxPoint;
  readonly to: FxPoint;
  readonly alpha: number;
  readonly width: number;
}

/** 一次点击的两环涟漪（同一点、错开 RIPPLE_STAGGER_MS）。 */
export function makeRipples(
  x: number,
  y: number,
  bornAt: number,
  color = DEFAULT_FX_COLOR,
): Ripple[] {
  return [
    { x, y, bornAt, color, delayMs: 0 },
    { x, y, bornAt, color, delayMs: RIPPLE_STAGGER_MS },
  ];
}

/**
 * 这一刻这一环该画多大、多亮；还没出生或已经消失返回 null。
 *
 * 半径用 ease-out（先快后慢，像水波），透明度的衰减比半径快（(1-t)^2），
 * 不然环扩到最大时还剩一圈灰边，看着脏。
 */
export function rippleAt(ripple: Ripple, now: number): RippleFrame | null {
  const elapsed = now - ripple.bornAt - ripple.delayMs;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= RIPPLE_DURATION_MS) {
    return null;
  }
  const t = elapsed / RIPPLE_DURATION_MS;
  const eased = 1 - (1 - t) * (1 - t);
  return {
    radius: RIPPLE_START_RADIUS_PX + (RIPPLE_END_RADIUS_PX - RIPPLE_START_RADIUS_PX) * eased,
    alpha: RIPPLE_ALPHA * (1 - t) * (1 - t),
  };
}

/** 所有环都过寿命（画完这一帧就可以停 rAF）。 */
export function ripplesDone(ripples: readonly Ripple[], now: number): boolean {
  return ripples.every((ripple) => now - ripple.bornAt >= RIPPLE_DURATION_MS + ripple.delayMs);
}

/** 追加一个轨迹点；超过上限从头丢（环形缓冲，永远只画最近一段）。 */
export function pushTrailPoint(points: readonly FxPoint[], point: FxPoint): FxPoint[] {
  const next =
    points.length >= TRAIL_MAX_POINTS
      ? points.slice(points.length - TRAIL_MAX_POINTS + 1)
      : points.slice();
  next.push(point);
  return next;
}

/** 丢掉过寿命的点；返回值只用于绘制，不改原数组。 */
export function pruneTrail(
  points: readonly FxPoint[],
  now: number,
  lifeMs = TRAIL_LIFE_MS,
): FxPoint[] {
  return points.filter((point) => now - point.t < lifeMs);
}

/**
 * 轨迹 → 可画的线段：新的段粗且亮，旧的细且淡（尾部先消失，看着像被抹掉）。
 *
 * 为什么按段算而不是整体给一个透明度：整条线一起淡会像「整条在闪」，
 * 逐段按年龄衰减才有「光带跟着手指、尾巴化开」的感觉。
 */
export function trailSegments(
  points: readonly FxPoint[],
  now: number,
  lifeMs = TRAIL_LIFE_MS,
): TrailSegment[] {
  const segments: TrailSegment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (from === undefined || to === undefined) {
      continue;
    }
    const age = now - to.t;
    if (!Number.isFinite(age) || age < 0 || age >= lifeMs) {
      continue;
    }
    const k = 1 - age / lifeMs;
    segments.push({
      from,
      to,
      alpha: TRAIL_ALPHA * k * k,
      width: TRAIL_TAIL_WIDTH_PX + (TRAIL_WIDTH_PX - TRAIL_TAIL_WIDTH_PX) * k,
    });
  }
  return segments;
}

/** 部位色只在是干净的 #rgb / #rrggbb / rgb(a) 时采用，脏值一律回退默认色。 */
export function normalizeFxColor(color: string | null | undefined): string {
  if (typeof color !== "string") {
    return DEFAULT_FX_COLOR;
  }
  const trimmed = color.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed) || /^rgba?\(/i.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_FX_COLOR;
}
