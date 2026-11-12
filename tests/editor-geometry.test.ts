import { describe, expect, it } from "vitest";
import type { PackRegionDraft } from "../app/shared/contracts/ipc";
import {
  HANDLE_PX,
  clamp,
  cloneRegions,
  containsPoint,
  cornerAt,
  normalizeRect,
  regionCornerAt,
  regionRect,
  reshape,
  resizeRect,
  resizeRegionRect,
  round4,
  toHitShape,
  type Rect,
} from "../app/renderer/editor/geometry";

/** 假画布：这几条只用到 width / height，不需要真的 DOM。 */
function fakeCanvas(width: number, height: number): HTMLCanvasElement {
  return { width, height } as HTMLCanvasElement;
}

describe("clamp / round4", () => {
  it("夹到上下界，界内原样返回", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(13, 0, 10)).toBe(10);
    expect(clamp(4, 0, 10)).toBe(4);
  });

  it("保留四位小数（hits.json 里不留浮点尾巴）", () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(1 / 3)).toBe(0.3333);
  });
});

describe("normalizeRect", () => {
  it("反向拖拽也会得到正的宽高", () => {
    expect(normalizeRect({ x: 30, y: 40 }, { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      w: 20,
      h: 30,
    });
  });
});

describe("containsPoint", () => {
  const rect: Rect = { x: 10, y: 10, w: 20, h: 20 };

  it("四边算命中（贴着边也算点中）", () => {
    expect(containsPoint(rect, { x: 10, y: 10 })).toBe(true);
    expect(containsPoint(rect, { x: 30, y: 30 })).toBe(true);
  });

  it("外面不算", () => {
    expect(containsPoint(rect, { x: 9, y: 20 })).toBe(false);
    expect(containsPoint(rect, { x: 20, y: 31 })).toBe(false);
  });
});

describe("cornerAt", () => {
  const rect: Rect = { x: 100, y: 100, w: 200, h: 100 };

  it("四角按 14px 容差判定", () => {
    expect(cornerAt(rect, { x: 104, y: 104 }, HANDLE_PX)).toBe("nw");
    expect(cornerAt(rect, { x: 296, y: 106 }, HANDLE_PX)).toBe("ne");
    expect(cornerAt(rect, { x: 103, y: 196 }, HANDLE_PX)).toBe("sw");
    expect(cornerAt(rect, { x: 300, y: 200 }, HANDLE_PX)).toBe("se");
  });

  it("框中间不是角，点不到四角", () => {
    expect(cornerAt(rect, { x: 200, y: 150 }, HANDLE_PX)).toBe("");
    expect(cornerAt(rect, { x: 115, y: 115 }, HANDLE_PX)).toBe("");
  });
});

describe("resizeRect", () => {
  const rect: Rect = { x: 10, y: 10, w: 100, h: 50 };

  it("拖右下角只动宽高", () => {
    expect(resizeRect(rect, "se", { x: 150, y: 80 })).toEqual({ x: 10, y: 10, w: 140, h: 70 });
  });

  it("拖过对边也能翻转成正的矩形（不会出现负宽高）", () => {
    expect(resizeRect(rect, "nw", { x: 60, y: 40 })).toEqual({ x: 60, y: 40, w: 50, h: 20 });
  });
});

describe("regionRect", () => {
  it("元组转 Rect", () => {
    expect(
      regionRect({ id: "a", name: "头", rect: [0.1, 0.2, 0.3, 0.4], color: "#000", act: "" }),
    ).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });
});

describe("cloneRegions", () => {
  it("rect 元组是新建数组，改副本不会带着快照一起变", () => {
    const source: PackRegionDraft[] = [
      { id: "a", name: "头", rect: [0, 0, 1, 1], color: "#000", act: "" },
    ];
    const copy = cloneRegions(source);
    copy[0]!.rect = [0.5, 0.5, 0.5, 0.5];
    expect(source[0]!.rect).toEqual([0, 0, 1, 1]);
  });
});

describe("reshape", () => {
  it("多边形跟着外接框按比例缩放", () => {
    const shape = {
      kind: "poly" as const,
      points: [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ] as (readonly [number, number])[],
    };
    const next = reshape(shape, { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(next).toEqual({
      kind: "poly",
      points: [
        [0, 0],
        [0.5, 0],
        [0.25, 0.5],
      ],
    });
  });

  it("矩形与椭圆直接换成新外接框", () => {
    expect(
      reshape(
        { kind: "rect", x: 0, y: 0, w: 1, h: 1 },
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      ),
    ).toEqual({ kind: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(
      reshape(
        { kind: "ellipse", x: 0, y: 0, w: 1, h: 1 },
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      ),
    ).toEqual({ kind: "ellipse", x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });
});

describe("toHitShape", () => {
  it("多边形落 points，矩形/椭圆落 rect 元组", () => {
    expect(toHitShape({ kind: "poly", points: [[0, 0]] })).toEqual({
      kind: "poly",
      points: [[0, 0]],
    });
    expect(toHitShape({ kind: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({
      kind: "rect",
      rect: [0.1, 0.2, 0.3, 0.4],
    });
    expect(toHitShape({ kind: "ellipse", x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({
      kind: "ellipse",
      rect: [0.1, 0.2, 0.3, 0.4],
    });
  });
});

describe("regionCornerAt / resizeRegionRect", () => {
  const rect: Rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

  it("归一化坐标先换回像素再判角（宽高不一致也不会把容差拉歪）", () => {
    const canvas = fakeCanvas(1000, 500);
    expect(regionCornerAt(canvas, rect, { x: 0.1, y: 0.2 })).toBe("nw");
    expect(regionCornerAt(canvas, rect, { x: 0.4, y: 0.6 })).toBe("se");
    expect(regionCornerAt(canvas, rect, { x: 0.25, y: 0.4 })).toBe("");
  });

  it("按角缩放后仍是 0–1 归一化坐标", () => {
    const canvas = fakeCanvas(100, 100);
    const next = resizeRegionRect(canvas, { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, "se", {
      x: 0.6,
      y: 0.6,
    });
    expect(next.x).toBeCloseTo(0.2);
    expect(next.y).toBeCloseTo(0.2);
    expect(next.w).toBeCloseTo(0.4);
    expect(next.h).toBeCloseTo(0.4);
  });
});
