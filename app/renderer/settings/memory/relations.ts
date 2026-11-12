/**
 * 文件职责：设置窗「记忆」面板的关系与待办：角色关系的一句话描述，以及带触发时间的待办事项。
 *
 * 为什么单独一个文件：两者都是「一条记录 + 一个保存按钮」的小表单，规模相近、生命周期一致；和日记/时间线的大列表分开后，每块只读自己那个表单。
 * 依赖方向：renderer 内部模块 -> ./state、../dom、../../shared/contracts；不 import main，也不碰别的面板的 DOM。
 */

import type { MemoryIntentionItem, MemoryRelationItem } from "../../../shared/contracts/ipc";
import { api, byId, setText } from "../dom";
import { formatMemoryTime, memoryPaneState } from "./state";
function renderRelation(relation: MemoryRelationItem): void {
  const pairs: readonly [string, number][] = [
    ["relation-familiarity", relation.familiarity],
    ["relation-trust", relation.trust],
    ["relation-warmth", relation.warmth],
  ];
  for (const [id, value] of pairs) {
    const input = byId(id);
    if (input instanceof HTMLInputElement) {
      input.value = value.toFixed(2);
    }
  }
  const unresolved = byId("relation-unresolved");
  if (unresolved instanceof HTMLTextAreaElement) {
    unresolved.value = relation.unresolved;
  }
  setText(
    "relation-status",
    relation.updated_at === ""
      ? "还没有关系记录。"
      : "上次更新 " + formatMemoryTime(relation.updated_at),
  );
}

export async function refreshRelation(): Promise<void> {
  const charId = memoryPaneState.charId;
  if (charId === null) {
    return;
  }
  try {
    const relation = await api.memory.relation(charId);
    if (charId !== memoryPaneState.charId) {
      return;
    }
    renderRelation(relation);
  } catch (error: unknown) {
    setText("relation-status", "读不到关系记忆：" + String(error));
  }
}

async function saveRelation(): Promise<void> {
  const charId = memoryPaneState.charId;
  if (charId === null) {
    return;
  }
  const readNumber = (id: string): number => {
    const input = byId(id);
    if (!(input instanceof HTMLInputElement)) {
      return 0.5;
    }
    const value = Number(input.value);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
  };
  const unresolved = byId("relation-unresolved");
  const button = byId("relation-save");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  try {
    const relation = await api.memory.saveRelation(charId, {
      familiarity: readNumber("relation-familiarity"),
      trust: readNumber("relation-trust"),
      warmth: readNumber("relation-warmth"),
      unresolved: unresolved instanceof HTMLTextAreaElement ? unresolved.value.trim() : "",
      recent_conflict: "",
    });
    renderRelation(relation);
    setText("relation-status", "关系已保存，下一轮生效。");
  } catch (error: unknown) {
    setText("relation-status", "保存失败：" + String(error));
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

function renderIntentions(items: readonly MemoryIntentionItem[]): void {
  const host = byId("intention-list");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "现在没有悬着的事。";
    host.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "timeline-entry";
    const head = document.createElement("div");
    head.className = "timeline-entry-head";
    const when = document.createElement("span");
    when.textContent = item.trigger_at === "" ? "未定时间" : formatMemoryTime(item.trigger_at);
    head.append(when);
    const text = document.createElement("p");
    text.textContent = item.text;
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "btn-ghost btn-sm";
    done.textContent = "完成";
    done.addEventListener("click", () => {
      void resolveIntention(item.id);
    });
    actions.append(done);
    row.append(head, text, actions);
    host.append(row);
  }
}

export async function refreshIntentions(): Promise<void> {
  const charId = memoryPaneState.charId;
  if (charId === null) {
    renderIntentions([]);
    return;
  }
  try {
    const response = await api.memory.intentions({ char_id: charId, limit: 50 });
    if (charId !== memoryPaneState.charId) {
      return;
    }
    renderIntentions(response.items);
  } catch (error: unknown) {
    setText("intention-status", "读不到前瞻记忆：" + String(error));
  }
}

async function addIntention(): Promise<void> {
  const charId = memoryPaneState.charId;
  const input = byId("intention-text");
  if (charId === null || !(input instanceof HTMLInputElement)) {
    return;
  }
  const text = input.value.trim();
  if (text === "") {
    return;
  }
  try {
    await api.memory.addIntention({ char_id: charId, text });
    input.value = "";
    setText("intention-status", "已记下。");
    await refreshIntentions();
  } catch (error: unknown) {
    setText("intention-status", "保存失败：" + String(error));
  }
}

async function resolveIntention(intentionId: number): Promise<void> {
  try {
    await api.memory.resolveIntention(intentionId);
    setText("intention-status", "已完成。");
    await refreshIntentions();
  } catch (error: unknown) {
    setText("intention-status", "操作失败：" + String(error));
  }
}

/** 关系与待办页的接线。 */
export function initRelationsPane(): void {
  byId("intention-add")?.addEventListener("click", () => {
    void addIntention();
  });
  byId("relation-save")?.addEventListener("click", () => {
    void saveRelation();
  });
}
