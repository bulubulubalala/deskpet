/**
 * 文件职责：设置窗「记忆」面板的时间线：阶段摘要的列表、层级切换、重建/补算、编辑与「这条摘要是哪来的」。
 *
 * 为什么单独一个文件：时间线的每一行都可编辑、可置顶、可展开来源，交互比其它页面重；它只依赖「当前角色」和「重建后刷新图谱」，不需要知道日记与列表。
 * 依赖方向：renderer 内部模块 -> ./state、../dom、../../shared/contracts；不 import main，也不碰别的面板的 DOM。
 */

import type {
  MemoryPeriodItem,
  MemoryTimelineRebuildResponse,
} from "../../../shared/contracts/ipc";
import { api, byId, setText, showBanner } from "../dom";
import { formatMemoryTime, memoryPaneState } from "./state";
import { refreshGraph } from "./graph";
const TIMELINE_LEVEL_LABELS: Record<string, string> = {
  episode: "会话片段",
  day: "一天",
  week: "一周",
  month: "一个月",
};

let timelineToken = 0;

function timelineTitle(item: MemoryPeriodItem): string {
  if (item.level === "day") {
    return item.label || item.day_key || formatMemoryTime(item.period_start);
  }
  return item.label || formatMemoryTime(item.period_start);
}

function renderTimeline(items: readonly MemoryPeriodItem[]): void {
  const host = byId("timeline-list");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有时间线回忆。聊几句后点「整理现在」，或等后台自动整理。";
    host.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "timeline-entry";
    const head = document.createElement("div");
    head.className = "timeline-entry-head";
    const level = document.createElement("span");
    level.className = "timeline-entry-level";
    level.textContent = TIMELINE_LEVEL_LABELS[item.level] ?? item.level;
    const when = document.createElement("span");
    when.textContent =
      timelineTitle(item) + (item.pinned ? " · 置顶" : "") + (item.edited ? " · 已手动改过" : "");
    head.append(level, when);
    const text = document.createElement("p");
    text.textContent = item.summary;
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn-ghost btn-sm";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      void editTimeline(item);
    });
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "btn-ghost btn-sm";
    pin.textContent = item.pinned ? "取消置顶" : "置顶";
    pin.addEventListener("click", () => {
      void toggleTimelinePin(item);
    });
    const sources = document.createElement("button");
    sources.type = "button";
    sources.className = "btn-ghost btn-sm";
    sources.textContent = "来源";
    sources.addEventListener("click", () => {
      void showTimelineSources(item);
    });
    actions.append(edit, pin, sources);
    row.append(head, text, actions);
    host.append(row);
  }
}

export async function refreshTimeline(): Promise<void> {
  const token = ++timelineToken;
  const charId = memoryPaneState.charId;
  const status = byId("timeline-status");
  if (charId === null) {
    renderTimeline([]);
    setText("timeline-status", "先选一个角色。");
    setText("timeline-count", "");
    return;
  }
  if (status !== null) {
    status.textContent = "正在读取时间线…";
  }
  const select = byId("timeline-level");
  const levels = select instanceof HTMLSelectElement ? select.value : "";
  try {
    const response = await api.memory.timeline({
      char_id: charId,
      ...(levels === "" ? {} : { levels }),
      limit: 100,
    });
    if (token !== timelineToken || charId !== memoryPaneState.charId) {
      return;
    }
    renderTimeline(response.items);
    setText("timeline-count", String(response.items.length) + " 条");
    if (status !== null) {
      status.textContent = response.items.length === 0 ? "这个角色还没有按时间整理的回忆。" : "";
    }
  } catch (error: unknown) {
    if (token !== timelineToken) {
      return;
    }
    renderTimeline([]);
    if (status !== null) {
      status.textContent = "读不到时间线（后台引擎没起来？）：" + String(error);
    }
  }
}

