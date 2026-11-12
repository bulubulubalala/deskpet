/**
 * 文件职责：视线支点 → Live2D focus 的纯映射单测（T2.28 / T2.30）。
 *
 * 关键回归：鼠标在脸上必须看正前方；左右 / 上下方向不能反；窗口边缘不满幅，
 * 离得很远才接近上限，整体比早期“线性 1.35 倍”更迟钝。
 */
import { describe, expect, it } from "vitest";

import { focusFromLookAt, LOOK_AT_MAX_FOCUS, smoothFocus } from "../app/renderer/look-at";

const ORIGIN = [0.5, 0.3] as const;

describe("focusFromLookAt", () => {
  it("鼠标在原点 / 死区内时看正前方", () => {
    expect(focusFromLookAt({ x: 0.5, y: 0.3 }, ORIGIN)).toEqual({ x: 0, y: 0 });
    expect(focusFromLookAt({ x: 0.52, y: 0.31 }, ORIGIN)).toEqual({ x: 0, y: 0 });
  });

  it("向右看为正 x，向下看为负 y（与库的屏幕坐标约定一致）", () => {
    const right = focusFromLookAt({ x: 0.8, y: 0.3 }, ORIGIN);
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBe(0);
    const down = focusFromLookAt({ x: 0.5, y: 0.7 }, ORIGIN);
    expect(down.x).toBe(0);
    expect(down.y).toBeLessThan(0);
  });

  it("窗口边缘不满幅，窗口外才接近上限", () => {
    const edge = focusFromLookAt({ x: 1, y: 0.3 }, ORIGIN);
    expect(edge.x).toBeGreaterThan(0.5);
    expect(edge.x).toBeLessThan(LOOK_AT_MAX_FOCUS);

    const far = focusFromLookAt({ x: 3, y: 0.3 }, ORIGIN);
    expect(far.x).toBeCloseTo(LOOK_AT_MAX_FOCUS, 6);
    expect(focusFromLookAt({ x: -3, y: 0.3 }, ORIGIN).x).toBeCloseTo(-LOOK_AT_MAX_FOCUS, 6);
    expect(focusFromLookAt({ x: 0.5, y: 3 }, ORIGIN).y).toBeCloseTo(-LOOK_AT_MAX_FOCUS, 6);
  });

  it("距离越远偏转越大，且始终不超过上限", () => {
    const near = focusFromLookAt({ x: 0.6, y: 0.3 }, ORIGIN);
    const far = focusFromLookAt({ x: 0.9, y: 0.3 }, ORIGIN);
    expect(far.x).toBeGreaterThan(near.x);
    expect(Math.abs(focusFromLookAt({ x: 9, y: 9 }, ORIGIN).x)).toBeLessThanOrEqual(
      LOOK_AT_MAX_FOCUS,
    );
  });
});

describe("smoothFocus", () => {
  it("帧间隔为 0 / 坏值时保持当前值", () => {
    expect(smoothFocus({ x: 0.2, y: 0.1 }, { x: 1, y: 1 }, 0)).toEqual({ x: 0.2, y: 0.1 });
    expect(smoothFocus({ x: 0.2, y: 0.1 }, { x: 1, y: 1 }, Number.NaN)).toEqual({
      x: 0.2,
      y: 0.1,
    });
  });

  it("朝目标移动但不会越过目标；多帧后收敛", () => {
    let current = { x: 0, y: 0 };
    const target = { x: 1, y: -0.5 };
    for (let i = 0; i < 60; i += 1) {
      current = smoothFocus(current, target, 16.7);
      expect(current.x).toBeLessThanOrEqual(target.x);
      expect(current.y).toBeGreaterThanOrEqual(target.y);
    }
    expect(current.x).toBeGreaterThan(0.99);
    expect(current.y).toBeGreaterThan(-0.51);
  });
});
