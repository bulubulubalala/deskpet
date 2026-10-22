/**
 * 文件职责：触摸意图分类与合并（T2.6）——纯逻辑，不碰 DOM / IPC。
 *
 * 意图只有两种：
 * - backchannel：轻点 1–2 下，只在角色说话 / 思考时表示「我碰到了」，不抢话筒；
 * - demand：连续戳 / 拍 / 按住 / 揉 / 摸，允许停播 + cancel 后起一轮。
 */

import type { TouchGesture, TouchMessage, TouchRegion } from "./ipc";

export type TouchIntent = "backchannel" | "demand";

/** 连点到这么多下就从 backchannel 升成 demand。 */
export const TOUCH_DEMAND_TAPS = 3;
/** 一条合并后的消息最多带几个部位（与 sidecar ChatInteraction.regions 对齐）。 */
export const TOUCH_MERGE_REGIONS_MAX = 3;

/**
 * 分类只看已经聚合好的会话事实；10 下以上仍是 demand，闸门会按 HIT_IGNORE_COUNT 吞掉。
 */
export function classifyTouchIntent(message: Pick<TouchMessage, "gesture" | "count">): TouchIntent {
  if (message.gesture === "tap") {
    return message.count >= TOUCH_DEMAND_TAPS ? "demand" : "backchannel";
  }
  return "demand";
}

/** 手势强弱：合并两串触摸时保留更「重」的那个，别让一次轻点盖住揉 / 按住。 */
const GESTURE_RANK: Record<TouchGesture, number> = {
  tap: 1,
  stroke: 2,
  pat: 3,
  knead: 4,
  hold: 5,
};

/** 合并两条触摸：部位去重、count / duration 取最大、gesture 取最强。 */
export function mergeTouches(older: TouchMessage | null, newer: TouchMessage): TouchMessage {
  if (older === null) {
    return {
      gesture: newer.gesture,
      regions: [...newer.regions].slice(0, TOUCH_MERGE_REGIONS_MAX),
      count: newer.count,
      duration_ms: newer.duration_ms,
    };
  }
  const regions: TouchRegion[] = [];
  for (const region of [...older.regions, ...newer.regions]) {
    if (region.id === "" || regions.some((item) => item.id === region.id)) {
      continue;
    }
    if (regions.length >= TOUCH_MERGE_REGIONS_MAX) {
      break;
    }
    regions.push(region);
  }
  return {
    gesture:
      GESTURE_RANK[newer.gesture] >= GESTURE_RANK[older.gesture] ? newer.gesture : older.gesture,
    regions,
    count: Math.max(older.count, newer.count),
    duration_ms: Math.max(older.duration_ms, newer.duration_ms),
  };
}
