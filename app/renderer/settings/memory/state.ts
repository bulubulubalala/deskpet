/**
 * 文件职责：设置窗「记忆」面板几个页面共用的状态与显示规则。
 *
 * 为什么单独一个文件：「现在看的是哪个角色」是所有记忆页面的前提，只存一份；时间格式也必须处处一致，否则同一份数据在两个页面显示成两个样子。
 * 依赖方向：renderer 内部模块 -> ./state、../dom、../../shared/contracts；不 import main，也不碰别的面板的 DOM。
 */

import type { MemoryItem } from "../../../shared/contracts/ipc";

export const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  event: "经历",
  action: "行为",
};

const MEMORY_TIER_LABELS: Record<string, string> = {
  fact: "长期记忆",
  "1": "阶段摘要",
  "2": "近期梗概",
  "3": "长期印象",
};

/** 面板里正在看的角色、主窗当前角色、是否跟随主窗——唯一一份。 */
export const memoryPaneState = {
  /** 下拉里选中的角色；null = 还没选（列表为空）。 */
  charId: null as string | null,
  /** 主窗现在是谁；跟随模式下会同步到 charId。 */
  currentCharId: null as string | null,
  /** 用户没手动改下拉时，记忆角色跟随主窗当前角色。 */
  follows: true,
};

/** 把 ISO 时间串显示成「2026-10-16 01:28」；空串给破折号（sidecar 没记时间的情况）。 */
export function formatMemoryTime(value: string): string {
  return value === "" ? "—" : value.replace("T", " ").slice(0, 16);
}

export function memoryMetaText(item: MemoryItem): string {
  return [
    MEMORY_KIND_LABELS[item.kind] ?? item.kind,
    MEMORY_TIER_LABELS[item.tier] ?? item.tier,
    "重要度 " + item.importance.toFixed(2),
    "记于 " + formatMemoryTime(item.created_at),
    "用过 " + String(item.used_count) + " 次",
  ].join(" · ");
}