async function onTimelineRebuild(): Promise<void> {
  const charId = memoryPaneState.charId;
  const button = byId("timeline-rebuild");
  if (charId === null || !(button instanceof HTMLButtonElement) || button.disabled) {
    return;
  }
  button.disabled = true;
  setText("timeline-status", "正在整理，模型较慢时可能需要一会儿…");
  try {
    const result: MemoryTimelineRebuildResponse = await api.memory.rebuildTimeline({
      char_id: charId,
    });
    const text =
      "新增/更新：片段 " +
      String(result.episode) +
      "，日 " +
      String(result.day) +
      "，周 " +
      String(result.week) +
      "，月 " +
      String(result.month);
    showBanner(text);
    await refreshTimeline();
    await refreshGraph();
  } catch (error: unknown) {
    setText("timeline-status", "整理失败：" + String(error));
    showBanner("整理时间线失败：" + String(error));
  } finally {
    button.disabled = false;
  }
}

async function onTimelineBackfill(): Promise<void> {
  const charId = memoryPaneState.charId;
  const button = byId("timeline-backfill");
  if (charId === null || !(button instanceof HTMLButtonElement) || button.disabled) {
    return;
  }
  if (!window.confirm("回填历史会调用模型整理旧对话，可能耗时较久。继续？")) {
    return;
  }
  button.disabled = true;
  setText("timeline-status", "正在回填历史，旧对话较多时可能需要几分钟…");
  try {
    const result = await api.memory.backfillTimeline({ char_id: charId, days: 365 });
    const text =
      "回填完成：片段 " +
      String(result.episode) +
      "，日 " +
      String(result.day) +
      "，周 " +
      String(result.week) +
      "，月 " +
      String(result.month);
    showBanner(text);
    await refreshTimeline();
    await refreshGraph();
  } catch (error: unknown) {
    setText("timeline-status", "回填失败：" + String(error));
  } finally {
    button.disabled = false;
  }
}

async function editTimeline(item: MemoryPeriodItem): Promise<void> {
  const next = window.prompt("编辑这段回忆", item.summary);
  if (next === null || next.trim() === "" || next.trim() === item.summary) {
    return;
  }
  try {
    await api.memory.editPeriod({
      period_id: item.id,
      summary: next.trim(),
      pinned: item.pinned,
    });
    setText("timeline-status", "已保存修改；自动整理不会再覆盖它。");
    await refreshTimeline();
  } catch (error: unknown) {
    setText("timeline-status", "保存失败：" + String(error));
  }
}

async function toggleTimelinePin(item: MemoryPeriodItem): Promise<void> {
  try {
    await api.memory.editPeriod({
      period_id: item.id,
      summary: item.summary,
      pinned: !item.pinned,
    });
    setText("timeline-status", item.pinned ? "已取消置顶。" : "已置顶；这条不会被自动遗忘。");
    await refreshTimeline();
  } catch (error: unknown) {
    setText("timeline-status", "置顶失败：" + String(error));
  }
}

async function showTimelineSources(item: MemoryPeriodItem): Promise<void> {
  try {
    const detail = await api.memory.periodDetail(item.id);
    const text =
      detail.sources.length === 0
        ? "这条回忆没有记录来源。"
        : "来源：" + detail.sources.map(([kind, id]) => kind + " #" + String(id)).join("、");
    setText("timeline-status", text);
  } catch (error: unknown) {
    setText("timeline-status", "读不到来源：" + String(error));
  }
}

/** 时间线页的接线：刷新、层级切换、重建、补算。 */
export function initTimelinePane(): void {
  byId("timeline-refresh")?.addEventListener("click", () => {
    void refreshTimeline();
  });
  byId("timeline-level")?.addEventListener("change", () => {
    void refreshTimeline();
  });
  byId("timeline-rebuild")?.addEventListener("click", () => {
    void onTimelineRebuild();
  });
  byId("timeline-backfill")?.addEventListener("click", () => {
    void onTimelineBackfill();
  });
}
