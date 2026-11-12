/**
 * 文件职责：触摸反馈（涟漪 / 轨迹）的纯时间模型单测（T2.41）。
 *
 * 关键回归：两环必须错开；半径随时间变大、透明度单调变小；轨迹上限 48 点、尾部先消失；
 * 脏颜色不能让 canvas 抛错，必须静默回退默认色。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FX_COLOR,
  RIPPLE_DURATION_MS,
  RIPPLE_STAGGER_MS,
  RIPPLE_START_RADIUS_PX,
  RIPPLE_END_RADIUS_PX,
  RIPPLE_ALPHA,
  TRAIL_LIFE_MS,
  TRAIL_MAX_POINTS,
  makeRipples,
  normalizeFxColor,
  pruneTrail,
  pushTrailPoint,
  rippleAt,
  ripplesDone,
  trailSegments,
  type FxPoint,
} from "../app/renderer/fx-model";

function points(count: number, stepMs = 10): FxPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    x: index,
    y: index,
    t: index * stepMs,
  }));
}

describe("涟漪", () => {
  it("一次点击给出两环，第二环错开出生", () => {
    const ripples = makeRipples(10, 20, 1000);
    expect(ripples).toHaveLength(2);
    expect(ripples[0]?.delayMs).toBe(0);
    expect(ripples[1]?.delayMs).toBe(RIPPLE_STAGGER_MS);
    expect(ripples.every((ripple) => ripple.x === 10 && ripple.y === 20)).toBe(true);
  });

  it("出生前与寿命后都不返回帧", () => {
    const [ring] = makeRipples(0, 0, 1000);
    expect(ring).toBeDefined();
    if (ring === undefined) return;
    expect(rippleAt(ring, 999)).toBeNull();
    expect(rippleAt(ring, 1000 + RIPPLE_DURATION_MS)).toBeNull();
    expect(rippleAt(ring, 1000 + RIPPLE_DURATION_MS + 1)).toBeNull();
  });

  it("半径从起点扩到终点，透明度单调下降", () => {
    const [ring] = makeRipples(0, 0, 0);
    if (ring === undefined) throw new Error("缺少涟漪");
    const start = rippleAt(ring, 0);
    const mid = rippleAt(ring, RIPPLE_DURATION_MS / 2);
    const end = rippleAt(ring, RIPPLE_DURATION_MS - 1);
    expect(start?.radius).toBeCloseTo(RIPPLE_START_RADIUS_PX, 5);
    expect(start?.alpha).toBeCloseTo(RIPPLE_ALPHA, 5);
    expect(mid?.radius).toBeGreaterThan(start?.radius ?? 0);
    expect(end?.radius).toBeLessThanOrEqual(RIPPLE_END_RADIUS_PX);
    expect(mid?.alpha).toBeLessThan(start?.alpha ?? 0);
    expect(end?.alpha).toBeLessThan(mid?.alpha ?? 0);
  });

  it("两环都过寿命才算画完", () => {
    const ripples = makeRipples(0, 0, 0);
    expect(ripplesDone(ripples, RIPPLE_DURATION_MS)).toBe(false);
    expect(ripplesDone(ripples, RIPPLE_DURATION_MS + RIPPLE_STAGGER_MS + 1)).toBe(true);
  });
});

describe("轨迹", () => {
  it("超过上限时丢掉最老的，保留最新 48 点", () => {
    let trail: FxPoint[] = [];
    for (let i = 0; i < TRAIL_MAX_POINTS + 5; i += 1) {
      trail = pushTrailPoint(trail, { x: i, y: i, t: i });
    }
    expect(trail).toHaveLength(TRAIL_MAX_POINTS);
    expect(trail[0]?.x).toBe(5);
    expect(trail.at(-1)?.x).toBe(TRAIL_MAX_POINTS + 4);
  });

  it("按寿命裁掉老点", () => {
    const trail = points(10, 100);
    // 最后一个点 t=900，now 到 1300 时它也已过期 → 全部裁掉
    expect(pruneTrail(trail, 900 + TRAIL_LIFE_MS)).toHaveLength(0);
    // now=450：只留 age<400 的点，即 t=100..900 这 9 个
    const kept = pruneTrail(trail, 450);
    expect(kept).toHaveLength(9);
    expect(kept[0]?.t).toBe(100);
  });

  it("越新的段越粗越亮，相邻两点一段", () => {
    const trail = points(4, 100);
    const segments = trailSegments(trail, 350);
    expect(segments).toHaveLength(3);
    const newest = segments.at(-1);
    const oldest = segments[0];
    expect(newest?.alpha ?? 0).toBeGreaterThan(oldest?.alpha ?? 0);
    expect(newest?.width ?? 0).toBeGreaterThan(oldest?.width ?? 0);
  });

  it("过寿命的段不画", () => {
    expect(trailSegments(points(3, 100), TRAIL_LIFE_MS + 301)).toHaveLength(0);
  });
});

describe("normalizeFxColor", () => {
  it("接受干净的十六进制与 rgb()", () => {
    expect(normalizeFxColor("#abc")).toBe("#abc");
    expect(normalizeFxColor(" #AABBCC ")).toBe("#AABBCC");
    expect(normalizeFxColor("rgba(1,2,3,0.4)")).toBe("rgba(1,2,3,0.4)");
  });

  it("空值 / 脏值回退默认色（不让 canvas 抛错）", () => {
    expect(normalizeFxColor(null)).toBe(DEFAULT_FX_COLOR);
    expect(normalizeFxColor(undefined)).toBe(DEFAULT_FX_COLOR);
    expect(normalizeFxColor("")).toBe(DEFAULT_FX_COLOR);
    expect(normalizeFxColor("url(javascript:1)")).toBe(DEFAULT_FX_COLOR);
    expect(normalizeFxColor("red")).toBe(DEFAULT_FX_COLOR);
  });
});
