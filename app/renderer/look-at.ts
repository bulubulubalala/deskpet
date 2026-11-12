/**
 * 文件职责：把「鼠标在模型画布里的归一化位置」换算成 Live2D 的 focus 参数（T2.28）。
 *
 * 为什么不用 `model.focus()`：库实现以整个画布中心为原点，而且总是输出单位向量；
 * 我们需要以用户可调的脸部原点为支点，并按距离比例决定偏转幅度。
 * 依赖方向：renderer 纯逻辑，不碰 DOM / Pixi，方便单测。
 */

export interface LookAtPoint {
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_LOOK_AT_ORIGIN: readonly [number, number] = [0.5, 0.35];
/** 死区（归一化画布距离）：约横向 15 px / 纵向 22 px（420×630 舞台）。 */
export const LOOK_AT_DEAD_ZONE = 0.035;
/** 到达最大偏转所需的归一化距离；窗口边缘约 0.5，所以窗口内不会满幅。 */
export const LOOK_AT_EDGE_RADIUS = 0.6;
/** 最大 focus 幅度（0–1）；0.8 ≈ 24°，避免库默认的 30° 满幅。 */
export const LOOK_AT_MAX_FOCUS = 0.8;
/** 近处轻、远处更快靠近上限的响应曲线。 */
const LOOK_AT_CURVE = 1.25;
/** 视线缓动时间常数；越大越“慢半拍”。 */
export const LOOK_AT_SMOOTH_MS = 180;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * 归一化画布坐标 → focusController 的 x / y（约 -0.8–0.8）。
 *
 * - 原点 / 死区内返回 (0, 0)：鼠标在脸上时看正前方；
 * - 向右 / 向左：x 正 / 负；
 * - 向下：y 负（与 `model.focus` 对屏幕 y 的处理一致）；
 * - 距离越大越偏，但窗口边缘也不会满幅，窗口外才接近 `LOOK_AT_MAX_FOCUS`。
 */
export function smoothFocus(
  current: LookAtPoint,
  target: LookAtPoint,
  deltaMs: number,
  tauMs = LOOK_AT_SMOOTH_MS,
): LookAtPoint {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return { x: current.x, y: current.y };
  }
  const alpha = 1 - Math.exp(-Math.min(deltaMs, 100) / Math.max(1, tauMs));
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
  };
}

export function focusFromLookAt(
  point: LookAtPoint,
  origin: readonly [number, number],
): LookAtPoint {
  const dx = point.x - origin[0];
  const dy = point.y - origin[1];
  const distance = Math.hypot(dx, dy);
  if (distance <= LOOK_AT_DEAD_ZONE) {
    return { x: 0, y: 0 };
  }
  const strength = clamp(
    (distance - LOOK_AT_DEAD_ZONE) / (LOOK_AT_EDGE_RADIUS - LOOK_AT_DEAD_ZONE),
    0,
    1,
  );
  const amount = Math.pow(strength, LOOK_AT_CURVE) * LOOK_AT_MAX_FOCUS;
  const x = (dx / distance) * amount;
  const y = (-dy / distance) * amount;
  // 避免 -0 让测试 / 调试输出看起来像「有微小偏转」
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}
