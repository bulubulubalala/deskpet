/**
 * 文件职责：触摸判定几何与归属的单测（T2.42 重制）。
 *
 * 覆盖四件事：形状包含（矩形/椭圆/多边形 + 容差）、归属判据（优先级 / 面积 / 距离）、
 * 交界迟滞、以及「一串触摸里谁摸得最久」的排序。
 */
import { describe, expect, it } from "vitest";

import type { CharHitRegion } from "../app/shared/contracts/ipc";
import {
  HitDwell,
  HIT_HYSTERESIS,
  HIT_PADDING_MAX,
  resolveHit,
  shapeArea,
  shapeBounds,
  shapeContains,
  shapeContainsPadded,
  shapeOf,
  type Shape,
} from "../app/renderer/hit";
import { orderByDwell } from "../app/renderer/touch";

function region(
  id: string,
  rect: readonly [number, number, number, number],
  extra: Partial<CharHitRegion> = {},
): CharHitRegion {
  return {
    id,
    name: id,
    rect,
    color: "#ffb347",
    act: "",
    ...extra,
  };
}

describe("shapeContains", () => {
  const rect: Shape = { kind: "rect", x: 0.2, y: 0.2, w: 0.2, h: 0.1 };
  const ellipse: Shape = { kind: "ellipse", x: 0.2, y: 0.2, w: 0.2, h: 0.1 };
  const poly: Shape = {
    kind: "poly",
    points: [
      [0.2, 0.2],
      [0.4, 0.2],
      [0.3, 0.4],
    ],
  };

  it("矩形：内部算中、外部不算、边界算中", () => {
    expect(shapeContains(rect, 0.3, 0.25)).toBe(true);
    expect(shapeContains(rect, 0.19, 0.25)).toBe(false);
    expect(shapeContains(rect, 0.2, 0.3)).toBe(true);
  });

  it("椭圆：角上那一点不算中（矩形会算）", () => {
    expect(shapeContains(ellipse, 0.3, 0.25)).toBe(true);
    expect(shapeContains(ellipse, 0.205, 0.205)).toBe(false);
    expect(shapeContains(rect, 0.205, 0.205)).toBe(true);
  });

  it("多边形：三角形内部算中、缺口不算", () => {
    expect(shapeContains(poly, 0.3, 0.25)).toBe(true);
    expect(shapeContains(poly, 0.21, 0.38)).toBe(false);
  });

  it("坏坐标不算中", () => {
    expect(shapeContains(rect, Number.NaN, 0.25)).toBe(false);
  });
});

describe("shapeContainsPadded", () => {
  it("容差把擦边算进来，且不会无限放大", () => {
    const shape: Shape = { kind: "rect", x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    expect(shapeContainsPadded(shape, 0.39, 0.5, 0)).toBe(false);
    expect(shapeContainsPadded(shape, 0.39, 0.5, 0.02)).toBe(true);
    expect(shapeContainsPadded(shape, 0.0, 0.5, 10)).toBe(false);
    expect(HIT_PADDING_MAX).toBeLessThan(0.3);
  });

  it("多边形按到边距离给容差", () => {
    const shape: Shape = {
      kind: "poly",
      points: [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.5, 0.6],
      ],
    };
    expect(shapeContainsPadded(shape, 0.5, 0.35, 0)).toBe(false);
    expect(shapeContainsPadded(shape, 0.5, 0.38, 0.03)).toBe(true);
  });
});

describe("shapeArea / shapeBounds", () => {
  it("椭圆面积是外接矩形的 π/4", () => {
    const rect = shapeArea({ kind: "rect", x: 0, y: 0, w: 0.2, h: 0.2 });
    const ellipse = shapeArea({ kind: "ellipse", x: 0, y: 0, w: 0.2, h: 0.2 });
    expect(rect).toBeCloseTo(0.04, 6);
    expect(ellipse / rect).toBeCloseTo(Math.PI / 4, 6);
  });

  it("多边形按鞋带公式算面积、按顶点算外接框", () => {
    const poly: Shape = {
      kind: "poly",
      points: [
        [0.1, 0.1],
        [0.3, 0.1],
        [0.3, 0.3],
      ],
    };
    expect(shapeArea(poly)).toBeCloseTo(0.02, 6);
    const bounds = shapeBounds(poly);
    expect(bounds.x).toBeCloseTo(0.1, 9);
    expect(bounds.y).toBeCloseTo(0.1, 9);
    expect(bounds.w).toBeCloseTo(0.2, 9);
    expect(bounds.h).toBeCloseTo(0.2, 9);
  });
});

