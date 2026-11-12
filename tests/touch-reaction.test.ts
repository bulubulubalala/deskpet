/**
 * 文件职责：触摸部位 → 本地即时反应的映射单测（T2.31）。
 *
 * 关键回归：部位关键词只认 hits.json 里的中文名 / 英文 id；表情必须是
 * appearance.expressions 里存在的键；骨骼 id 必须是 Param 开头的标准参数。
 */
import { describe, expect, it } from "vitest";

import type { TouchGesture } from "../app/shared/contracts/ipc";
import {
  BONE_ANGLE_Z,
  BONE_EYE_L,
  classifyZone,
  reactionFor,
} from "../app/renderer/touch-reaction";

/** appearance.expressions 的键（xiaoyu 4 个 exp3 的标签）。 */
const EXPRESSION_KEYS = ["喜", "怒", "哀", "惧", "厌恶", "低落", "惊喜"] as const;
const GESTURES: readonly TouchGesture[] = ["tap", "pat", "stroke", "hold", "knead"];

describe("classifyZone", () => {
  it("按 id 认英文部位", () => {
    expect(classifyZone("head", "")).toBe("head");
    expect(classifyZone("ear_left", "")).toBe("ears");
    expect(classifyZone("eye", "")).toBe("eyes");
    expect(classifyZone("chest", "")).toBe("chest");
  });

  it("按名字认中文部位，先窄后宽", () => {
    expect(classifyZone("r1", "耳朵")).toBe("ears");
    expect(classifyZone("r2", "眼睛")).toBe("eyes");
    expect(classifyZone("r3", "头发")).toBe("head");
    expect(classifyZone("r4", "脸颊")).toBe("face");
  });

  it("认不出来一律 other，不抛错", () => {
    expect(classifyZone("tail", "尾巴")).toBe("other");
    expect(classifyZone(null, null)).toBe("other");
    expect(classifyZone("", "  ")).toBe("other");
  });
});

describe("reactionFor", () => {
  it("每个手势每种部位都给合法的表情 / 动作 / 骨骼", () => {
    const zones = ["head", "face", "ears", "eyes", "chest", "hand", "legs", "other"] as const;
    for (const zone of zones) {
      for (const gesture of GESTURES) {
        const reaction = reactionFor(gesture, zone);
        if (reaction.expression !== null) {
          expect(EXPRESSION_KEYS).toContain(reaction.expression);
        }
        expect(reaction.expressionMs).toBeGreaterThan(0);
        expect(reaction.expressionMs).toBeLessThanOrEqual(900);
        for (const bone of reaction.bones) {
          expect(bone.id.startsWith("Param")).toBe(true);
          expect(bone.ms).toBeGreaterThan(0);
        }
      }
    }
  });

  it("摸头是正向反应（喜 + 点头 + 歪头），揉是拒绝（厌恶 + 摇头）", () => {
    const tap = reactionFor("tap", "head");
    expect(tap.expression).toBe("喜");
    expect(tap.motion).toBe("nod");
    expect(tap.bones.some((bone) => bone.id === BONE_ANGLE_Z)).toBe(true);
    const knead = reactionFor("knead", "head");
    expect(knead.expression).toBe("厌恶");
    expect(knead.motion).toBe("shake");
  });

  it("按住不放闭眼，且不播动作（不打断视线）", () => {
    const hold = reactionFor("hold", "head");
    expect(hold.motion).toBeNull();
    expect(hold.bones.some((bone) => bone.id === BONE_EYE_L && bone.value < 0)).toBe(true);
  });

  it("戳脸 / 摸耳朵是惊讶方向，戳身体会晃一下", () => {
    expect(reactionFor("tap", "face").expression).toBe("惊喜");
    expect(reactionFor("tap", "ears").expression).toBe("惊喜");
    expect(reactionFor("tap", "chest").motion).toBe("shake");
  });
});
