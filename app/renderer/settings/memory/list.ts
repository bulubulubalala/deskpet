/**
 * 文件职责：设置窗「记忆」面板的主列表：长期事实、最近对话原文、删除/清空、数据包导出与恢复、行为记忆开关。
 *
 * 为什么单独一个文件：这是「记忆」页的第一屏，也是唯一负责「换角色后把所有页面拉一遍」的地方——它知道其它页面的刷新入口，反过来不成立。
 * 依赖方向：renderer 内部模块 -> ./state、../dom、../../shared/contracts；不 import main，也不碰别的面板的 DOM。
 */

import type { MemoryItem, MemoryMessageItem } from "../../../shared/contracts/ipc";
import { api, byId, setText, showBanner } from "../dom";
import { formatMemoryTime, memoryMetaText, memoryPaneState } from "./state";
import { refreshEmbeddingModel, refreshEmbeddingStatus } from "./embedding";
import { refreshTimeline } from "./timeline";
import { refreshDiary } from "./diary";
import { refreshRelation, refreshIntentions } from "./relations";
import { refreshGraph } from "./graph";
import { refreshBackups } from "./backups";
function renderMemories(items: readonly MemoryItem[]): void {
  const host = byId("memory-list");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent =
      memoryPaneState.charId === null
        ? "先选一个角色。"
        : "没有提取出长期事实；最近对话仍会显示在下方。";
    host.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "memory";
    const text = document.createElement("p");
    text.className = "memory-text";
    text.textContent = item.text;
    const meta = document.createElement("p");
    meta.className = "memory-meta";
    meta.textContent = memoryMetaText(item);
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-danger btn-sm";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      void removeMemory(item.id, remove);
    });
    actions.append(remove);
    row.append(text, meta, actions);
    host.append(row);
  }
}

function renderRecentMessages(items: readonly MemoryMessageItem[]): void {
  const host = byId("memory-recent");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "这个角色还没有对话原文。";
    host.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "dev-message";
    const meta = document.createElement("p");
    meta.className = "placeholder";
    meta.textContent = [
      item.role === "user" ? "用户" : "助手",
      formatMemoryTime(item.created_at),
      item.covered_by === 0 ? "未压缩" : "摘要 #" + String(item.covered_by),
    ].join(" · ");
    const text = document.createElement("p");
    text.textContent = item.text;
    row.append(meta, text);
    host.append(row);
  }
}

/** 语义检索状态请求的序号：切角色时旧请求晚回来，不能覆盖新角色的结果。 */

async function removeMemory(memoryId: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const result = await api.memory.remove({ memory_id: memoryId });
    showBanner(result.deleted ? "已删除这条记忆，下一轮不再注入。" : "这条记忆已经不在了。");
  } catch (error: unknown) {
    showBanner("删除记忆失败：" + String(error));
    button.disabled = false;
  }
  await refreshMemories();
}

/** 拉该角色的记忆。记忆是增强项：读不到只在这块面板显示错误，不影响别处（§6.4）。 */
export async function refreshMemories(): Promise<void> {
  void refreshEmbeddingStatus();
  void refreshEmbeddingModel();
  void refreshTimeline();
  void refreshDiary();
  void refreshRelation();
  void refreshGraph();
  void refreshIntentions();
  const host = byId("memory-list");
  if (memoryPaneState.charId === null) {
    renderMemories([]);
    renderRecentMessages([]);
    setText("memory-overview", "先选一个角色。");
    return;
  }
  if (host !== null) {
    const pending = document.createElement("p");
    pending.className = "placeholder";
    pending.textContent = "正在读取记忆…";
    host.replaceChildren(pending);
  }
  try {
    const [response, messages] = await Promise.all([
      api.memory.list({ char_id: memoryPaneState.charId, limit: 50 }),
      api.memory.messages({ char_id: memoryPaneState.charId, limit: 10 }),
    ]);
    renderMemories(response.items);
    renderRecentMessages(messages.items);
    setText(
      "memory-overview",
      "长期事实 " +
        String(response.items.length) +
        " 条 · 最近对话 " +
        String(messages.items.length) +
        (messages.has_more ? "+" : "") +
        " 条",
    );
  } catch (error: unknown) {
    if (host !== null) {
      const failed = document.createElement("p");
      failed.className = "placeholder";
      failed.textContent = "读不到记忆（后台引擎没起来？）：" + String(error);
      host.replaceChildren(failed);
    }
  }
}

/** 初始化滑条：拖到 100% 才解锁按钮，避免误触不可撤销的重置。 */
function updateInitializeGate(): void {
  const slider = byId("memory-reset-slider");
  const button = byId("memory-clear");
  const value = byId("memory-reset-value");
  const hint = byId("memory-reset-hint");
  if (!(slider instanceof HTMLInputElement)) {
    return;
  }
  const unlocked = Number(slider.value) >= 100;
  if (button instanceof HTMLButtonElement) {
    button.disabled = !unlocked;
  }
  slider.style.setProperty("--range-fill", String(Math.round(Number(slider.value))) + "%");
  if (value !== null) {
    value.textContent = String(Math.round(Number(slider.value))) + "%";
  }
  if (hint !== null) {
    hint.textContent = unlocked
      ? "已解锁：点「初始化记忆」会清空该角色，且不可撤销。"
      : "把滑条拖到 100% 解锁；这是不可撤销的初始化。";
  }
}

function resetInitializeGate(): void {
  const slider = byId("memory-reset-slider");
  if (slider instanceof HTMLInputElement) {
    slider.value = "0";
  }
  updateInitializeGate();
}

