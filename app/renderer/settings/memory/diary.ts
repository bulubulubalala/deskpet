/**
 * 文件职责：设置窗「记忆」面板的日记：按天写的条目、新增/编辑/删除，以及写完后顺带刷新时间线与图谱。
 *
 * 为什么单独一个文件：日记的编辑区有一份「正在编辑哪一条」的状态，且保存后会牵动时间线与图谱；它自己承担这两个后续动作，调用方不必知道。
 * 依赖方向：renderer 内部模块 -> ./state、../dom、../../shared/contracts；不 import main，也不碰别的面板的 DOM。
 */

import type { MemoryDiaryItem } from "../../../shared/contracts/ipc";
import { api, byId, setText, showBanner } from "../dom";
import { formatMemoryTime, memoryPaneState } from "./state";
import { refreshGraph } from "./graph";
import { refreshTimeline } from "./timeline";
function renderDiary(items: readonly MemoryDiaryItem[]): void {
  const host = byId("diary-list");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有手动日记。";
    host.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "timeline-entry";
    const head = document.createElement("div");
    head.className = "timeline-entry-head";
    const when = document.createElement("span");
    when.textContent = formatMemoryTime(item.occurred_at);
    const meta = document.createElement("span");
    meta.textContent = [item.mood, item.tags].filter((value) => value !== "").join(" · ");
    head.append(when, meta);
    const text = document.createElement("p");
    text.textContent = item.text;
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn-ghost btn-sm";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      void editDiary(item);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-danger btn-sm";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      void deleteDiary(item.id);
    });
    actions.append(edit, remove);
    row.append(head, text, actions);
    host.append(row);
  }
}

export async function refreshDiary(): Promise<void> {
  const charId = memoryPaneState.charId;
  if (charId === null) {
    renderDiary([]);
    return;
  }
  try {
    const response = await api.memory.diary({ char_id: charId, limit: 50 });
    if (charId !== memoryPaneState.charId) {
      return;
    }
    renderDiary(response.items);
  } catch (error: unknown) {
    showBanner("读不到日记：" + String(error));
  }
}

async function addDiary(): Promise<void> {
  const charId = memoryPaneState.charId;
  const textarea = byId("diary-text");
  const mood = byId("diary-mood");
  const tags = byId("diary-tags");
  if (charId === null || !(textarea instanceof HTMLTextAreaElement)) {
    return;
  }
  const text = textarea.value.trim();
  if (text === "") {
    showBanner("先写一点内容再保存。");
    return;
  }
  try {
    await api.memory.addDiary({
      char_id: charId,
      text,
      ...(mood instanceof HTMLInputElement && mood.value.trim() !== ""
        ? { mood: mood.value.trim() }
        : {}),
      ...(tags instanceof HTMLInputElement && tags.value.trim() !== ""
        ? { tags: tags.value.trim() }
        : {}),
    });
    textarea.value = "";
    if (mood instanceof HTMLInputElement) {
      mood.value = "";
    }
    if (tags instanceof HTMLInputElement) {
      tags.value = "";
    }
    setText("diary-status", "已写进日记。");
    await refreshDiary();
    await refreshTimeline();
    await refreshGraph();
  } catch (error: unknown) {
    setText("diary-status", "保存失败：" + String(error));
  }
}

function editDiary(item: MemoryDiaryItem): void {
  const textarea = byId("diary-text");
  const mood = byId("diary-mood");
  const tags = byId("diary-tags");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    return;
  }
  textarea.value = item.text;
  if (mood instanceof HTMLInputElement) {
    mood.value = item.mood;
  }
  if (tags instanceof HTMLInputElement) {
    tags.value = item.tags;
  }
  textarea.focus();
  setText("diary-status", "编辑中：改完点「保存编辑」。");
  const button = byId("diary-add");
  if (button instanceof HTMLButtonElement) {
    button.textContent = "保存编辑";
    button.dataset["entryId"] = String(item.id);
  }
}

async function saveDiary(): Promise<void> {
  const button = byId("diary-add");
  const editing = button instanceof HTMLButtonElement ? button.dataset["entryId"] : undefined;
  if (editing === undefined) {
    await addDiary();
    return;
  }
  const charId = memoryPaneState.charId;
  const textarea = byId("diary-text");
  const mood = byId("diary-mood");
  const tags = byId("diary-tags");
  if (charId === null || !(textarea instanceof HTMLTextAreaElement)) {
    return;
  }
  const text = textarea.value.trim();
  if (text === "") {
    showBanner("日记正文不能为空。");
    return;
  }
  try {
    await api.memory.updateDiary({
      entry_id: Number(editing),
      text,
      ...(mood instanceof HTMLInputElement ? { mood: mood.value.trim() } : {}),
      ...(tags instanceof HTMLInputElement ? { tags: tags.value.trim() } : {}),
    });
    resetDiaryEditor();
    setText("diary-status", "已保存修改。");
    await refreshDiary();
    await refreshTimeline();
  } catch (error: unknown) {
    setText("diary-status", "保存失败：" + String(error));
  }
}

function resetDiaryEditor(): void {
  const textarea = byId("diary-text");
  const mood = byId("diary-mood");
  const tags = byId("diary-tags");
  const button = byId("diary-add");
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.value = "";
  }
  if (mood instanceof HTMLInputElement) {
    mood.value = "";
  }
  if (tags instanceof HTMLInputElement) {
    tags.value = "";
  }
  if (button instanceof HTMLButtonElement) {
    button.textContent = "写进日记";
    delete button.dataset["entryId"];
  }
}

async function deleteDiary(entryId: number): Promise<void> {
  try {
    await api.memory.deleteDiary(entryId);
    resetDiaryEditor();
    setText("diary-status", "已删除这条日记。");
    await refreshDiary();
    await refreshTimeline();
    await refreshGraph();
  } catch (error: unknown) {
    setText("diary-status", "删除失败：" + String(error));
  }
}

/** 日记页的接线（新增走同一个按钮，编辑/删除由每行的按钮自己挂）。 */
export function initDiaryPane(): void {
  byId("diary-add")?.addEventListener("click", () => {
    void saveDiary();
  });
}
