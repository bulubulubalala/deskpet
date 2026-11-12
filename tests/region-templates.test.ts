/**
 * 文件职责：单测 app/renderer/region-templates.ts —— 标准部位模板（T2.44）。
 *
 * 为什么值得单测：模板是「一键铺 13 个部位」的唯一数据源，补哪些 / 保留哪些全靠
 * buildTemplateRegions 的 id 去重；位置写错会直接落到用户的 hits.json 里，所以坐标
 * 必须都在 0–1 且不退化。
 */
import { describe, expect, it } from "vitest";

import type { PackRegionDraft } from "../app/shared/contracts/ipc";
import {
  STANDARD_REGION_TEMPLATES,
  buildTemplateRegions,
  findTemplateByName,
  templateDraft,
} from "../app/renderer/region-templates";

const COLORS = ["#ffb347", "#ff6b6b"];

function draft(partial: Partial<PackRegionDraft> = {}): PackRegionDraft {
  return { id: "", name: "手", rect: [0.1, 0.1, 0.1, 0.1], color: "#ffb347", act: "", ...partial };
}

describe("STANDARD_REGION_TEMPLATES", () => {
  it("每个模板的框都在 0–1 内、宽高不小于 2%，id 不重复", () => {
    const ids = new Set<string>();
    for (const template of STANDARD_REGION_TEMPLATES) {
      const [x, y, w, h] = template.rect;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(w).toBeGreaterThanOrEqual(0.02);
      expect(h).toBeGreaterThanOrEqual(0.02);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      expect(template.name.trim()).not.toBe("");
      expect(template.priority).toBeGreaterThanOrEqual(0);
      expect(template.padding).toBeGreaterThan(0);
    }
  });

  it("脸比头更具体（优先级更高），躯干最低", () => {
    const face = STANDARD_REGION_TEMPLATES.find((item) => item.id === "face");
    const head = STANDARD_REGION_TEMPLATES.find((item) => item.id === "head");
    const chest = STANDARD_REGION_TEMPLATES.find((item) => item.id === "chest");
    expect((face?.priority ?? 0) > (head?.priority ?? 0)).toBe(true);
    expect((head?.priority ?? 0) > (chest?.priority ?? 0)).toBe(true);
  });
});

describe("templateDraft / findTemplateByName", () => {
  it("草稿沿用模板 id 与位置，颜色由调用方给", () => {
    const face = STANDARD_REGION_TEMPLATES[1];
    if (face === undefined) {
      throw new Error("缺少 face 模板");
    }
    const built = templateDraft(face, "#123456");
    expect(built.id).toBe(face.id);
    expect(built.name).toBe(face.name);
    expect(built.rect).toEqual(face.rect);
    expect(built.color).toBe("#123456");
    expect(built.priority).toBe(face.priority);
    expect(built.padding).toBe(face.padding);
  });

  it("按名字找得到，找不到回 null（前后空格忽略）", () => {
    expect(findTemplateByName(" 脸 ")?.id).toBe("face");
    expect(findTemplateByName("不存在")).toBeNull();
  });
});

describe("buildTemplateRegions", () => {
  it("空列表时铺满全部模板，并按颜色表轮换", () => {
    const added = buildTemplateRegions([], COLORS);
    expect(added.map((item) => item.id)).toEqual(STANDARD_REGION_TEMPLATES.map((item) => item.id));
    expect(added[0]?.color).toBe("#ffb347");
    expect(added[1]?.color).toBe("#ff6b6b");
    expect(added[2]?.color).toBe("#ffb347");
  });

  it("已有的 id 不补，也不覆盖已有框（大小写不敏感）", () => {
    const existing = [draft({ id: "FACE", name: "我的脸", rect: [0.1, 0.1, 0.2, 0.2] })];
    const added = buildTemplateRegions(existing, COLORS);
    expect(added.some((item) => item.id === "face")).toBe(false);
    expect(added).toHaveLength(STANDARD_REGION_TEMPLATES.length - 1);
    expect(existing[0]?.rect).toEqual([0.1, 0.1, 0.2, 0.2]);
  });

  it("全是空 id 的手画框不挡模板（草稿 id 还没生成时也能铺）", () => {
    const added = buildTemplateRegions([draft(), draft()], COLORS);
    expect(added).toHaveLength(STANDARD_REGION_TEMPLATES.length);
  });

  it("颜色表为空时退回默认暖色，不产生 undefined", () => {
    const added = buildTemplateRegions([], []);
    expect(added.every((item) => item.color === "#ffb347")).toBe(true);
  });
});
