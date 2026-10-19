/**
 * 文件职责：Stage 抽象层的纯逻辑单测（T2.4）——appearance 归一化与 act→效果映射。
 *
 * 为什么测这些：选实现（PNG / Live2D）、缺模型回退（D10）、act 该放什么动画，都是
 * 不碰 DOM 的判断；放这里测就不需要浏览器环境（CODE_STYLE §7：核心逻辑无硬件可跑）。
 */
import { describe, expect, it } from "vitest";

import type { CharacterAppearance } from "../app/main/ipc";
import { normalizeAppearance, resolveEffect } from "../app/renderer/stage-appearance";

function appearance(overrides: Partial<CharacterAppearance>): CharacterAppearance {
  return {
    stage: "png",
    portrait: "assets/portrait.png",
    model: null,
    png_fallback: null,
    motions: {},
    expressions: {},
    acts: {},
    ...overrides,
  };
}

describe("normalizeAppearance", () => {
  it("null 退成纯 PNG 安全计划（回退内置占位图）", () => {
    const plan = normalizeAppearance(null);
    expect(plan.kind).toBe("png");
    expect(plan.portrait).toBeNull();
    expect(plan.fallbackPortrait).toBeNull();
    expect(plan.acts).toEqual({});
    expect(plan.expressions).toEqual({});
  });

  it("live2d 选 live2d；hybrid 先按 png 处理", () => {
    expect(normalizeAppearance(appearance({ stage: "live2d" })).kind).toBe("live2d");
    expect(normalizeAppearance(appearance({ stage: "hybrid" })).kind).toBe("png");
  });

  it("fallbackPortrait 优先 png_fallback，其次 portrait", () => {
    expect(normalizeAppearance(appearance({ png_fallback: "assets/f.png" })).fallbackPortrait).toBe(
      "assets/f.png",
    );
    expect(normalizeAppearance(appearance({ png_fallback: null })).fallbackPortrait).toBe(
      "assets/portrait.png",
    );
  });

  it("acts / expressions 的坏值不破坏归一化", () => {
    const plan = normalizeAppearance(
      appearance({
        acts: { wave: { live2d: "M_wave", png: "bounce" } },
        expressions: { 喜: "expr_happy.png" },
      }),
    );
    expect(plan.acts["wave"]).toEqual({ live2d: "M_wave", png: "bounce" });
    expect(plan.expressions["喜"]).toBe("expr_happy.png");
  });
});

describe("resolveEffect", () => {
  it("角色包 acts 里的已知效果直接用", () => {
    const plan = normalizeAppearance(
      appearance({ acts: { wave: { live2d: "M_wave", png: "bounce" } } }),
    );
    expect(resolveEffect(plan, "wave")).toBe("bounce");
  });

  it("acts 里是不认识的效果时按关键词兜底", () => {
    const plan = normalizeAppearance(
      appearance({ acts: { wave: { live2d: "M_wave", png: "sparkle" } } }),
    );
    expect(resolveEffect(plan, "wave")).toBe("bounce");
  });

  it("think / shake 关键词映射到 shake，泛化 act 返回 null", () => {
    const plan = normalizeAppearance(appearance({ acts: {} }));
    expect(resolveEffect(plan, "think")).toBe("shake");
    expect(resolveEffect(plan, "shake")).toBe("shake");
    expect(resolveEffect(plan, "dance")).toBeNull();
  });

  it("空 act / null 不产生任何效果", () => {
    const plan = normalizeAppearance(appearance({ acts: {} }));
    expect(resolveEffect(plan, null)).toBeNull();
    expect(resolveEffect(plan, "")).toBeNull();
  });
});
