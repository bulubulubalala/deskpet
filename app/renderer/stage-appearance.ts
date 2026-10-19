/**
 * 文件职责：把角色包的 appearance.json 归一成「形象舞台」可直接用的计划（T2.4）。
 *
 * 为什么单独一个纯逻辑模块：选哪个实现（PNG / Live2D）、缺模型怎么回退（D10）、
 * 一个 act 该放什么效果，都是不碰 DOM 的判断；放这里才能不靠浏览器就跑单测。
 * 依赖方向：renderer 内部；只 import type（CharacterAppearance 来自主进程契约）。
 */
import type { CharacterActTarget, CharacterAppearance } from "../main/ipc";

/** PNG 实现现在支持的三种动作效果（与 style.css 的 act-* 类一一对应）。 */
export const STAGE_EFFECTS = ["fade", "bounce", "shake"] as const;
export type StageEffect = (typeof STAGE_EFFECTS)[number];

/**
 * act 名里的关键词 → 默认效果。
 *
 * 为什么要有默认：角色包可能不写 acts 映射（示例包也是手画的），但模型偶尔会吐一个
 * 常见动作（wave / blush / think）；给个兜底，总好过点了完全没反应。
 */
const ACT_HINTS: readonly (readonly [string, StageEffect])[] = [
  ["wave", "bounce"],
  ["blush", "fade"],
  ["think", "shake"],
  ["shake", "shake"],
];

/** 舞台计划：kind 决定用哪个实现，其余是渲染层画 / 播动作要的数据。 */
export interface StagePlan {
  /** 实际要构建的实现。hybrid（Live2D 待机 + CG 叠层）先按 png 处理，M3 再上 Live2D。 */
  readonly kind: "png" | "live2d";
  readonly portrait: string | null;
  readonly model: string | null;
  /** 缺 Live2D 模型时的立绘回退（D10）。 */
  readonly fallbackPortrait: string | null;
  readonly acts: Readonly<Record<string, CharacterActTarget>>;
  readonly expressions: Readonly<Record<string, string>>;
}

function normalizeActs(
  value: Readonly<Record<string, CharacterActTarget>>,
): Record<string, CharacterActTarget> {
  const result: Record<string, CharacterActTarget> = {};
  for (const [key, target] of Object.entries(value)) {
    result[key] = {
      live2d: typeof target.live2d === "string" ? target.live2d : null,
      png: typeof target.png === "string" ? target.png : null,
    };
  }
  return result;
}

/**
 * 归一化：null / 坏形状都退成「纯 PNG、无立绘」的安全计划（回退内置占位图）。
 *
 * 主进程的 readCharacterAppearance 已经做过一轮校验，这里再兜一次是为了让渲染层
 * 单独跑（真机 / 单测）时也不会因为一个 undefined 崩掉整条加载链。
 */
export function normalizeAppearance(raw: CharacterAppearance | null): StagePlan {
  const stage = raw?.stage;
  return {
    kind: stage === "live2d" ? "live2d" : "png",
    portrait: raw?.portrait ?? null,
    model: raw?.model ?? null,
    fallbackPortrait: raw?.png_fallback ?? raw?.portrait ?? null,
    acts: normalizeActs(raw?.acts ?? {}),
    expressions: { ...(raw?.expressions ?? {}) },
  };
}

/**
 * 这个 act 用哪个 CSS 效果；没有可用效果返回 null（不改样式）。
 *
 * 先看角色包 acts 映射里的 png 值（只认我们真的实现了的效果），认不出再按关键词兜底。
 */
export function resolveEffect(plan: StagePlan, act: string | null): StageEffect | null {
  if (act === null || act === "") {
    return null;
  }
  const mapped = plan.acts[act]?.png;
  if (mapped !== null && mapped !== undefined && STAGE_EFFECTS.includes(mapped as StageEffect)) {
    return mapped as StageEffect;
  }
  for (const [hint, effect] of ACT_HINTS) {
    if (act.includes(hint)) {
      return effect;
    }
  }
  return null;
}