function onClearClicked(): void {
  const button = byId("memory-clear");
  const slider = byId("memory-reset-slider");
  if (!(button instanceof HTMLButtonElement) || !(slider instanceof HTMLInputElement)) {
    return;
  }
  if (button.disabled || Number(slider.value) < 100) {
    return;
  }
  if (memoryPaneState.charId === null) {
    showBanner("先在上面选一个角色。");
    return;
  }
  button.disabled = true;
  void clearMemories();
}

async function clearMemories(): Promise<void> {
  const charId = memoryPaneState.charId;
  if (charId === null) {
    return;
  }
  try {
    const result = await api.memory.clear({ char_id: charId });
    // 删除前 sidecar 会留一份快照（D9 第 5 条）；只回文件名，别在横幅里塞整条路径
    const kept =
      result.snapshot === ""
        ? "（没能留底：记忆库当时没打开或写盘失败）"
        : "（删除前已留底 " + (result.snapshot.split(/[\\/]/).pop() ?? "") + "）";
    showBanner("已初始化该角色记忆，共删除 " + String(result.deleted) + " 条记录。" + kept);
  } catch (error: unknown) {
    showBanner("清空记忆失败：" + String(error));
  }
  resetInitializeGate();
  await refreshMemories();
}

/** 读「行为记忆」总开关（T2.1c）并勾上；失败只在这块面板提示，不挡别的设置。 */
async function onExportDataClicked(): Promise<void> {
  const button = byId("data-export");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  setText("data-export-status", "正在打包，可能要几十秒…");
  try {
    const result = await api.data.export();
    const where = result.path === "" ? "已导出" : "已导出：" + result.path;
    const skipped =
      result.skipped.length > 0 ? "（有 " + String(result.skipped.length) + " 项被跳过）" : "";
    setText("data-export-status", where + skipped);
  } catch (error: unknown) {
    setText("data-export-status", "导出失败：" + String(error));
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

async function onRestoreDataClicked(): Promise<void> {
  const button = byId("data-restore");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  setText("data-restore-status", "正在解包…");
  try {
    const result = await api.data.restore();
    if (result === null) {
      setText("data-restore-status", "已取消。");
      return;
    }
    const mib = (result.db_bytes / (1024 * 1024)).toFixed(1);
    setText(
      "data-restore-status",
      "已准备好 " +
        mib +
        " MiB 的记忆库。点右边「立即重启引擎」让它在启动时换上；当前库会先留底到 data/backups。",
    );
    // 重启按钮只在「已经解包好、还没换库」这段窗口里有意义，换完就藏回去
    const apply = byId("data-restore-apply");
    if (apply instanceof HTMLButtonElement) {
      apply.hidden = false;
      apply.disabled = false;
    }
  } catch (error: unknown) {
    setText("data-restore-status", "恢复失败：" + String(error));
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

/**
 * 「立即重启引擎」：恢复只做解包，真正换库发生在 sidecar 启动时，所以恢复完必须重启一次才算生效。
 * 以前这里只写一句「去托盘点重启」，用户很容易以为恢复失败了。
 */
async function onApplyRestoreClicked(): Promise<void> {
  const button = byId("data-restore-apply");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  setText("data-restore-status", "正在重启后台引擎，可能要几秒…");
  try {
    await api.sidecar.restart();
    setText(
      "data-restore-status",
      "已重启，恢复的记忆库已换上。被换下的旧库留在 data/backups（名字是 memories-replaced-…）。",
    );
    if (button instanceof HTMLButtonElement) {
      button.hidden = true;
    }
    await refreshBackups();
  } catch (error: unknown) {
    setText("data-restore-status", "重启失败：" + String(error));
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

async function loadBehaviorToggle(): Promise<void> {
  const input = byId("memory-behavior");
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  try {
    input.checked = (await api.memory.behavior({ enabled: null })).enabled;
  } catch (error: unknown) {
    showBanner("读取行为记忆开关失败：" + String(error));
  }
}

/** 勾选 / 取消后写回设置文件；与「模型供给」同口径，写完由主进程重启后台引擎。 */
async function onBehaviorToggled(input: HTMLInputElement): Promise<void> {
  input.disabled = true;
  try {
    const result = await api.memory.behavior({ enabled: input.checked });
    input.checked = result.enabled;
    showBanner(
      "行为记忆已" + (result.enabled ? "打开" : "关闭") + "（后台引擎已重启，约两秒后生效）",
    );
  } catch (error: unknown) {
    // 写盘失败就把勾选还原，别让界面显示一个并不存在的状态
    input.checked = !input.checked;
    showBanner("保存行为记忆开关失败：" + String(error));
  } finally {
    input.disabled = false;
  }
}

/** 主列表的接线：刷新、清空、导出/恢复、行为记忆开关。 */
export function initMemoryListPane(): void {
  byId("memory-refresh")?.addEventListener("click", () => {
    void refreshMemories();
  });
  byId("memory-clear")?.addEventListener("click", onClearClicked);
  byId("data-export")?.addEventListener("click", () => {
    void onExportDataClicked();
  });
  byId("data-restore")?.addEventListener("click", () => {
    void onRestoreDataClicked();
  });
  byId("data-restore-apply")?.addEventListener("click", () => {
    void onApplyRestoreClicked();
  });
  byId("memory-reset-slider")?.addEventListener("input", updateInitializeGate);
  updateInitializeGate();
  // 行为记忆开关与记忆列表互不依赖：一个在设置文件里，一个在 sidecar 里
  void loadBehaviorToggle();
  byId("memory-behavior")?.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      void onBehaviorToggled(input);
    }
  });
}
