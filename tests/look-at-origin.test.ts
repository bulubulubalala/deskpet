/**
 * 文件职责：视觉原点解析与建议值的单测（T2.28）。
 *
 * 优先级是产品规则：faceRig > 脸部位框 > 头部位框 > 默认；老 hits.json 没有原点时必须能安全回退。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOOK_AT_ORIGIN,
  faceRigOriginOf,
  normalizeLookAtOrigin,
  suggestLookAtOrigin,
} from "../app/main/look-at-origin";

const HEAD = { id: "head", name: "头", rect: [0.3, 0.02, 0.4, 0.2] as const };
const FACE = { id: "face", name: "脸", rect: [0.35, 0.2, 0.3, 0.2] as const };
const HAND = { id: "hand", name: "手", rect: [0.7, 0.5, 0.1, 0.1] as const };

describe("normalizeLookAtOrigin", () => {
  it("保留合法二元组并夹到 0–1", () => {
    expect(normalizeLookAtOrigin([0.2, 0.4])).toEqual([0.2, 0.4]);
    expect(normalizeLookAtOrigin([-1, 2])).toEqual([0, 1]);
  });

  it("缺字段 / 坏形状 / 非有限数都返回 null", () => {
    expect(normalizeLookAtOrigin(undefined)).toBeNull();
    expect(normalizeLookAtOrigin([0.2])).toBeNull();
    expect(normalizeLookAtOrigin(["0.2", 0.4])).toBeNull();
    expect(normalizeLookAtOrigin([Number.NaN, 0.4])).toBeNull();
  });
});

describe("faceRigOriginOf", () => {
  it("把 faceRig 像素中心归一化", () => {
    expect(
      faceRigOriginOf({
        canvas: { width: 800, height: 1000 },
        faceRig: { centerX: 400, centerY: 300 },
      }),
    ).toEqual({ x: 0.5, y: 0.3 });
  });

  it("缺 canvas / faceRig 时返回 null", () => {
    expect(faceRigOriginOf(null)).toBeNull();
    expect(faceRigOriginOf({ canvas: { width: 800, height: 1000 } })).toBeNull();
    expect(
      faceRigOriginOf({ canvas: { width: 0, height: 1000 }, faceRig: { centerX: 1, centerY: 1 } }),
    ).toBeNull();
  });
});

describe("suggestLookAtOrigin", () => {
  it("faceRig 优先于部位框", () => {
    expect(suggestLookAtOrigin([HEAD, FACE], { x: 0.51, y: 0.33 })).toEqual([0.51, 0.33]);
  });

  it("没有 faceRig 时优先脸部位框，其次头部位框", () => {
    expect(suggestLookAtOrigin([HEAD, FACE, HAND], null)).toEqual([0.5, 0.3]);
    expect(suggestLookAtOrigin([HEAD, HAND], null)).toEqual([0.5, 0.12]);
  });

  it("什么都没有时用默认值", () => {
    expect(suggestLookAtOrigin([], null)).toEqual([
      DEFAULT_LOOK_AT_ORIGIN[0],
      DEFAULT_LOOK_AT_ORIGIN[1],
    ]);
  });
});
