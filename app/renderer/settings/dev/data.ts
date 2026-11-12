/**
 * 文件职责：开发者面板的「可编辑事实」页——事实 L0、摘要 L1/L2/L3、原文三块都能就地改/删。
 *
 * 为什么单独一个文件：这页是唯一会写记忆的地方，把「编辑一阵、保存、整页重拉」的循环收在一处。
 * 依赖方向：renderer/settings 内部；数据走 window.deskpet 白名单。
 */

import type {
  MemoryItem,
  MemoryMessageItem,
  MemorySummaryItem,
} from "../../../shared/contracts/ipc";
import { api, byId, showBanner } from "../dom";
import { formatMemoryTime } from "../memory";
import { currentDevChar } from "./state";

/** 一条可编辑记录：默认显示文本；编辑时换成 textarea，保存后刷新整个数据页。 */
export function devEditableRow(
  metaText: string,
  text: string,
  onSave: (next: string) => Promise<void>,
  onDelete: (() => Promise<void>) | null,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "dev-message";
  const meta = document.createElement("p");
  meta.className = "placeholder";
  meta.textContent = metaText;
  const body = document.createElement("p");
  body.textContent = text;
  const actions = document.createElement("div");
  actions.className = "row";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn-ghost btn-sm";
  edit.textContent = "编辑";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-danger btn-sm";
  remove.textContent = "删除";
  actions.append(edit);
  if (onDelete !== null) {
    actions.append(remove);
  }
  row.append(meta, body, actions);

  edit.addEventListener("click", () => {
    const area = document.createElement("textarea");
    area.className = "memory-edit";
    area.value = text;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary btn-sm";
    save.textContent = "保存";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-ghost btn-sm";
    cancel.textContent = "取消";
    const editActions = document.createElement("div");
    editActions.className = "row";
    editActions.append(save, cancel);
    body.replaceWith(area);
    actions.replaceWith(editActions);
    cancel.addEventListener("click", () => {
      area.replaceWith(body);
      editActions.replaceWith(actions);
    });
    save.addEventListener("click", () => {
      save.disabled = true;
      const next = area.value.trim();
      if (next === "") {
        showBanner("内容不能为空。");
        save.disabled = false;
        return;
      }
      void onSave(next)
        .then(() => void refreshDevData())
        .catch((error: unknown) => {
          showBanner("保存记忆失败：" + String(error));
          save.disabled = false;
        });
    });
  });
  if (onDelete !== null) {
    remove.addEventListener("click", () => {
      if (!window.confirm("确认删除这条记录？此操作不可撤销。")) {
        return;
      }
      remove.disabled = true;
      void onDelete()
        .then(() => void refreshDevData())
        .catch((error: unknown) => {
          showBanner("删除记忆失败：" + String(error));
          remove.disabled = false;
        });
    });
  }
  return row;
}

export function devSection(title: string, hint: string, rows: readonly HTMLElement[]): HTMLElement {
  const box = document.createElement("section");
  box.className = "dev-section";
  const head = document.createElement("p");
  head.className = "placeholder";
  head.textContent = title + " · " + hint;
  box.append(head, ...rows);
  return box;
}

/** 拉这个角色的三块数据并整页重画；失败就把原因写进面板，不弹全局错误。 */
export async function refreshDevData(): Promise<void> {
  const charId = currentDevChar();
  const host = byId("dev-data");
  if (charId === null || host === null) {
    return;
  }
  host.replaceChildren();
  const pending = document.createElement("p");
  pending.className = "placeholder";
  pending.textContent = "正在读取记忆数据…";
  host.append(pending);
  try {
    const [facts, summaries, messages] = await Promise.all([
      api.memory.list({ char_id: charId, limit: 200 }),
      api.memory.summaries({ char_id: charId, limit: 200 }),
      api.memory.messages({ char_id: charId, limit: 100 }),
    ]);
    const factRows = facts.items.map((item: MemoryItem) =>
      devEditableRow(
        "#" +
          String(item.id) +
          " · " +
          item.kind +
          " · " +
          item.tier +
          " · 重要度 " +
          item.importance.toFixed(2),
        item.text,
        async (text) => {
          await api.memory.edit({ memory_id: item.id, text });
        },
        async () => {
          await api.memory.remove({ memory_id: item.id });
        },
      ),
    );
    const summaryRows = summaries.items.map((item: MemorySummaryItem) =>
      devEditableRow(
        "#" +
          String(item.id) +
          " · L" +
          String(item.tier) +
          " · " +
          item.covers_from +
          " → " +
          item.covers_to,
        item.text,
        async (text) => {
          await api.memory.editSummary({ summary_id: item.id, text });
        },
        async () => {
          await api.memory.deleteSummary(item.id);
        },
      ),
    );
    const messageRows = messages.items.map((item: MemoryMessageItem) =>
      devEditableRow(
        "#" +
          String(item.message_id) +
          " · " +
          (item.role === "user" ? "用户" : "助手") +
          " · " +
          formatMemoryTime(item.created_at) +
          (item.covered_by === 0 ? " · 未覆盖" : " · 摘要 #" + String(item.covered_by)),
        item.text,
        async (text) => {
          await api.memory.editMessage({ message_id: item.message_id, text });
        },
        async () => {
          await api.memory.deleteMessage(item.message_id);
        },
      ),
    );
    host.replaceChildren(
      devSection("事实（L0）", String(facts.items.length) + " 条", factRows),
      devSection("摘要（L1/L2/L3）", String(summaries.items.length) + " 条", summaryRows),
      devSection("原文（L0）", String(messages.items.length) + " 条", messageRows),
    );
  } catch (error: unknown) {
    host.replaceChildren();
    const failed = document.createElement("p");
    failed.className = "placeholder";
    failed.textContent = "读取记忆数据失败：" + String(error);
    host.append(failed);
  }
}
