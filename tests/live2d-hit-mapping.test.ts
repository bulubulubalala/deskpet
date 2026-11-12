/**
 * 文件职责：动态命中框的夹取规则（T2.42）——「网格框能比作者框大多少」。
 *
 * 为什么要测：网格外接框会跟姿势虚胖（袖子/胯），夹得太松会抢隔壁部位、太紧手一动就脱靶。
 * 这条规则以前埋在 700 行的舞台类里，改一个数字没法验证。
 * 依赖方向：tests -> app/renderer/stage-live2d/hit-mapping.ts。
 */
import { describe, expect, it } from "vitest";

import type { CharHitRegion } from "../app/shared/contracts/ipc";
import { clampToAuthored, DYNAMIC_SHAPE_SLACK } from "../app/renderer/stage-live2d/hit-mapping";

const REGION: CharHitRegion = {
  id: "face",
  name: "脸",
  rect: [0.4, 0.1, 0.2, 0.2],
  color: "#ffb347",
  act: "",
};

describe("clampToAuthored", () => {
  it("网格框在作者框内时原样返回", () => {
    const shape = clampToAuthored(REGION, { x: 0.45, y: 0.15, w: 0.05, h: 0.05 });
    expect(shape).not.toBeNull();
    expect(shape!.kind).toBe("rect");
    expect(shape!.kind === "rect" && shape!.x).toBeCloseTo(0.45, 6);
    expect(shape!.kind === "rect" && shape!.y).toBeCloseTo(0.15, 6);
    expect(shape!.kind === "rect" && shape!.w).toBeCloseTo(0.05, 6);
    expect(shape!.kind === "rect" && shape!.h).toBeCloseTo(0.05, 6);
  });

  it("网格框虚胖时被夹到「作者框外扩 slack 倍」以内", () => {
    const shape = clampToAuthored(REGION, { x: -1, y: -1, w: 4, h: 4 });
    const slack = (0.2 * (DYNAMIC_SHAPE_SLACK - 1)) / 2;
    expect(shape).not.toBeNull();
    expect(shape!.kind === "rect" && shape!.x).toBeCloseTo(0.4 - slack, 6);
    expect(shape!.kind === "rect" && shape!.y).toBeCloseTo(0.1 - slack, 6);
    expect(shape!.kind === "rect" && shape!.w).toBeCloseTo(0.2 + slack * 2, 6);
    expect(shape!.kind === "rect" && shape!.h).toBeCloseTo(0.2 + slack * 2, 6);
  });

  it("与作者框完全不相交时退回静态形状（返回 null）", () => {
    expect(clampToAuthored(REGION, { x: 10, y: 10, w: 0.1, h: 0.1 })).toBeNull();
  });
});
