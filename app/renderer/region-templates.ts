/**
 * 文件职责：角色包编辑器的「标准部位」模板（T2.44）。
 *
 * 为什么单列一个纯函数模块：模板位置 / 默认优先级是数据，不是界面逻辑；单测直接对拍
 * 「缺哪些补哪些、已有 id 不覆盖」，不用起 DOM。坐标沿用 hits.json 的 0–1 归一化画布，
 * 与 char-hit 的换算同一套，套用后可直接拖拽微调。
 * 依赖方向：renderer -> ../main/ipc（只 import 类型）；不碰 DOM、不碰 IPC。
 */
import type { PackRegionDraft } from "../shared/contracts/ipc";

/** 一个标准部位：id 与 hits.json / touch-reaction 的关键词对齐，名字可直接显示。 */
export interface StandardRegionTemplate {
  readonly id: string;
  readonly name: string;
  readonly rect: readonly [number, number, number, number];
  readonly priority: number;
  readonly padding: number;
}

/**
 * 12 个标准部位（+ 双眼）的默认位置：按「全身立绘竖直居中」的常见构图给的经验值，
 * 套用后一律可以拖。优先级与 characters/xiaoyu/hits.json 保持一致：
 * 脸 / 眼最具体，手、耳朵次之，躯干最大块放最低。
 */
export const STANDARD_REGION_TEMPLATES: readonly StandardRegionTemplate[] = [
  { id: "eyes", name: "眼睛", rect: [0.42, 0.1, 0.16, 0.035], priority: 11, padding: 0.01 },
  { id: "face", name: "脸", rect: [0.4, 0.06, 0.2, 0.1], priority: 10, padding: 0.012 },
  { id: "hand_left", name: "左手", rect: [0.14, 0.5, 0.11, 0.1], priority: 8, padding: 0.012 },
  { id: "hand_right", name: "右手", rect: [0.75, 0.5, 0.11, 0.1], priority: 8, padding: 0.012 },
  { id: "ears", name: "耳朵", rect: [0.33, 0.045, 0.34, 0.05], priority: 7, padding: 0.01 },
  { id: "head", name: "头", rect: [0.36, 0.02, 0.28, 0.13], priority: 6, padding: 0.01 },
  { id: "thigh_left", name: "左腿", rect: [0.34, 0.54, 0.15, 0.22], priority: 5, padding: 0.012 },
  { id: "thigh_right", name: "右腿", rect: [0.51, 0.54, 0.15, 0.22], priority: 5, padding: 0.012 },
  { id: "arm_left", name: "左臂", rect: [0.16, 0.24, 0.13, 0.26], priority: 4, padding: 0.012 },
  { id: "arm_right", name: "右臂", rect: [0.71, 0.24, 0.13, 0.26], priority: 4, padding: 0.012 },
  { id: "chest", name: "胸", rect: [0.3, 0.24, 0.4, 0.14], priority: 3, padding: 0.015 },
  { id: "waist", name: "腰", rect: [0.33, 0.36, 0.34, 0.08], priority: 3, padding: 0.012 },
  { id: "hips", name: "胯", rect: [0.3, 0.42, 0.4, 0.12], priority: 3, padding: 0.015 },
];

/** 已存在的 id（大小写不敏感）：套用模板时按它跳过，避免出现两个同 id 的框。 */
function takenIds(existing: readonly PackRegionDraft[]): Set<string> {
  return new Set(existing.map((region) => region.id.trim().toLowerCase()));
}

/** 模板 → 草稿（id 直接沿用模板 id：与触摸分类的 ZONE_KEYWORDS 对得上）。 */
export function templateDraft(template: StandardRegionTemplate, color: string): PackRegionDraft {
  return {
    id: template.id,
    name: template.name,
    rect: [template.rect[0], template.rect[1], template.rect[2], template.rect[3]],
    color,
    act: "",
    priority: template.priority,
    padding: template.padding,
  };
}

/**
 * 只在缺的部位上补模板（T2.44）：返回要追加的草稿，已存在的 id 一个都不动。
 *
 * 为什么不全量覆盖：用户可能已经手调过脸的位置，套模板只应补空白，不该把他的框推回去。
 */
export function buildTemplateRegions(
  existing: readonly PackRegionDraft[],
  colors: readonly string[],
): PackRegionDraft[] {
  const taken = takenIds(existing);
  const added: PackRegionDraft[] = [];
  for (const template of STANDARD_REGION_TEMPLATES) {
    if (taken.has(template.id)) {
      continue;
    }
    const color =
      colors[(existing.length + added.length) % Math.max(1, colors.length)] ?? "#ffb347";
    added.push(templateDraft(template, color));
    taken.add(template.id);
  }
  return added;
}

/** 按名字找标准部位（下拉选名字时用）：没有返回 null。 */
export function findTemplateByName(name: string): StandardRegionTemplate | null {
  const wanted = name.trim();
  return STANDARD_REGION_TEMPLATES.find((template) => template.name === wanted) ?? null;
}