describe("shapeOf", () => {
  it("没写 shape 时用 rect", () => {
    expect(shapeOf(region("a", [0.1, 0.2, 0.3, 0.4]))).toEqual({
      kind: "rect",
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.4,
    });
  });

  it("写了就按写的算（poly 顶点不足则退回 rect）", () => {
    expect(
      shapeOf(
        region("a", [0, 0, 1, 1], { shape: { kind: "ellipse", rect: [0.1, 0.1, 0.2, 0.2] } }),
      ),
    ).toEqual({ kind: "ellipse", x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(
      shapeOf(
        region("a", [0, 0, 1, 1], {
          shape: {
            kind: "poly",
            points: [
              [0, 0],
              [1, 1],
            ],
          },
        }),
      ),
    ).toEqual({ kind: "rect", x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("resolveHit 归属", () => {
  const big = region("body", [0.2, 0.2, 0.6, 0.6]);
  const small = region("face", [0.4, 0.3, 0.2, 0.1]);

  it("重叠时面积小的赢", () => {
    expect(resolveHit([big, small], 0.5, 0.35)?.id).toBe("face");
  });

  it("priority 大的赢，哪怕面积更大", () => {
    const priorityBig = region("hand", [0.2, 0.2, 0.6, 0.6], { priority: 5 });
    expect(resolveHit([big, priorityBig], 0.5, 0.35)?.id).toBe("hand");
  });

  it("都不在框里返回 null；擦边靠 padding 救回来", () => {
    expect(resolveHit([small], 0.95, 0.95)).toBeNull();
    const padded = region("face", [0.4, 0.3, 0.2, 0.1], { padding: 0.02 });
    expect(resolveHit([padded], 0.61, 0.35)?.id).toBe("face");
  });

  it("迟滞：交界处新框没明显更小就留在原来的部位", () => {
    const left = region("left", [0.2, 0.2, 0.3, 0.3]);
    const right = region("right", [0.24, 0.2, 0.3, 0.3]);
    // 单看面积 right 略大，但都在同一个点上；上一帧在 left 就保持 left
    expect(resolveHit([left, right], 0.45, 0.35)?.id).toBe("right");
    expect(resolveHit([left, right], 0.45, 0.35, { previousId: "left" })?.id).toBe("left");
  });

  it("迟滞不阻止换成明显更小的部位", () => {
    const bigRegion = region("big", [0.2, 0.2, 0.5, 0.5]);
    const smallRegion = region("small", [0.4, 0.3, 0.1, 0.1]);
    expect(HIT_HYSTERESIS).toBeGreaterThan(0);
    expect(resolveHit([bigRegion, smallRegion], 0.45, 0.35, { previousId: "big" })?.id).toBe(
      "small",
    );
  });

  it("动态形状优先于静态形状（Live2D 网格跟着动作走）", () => {
    const face = region("face", [0.4, 0.3, 0.2, 0.1]);
    const moved = new Map<string, Shape>([
      ["face", { kind: "rect", x: 0.0, y: 0.0, w: 0.1, h: 0.1 }],
    ]);
    expect(resolveHit([face], 0.5, 0.35)?.id).toBe("face");
    expect(resolveHit([face], 0.5, 0.35, { dynamic: moved })).toBeNull();
    expect(resolveHit([face], 0.05, 0.05, { dynamic: moved })?.id).toBe("face");
  });
});

describe("HitDwell", () => {
  it("按停留时长排序，离开时把时间算给上一个部位", () => {
    const dwell = new HitDwell();
    dwell.sample("arm", 0);
    dwell.sample("waist", 100); // arm 停 100ms
    dwell.sample("hips", 700); // waist 停 600ms
    dwell.sample(null, 750); // hips 停 50ms
    expect(dwell.rank()).toEqual(["waist", "arm", "hips"]);
    expect(dwell.milliseconds("waist")).toBe(600);
  });

  it("reset 之后清空", () => {
    const dwell = new HitDwell();
    dwell.sample("a", 0);
    dwell.sample("b", 50);
    dwell.reset();
    expect(dwell.rank()).toEqual([]);
    expect(dwell.hovering).toBeNull();
  });

  it("时间倒流不会算出负时长", () => {
    const dwell = new HitDwell();
    dwell.sample("a", 100);
    dwell.sample("b", 50);
    expect(dwell.milliseconds("a")).toBe(0);
  });
});

describe("orderByDwell", () => {
  it("停得久的排前面，没记录的垫后且去重", () => {
    const dwell = new HitDwell();
    dwell.sample("arm", 0);
    dwell.sample("waist", 40);
    dwell.sample(null, 640);
    const regions = [
      { id: "arm", name: "胳膊" },
      { id: "waist", name: "腰" },
      { id: "hand", name: "手" },
    ];
    expect(orderByDwell(regions, dwell).map((item) => item.id)).toEqual(["waist", "arm", "hand"]);
  });
});
