/**
 * 文件职责：示例角色包的 hits.json 体检（T2.9）。
 *
 * 这只守「数据没有写回衣服 / 武器名、id 不重复、坐标在 0–1」这几条硬规则；
 * 框画得准不准仍靠真机探针与肉眼叠图（已归档的内部需求文档 附录 A §8.1AD）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CharHitRegion } from "../app/shared/contracts/ipc";
import { locateRegion } from "../app/renderer/char-hit";

const CHARACTERS = ["xiaoyu"] as const;
const OLD_CLOTHING_IDS = new Set(["skirt", "jacket", "weapon", "shield", "snake", "horn"]);
const OLD_CLOTHING_NAMES = ["裙", "夹克", "枪", "盾", "蛇杖", "角"];

interface HitsFile {
  version?: number;
  look_at_origin?: number[];
  regions?: CharHitRegion[];
}

const LOOK_AT_ORIGIN: Record<(typeof CHARACTERS)[number], readonly [number, number]> = {
  xiaoyu: [0.4967, 0.246],
};

const POINTS: Record<(typeof CHARACTERS)[number], readonly [number, number, string][]> = {
  xiaoyu: [
    [0.5, 0.17, "head"],
    [0.5, 0.06, "ears"],
    [0.5, 0.23, "face"],
    [0.5, 0.4, "chest"],
    [0.5, 0.54, "waist"],
    [0.5, 0.63, "hips"],
    [0.42, 0.82, "thigh_left"],
    [0.58, 0.82, "thigh_right"],
    [0.22, 0.5, "arm_left"],
    [0.78, 0.5, "arm_right"],
    [0.19, 0.74, "hand_left"],
    [0.81, 0.74, "hand_right"],
  ],
};

describe("角色包 body-part hits", () => {
  it.each(CHARACTERS)("%s：12 个身体部位，id 唯一、坐标合法、不写衣服/武器", (charId) => {
    const hits = JSON.parse(
      readFileSync(join("characters", charId, "hits.json"), "utf8"),
    ) as HitsFile;
    expect(hits.version).toBe(2);
    const regions = hits.regions ?? [];
    expect(regions.length).toBe(12);
    const ids = regions.map((region) => region.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const region of regions) {
      expect(region.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(OLD_CLOTHING_IDS.has(region.id)).toBe(false);
      expect(region.name.trim()).not.toBe("");
      for (const word of OLD_CLOTHING_NAMES) {
        expect(region.name).not.toContain(word);
      }
      const [x = 0, y = 0, w = 0, h = 0] = region.rect;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(w).toBeGreaterThanOrEqual(0.02);
      expect(h).toBeGreaterThanOrEqual(0.02);
      expect(x + w).toBeLessThanOrEqual(1.0001);
      expect(y + h).toBeLessThanOrEqual(1.0001);
    }
  });

  it.each(CHARACTERS)("%s：关键身体部位命中正确（含重叠）", (charId) => {
    const hits = JSON.parse(
      readFileSync(join("characters", charId, "hits.json"), "utf8"),
    ) as HitsFile;
    const regions = hits.regions ?? [];
    for (const [x, y, expected] of POINTS[charId]) {
      expect(locateRegion(regions, x, y)?.id, `(${x}, ${y})`).toBe(expected);
    }
  });

  it.each(CHARACTERS)("%s：视觉原点在画布内且接近脸部中心", (charId) => {
    const hits = JSON.parse(
      readFileSync(join("characters", charId, "hits.json"), "utf8"),
    ) as HitsFile;
    const origin = hits.look_at_origin;
    expect(origin).toHaveLength(2);
    const [x = -1, y = -1] = origin ?? [];
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1);
    expect([x, y]).toEqual(LOOK_AT_ORIGIN[charId]);
  });

  it.each(CHARACTERS)("%s：立绘是 1024×1536 的透明 PNG", (charId) => {
    const bytes = readFileSync(join("characters", charId, "assets", "portrait.png"));
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBe(1024);
    expect(bytes.readUInt32BE(20)).toBe(1536);
  });
});
