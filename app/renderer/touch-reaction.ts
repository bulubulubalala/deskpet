/**
 * 文件职责：触摸 → 本地即时反应（表情 / 微动作 / 骨骼参数增量）的纯映射表。
 *
 * 为什么不等模型的台词反应：闸门 8s 冷却、每分钟 4 次，戳一下要等模型回话才有反馈太迟；
 * 这里给的是 300–900ms 的「身体先动一下」，模型随后说的话再覆盖它。
 * 依赖方向：只 import type（main/ipc）；不碰 DOM，便于单测。
 * 谁调用：app/renderer/index.ts（松手时），tests/touch-reaction.test.ts。
 */
import type { TouchGesture } from "../shared/contracts/ipc";

/** 语义部位：只分「摸哪儿大概是什么感觉」，不追求解剖学精度。 */
export type TouchZone = "head" | "face" | "ears" | "eyes" | "chest" | "hand" | "legs" | "other";

/** 一条骨骼参数增量；value 是「在当帧数值上加多少」（不是绝对值）。 */
export interface BoneNudge {
  readonly id: string;
  readonly value: number;
  readonly ms: number;
}

export interface TouchReaction {
  /** appearance.expressions 的键；null 表示这次不换表情。 */
  readonly expression: string | null;
  readonly expressionMs: number;
  /** appearance.motions / acts 的键（idle / nod / shake / blink…）；null 表示不播动作。 */
  readonly motion: string | null;
  readonly bones: readonly BoneNudge[];
}

/** 部位 id / 名字里的关键词 → 语义部位；先窄后宽（眼睛、耳朵、头、脸…），全靠 includes。 */
const ZONE_KEYWORDS: readonly (readonly [TouchZone, readonly string[]])[] = [
  ["eyes", ["eye", "eyes", "眼"]],
  ["ears", ["ear", "ears", "耳"]],
  ["head", ["head", "hair", "头", "頭", "发", "髮"]],
  ["face", ["face", "cheek", "脸", "臉", "颊", "頰", "嘴", "唇", "鼻"]],
  ["chest", ["chest", "body", "belly", "胸", "腹", "肚", "身"]],
  ["hand", ["hand", "arm", "手", "臂"]],
  ["legs", ["leg", "foot", "腿", "脚", "腳"]],
];

/** 标准 Cubism 参数名（xiaoyu 的 model3 没有的参数写了也会被 Core 忽略，不会报错）。 */
export const BONE_ANGLE_X = "ParamAngleX";
export const BONE_ANGLE_Y = "ParamAngleY";
export const BONE_ANGLE_Z = "ParamAngleZ";
export const BONE_BODY_X = "ParamBodyAngleX";
export const BONE_EYE_L = "ParamEyeLOpen";
export const BONE_EYE_R = "ParamEyeROpen";
export const BONE_BROW_L = "ParamBrowLY";

export function classifyZone(
  id: string | null | undefined,
  name: string | null | undefined,
): TouchZone {
  const hay = `${id ?? ""} ${name ?? ""}`.toLowerCase();
  if (hay.trim() === "") {
    return "other";
  }
  for (const [zone, keys] of ZONE_KEYWORDS) {
    if (keys.some((key) => hay.includes(key))) {
      return zone;
    }
  }
  return "other";
}

/** 每个手势的默认反应（不分部位）；部位差异在 reactionFor 里覆盖。 */
export function baseReaction(gesture: TouchGesture): TouchReaction {
  switch (gesture) {
    case "pat":
      return {
        expression: "喜",
        expressionMs: 700,
        motion: "nod",
        bones: [
          { id: BONE_ANGLE_X, value: 3.5, ms: 320 },
          { id: BONE_ANGLE_Z, value: -2.5, ms: 460 },
        ],
      };
    case "stroke":
      // 摸着不动：只有歪头蹭一下，不播动作（动作会打断视线跟随的连贯感）
      return {
        expression: "喜",
        expressionMs: 800,
        motion: null,
        bones: [{ id: BONE_ANGLE_Z, value: 3, ms: 900 }],
      };
    case "hold":
      // 按住不放：闭眼享受（眼睛参数是 1=睁、0=闭，所以给负增量）
      return {
        expression: "喜",
        expressionMs: 900,
        motion: null,
        bones: [
          { id: BONE_EYE_L, value: -0.8, ms: 700 },
          { id: BONE_EYE_R, value: -0.8, ms: 700 },
        ],
      };
    case "knead":
      // 揉：有点被揉烦了
      return {
        expression: "厌恶",
        expressionMs: 550,
        motion: "shake",
        bones: [{ id: BONE_ANGLE_Z, value: 4, ms: 260 }],
      };
    case "tap":
    default:
      return {
        expression: "喜",
        expressionMs: 600,
        motion: "nod",
        bones: [
          { id: BONE_ANGLE_X, value: 2.5, ms: 300 },
          { id: BONE_ANGLE_Z, value: -1.5, ms: 420 },
        ],
      };
  }
}

/**
 * 手势 + 部位 → 具体反应。
 *
 * 设计取向（社区调研结论）：先动角色本体、一个手势一种语言、不超过 900ms；
 * 所以 tap/pat 有动作，stroke/hold 只有骨参数，knead 才有明显的「拒绝」。
 */
export function reactionFor(gesture: TouchGesture, zone: TouchZone): TouchReaction {
  const base = baseReaction(gesture);
  if (zone === "face" && (gesture === "tap" || gesture === "pat")) {
    // 戳脸：眼睛睁大一点（正增量），比单纯微笑更像「被戳到了」
    return {
      expression: "惊喜",
      expressionMs: 550,
      motion: base.motion,
      bones: [
        { id: BONE_EYE_L, value: 0.15, ms: 300 },
        { id: BONE_EYE_R, value: 0.15, ms: 300 },
      ],
    };
  }
  if (zone === "eyes" && (gesture === "tap" || gesture === "pat")) {
    // 戳眼睛（真有人点）：闭一下眼
    return {
      expression: "惊喜",
      expressionMs: 500,
      motion: null,
      bones: [
        { id: BONE_EYE_L, value: -0.9, ms: 260 },
        { id: BONE_EYE_R, value: -0.9, ms: 260 },
      ],
    };
  }
  if (zone === "ears" && (gesture === "tap" || gesture === "pat")) {
    // 摸耳朵：歪头 + 眯眼
    return {
      expression: "惊喜",
      expressionMs: 600,
      motion: base.motion,
      bones: [
        { id: BONE_ANGLE_Z, value: 5, ms: 400 },
        { id: BONE_EYE_L, value: -0.35, ms: 400 },
        { id: BONE_EYE_R, value: -0.35, ms: 400 },
      ],
    };
  }
  if (zone === "chest" && (gesture === "tap" || gesture === "pat")) {
    // 戳身体：整个人晃一下（角度写小，别像被打了）
    return {
      expression: "惊喜",
      expressionMs: 550,
      motion: "shake",
      bones: [{ id: BONE_BODY_X, value: 3, ms: 380 }],
    };
  }
  return base;
}
