/**
 * 文件职责：网格顶点 → 归一化外接框的纯数学（T2.42 / T2.44）。
 *
 * 为什么值得单测：这段换算以前在舞台类里抄了两份，出错的表现是「手明明在脸上，命中的是袖子」
 * 或「生成的部位框偏了一半」，在真机上只能靠肉眼猜。这里用一个假的顶点源直接盯住坐标。
 * 依赖方向：tests -> app/renderer/stage-live2d/mesh.ts（不加载 pixi）。
 */
import { describe, expect, it } from "vitest";

import {
  clampUnit,
  meshBoxOf,
  type DrawableGeometrySource,
} from "../app/renderer/stage-live2d/mesh";

const HIT_BOX = [0, 0, 1, 1] as const;

function source(table: Record<string, number[]>, throwing: string[] = []): DrawableGeometrySource {
  return {
    getDrawableVertices(id: number | string): ArrayLike<number> {
      const key = String(id);
      if (throwing.includes(key)) {
        throw new Error("drawable not found");
      }
      const vertices = table[key];
      if (vertices === undefined) {
        throw new Error("drawable not found");
      }
      return vertices;
    },
  };
}

describe("meshBoxOf", () => {
  it("把模型像素折算成 0–1，并按 hit_box 平移缩放", () => {
    const box = meshBoxOf(source({ Face: [100, 200, 300, 200, 300, 400, 100, 400] }), ["Face"], {
      width: 1000,
      height: 1000,
      hitBox: HIT_BOX,
    });
    expect(box).not.toBeNull();
    expect(box!.x).toBeCloseTo(0.1, 6);
    expect(box!.y).toBeCloseTo(0.2, 6);
    expect(box!.w).toBeCloseTo(0.2, 6);
    expect(box!.h).toBeCloseTo(0.2, 6);
  });

  it("hit_box 有偏移时结果跟着平移", () => {
    const box = meshBoxOf(source({ Face: [200, 200, 400, 400] }), ["Face"], {
      width: 1000,
      height: 1000,
      hitBox: [0.1, 0.1, 0.5, 0.5],
    });
    expect(box!.x).toBeCloseTo(0.2, 6);
    expect(box!.y).toBeCloseTo(0.2, 6);
    expect(box!.w).toBeCloseTo(0.4, 6);
    expect(box!.h).toBeCloseTo(0.4, 6);
  });

  it("多个网格取并集，取不到的网格跳过而不是整组失败", () => {
    const box = meshBoxOf(
      source({ A: [0, 0, 100, 100], B: [200, 300, 300, 400] }, ["Missing"]),
      ["A", "Missing", "B"],
      { width: 1000, height: 1000, hitBox: HIT_BOX },
    );
    expect(box!.x).toBeCloseTo(0, 6);
    expect(box!.y).toBeCloseTo(0, 6);
    expect(box!.x + box!.w).toBeCloseTo(0.3, 6);
    expect(box!.y + box!.h).toBeCloseTo(0.4, 6);
  });

  it("没有模型、宽高或框不合法、顶点为空时返回 null", () => {
    const table = source({ A: [0, 0] });
    expect(meshBoxOf(undefined, ["A"], { width: 1000, height: 1000, hitBox: HIT_BOX })).toBeNull();
    expect(meshBoxOf(table, ["A"], { width: 0, height: 1000, hitBox: HIT_BOX })).toBeNull();
    expect(meshBoxOf(table, ["A"], { width: 1000, height: 1000, hitBox: [0, 0, 0, 1] })).toBeNull();
    expect(meshBoxOf(table, ["A"], { width: 1000, height: 0, hitBox: HIT_BOX })).toBeNull();
    expect(
      meshBoxOf(source({ A: [] }), ["A"], { width: 1000, height: 1000, hitBox: HIT_BOX }),
    ).toBeNull();
    expect(
      meshBoxOf(source({ A: [5, 5, 5, 5] }), ["A"], { width: 1000, height: 1000, hitBox: HIT_BOX }),
    ).toBeNull();
  });

  it("不夹取：跑出画布的部分照原样返回，夹多少由调用方决定", () => {
    const box = meshBoxOf(source({ A: [-500, -500, 1500, 1500] }), ["A"], {
      width: 1000,
      height: 1000,
      hitBox: HIT_BOX,
    });
    expect(box!.x).toBeCloseTo(-0.5, 6);
    expect(box!.w).toBeCloseTo(2, 6);
  });
});

describe("clampUnit", () => {
  it("夹到 0–1，NaN 当 0", () => {
    expect(clampUnit(-1)).toBe(0);
    expect(clampUnit(0.5)).toBe(0.5);
    expect(clampUnit(2)).toBe(1);
    expect(clampUnit(Number.NaN)).toBe(0);
    expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
