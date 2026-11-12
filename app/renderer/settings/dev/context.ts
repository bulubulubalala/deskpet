/**
 * 文件职责：开发者面板的「注入预览」页——让 sidecar 干跑一次记忆装配，看六段各用了多少预算。
 *
 * 为什么单独一个文件：这一页是只读的装配观察口，和「原文」「可编辑事实」共享的只有角色与状态。
 * 依赖方向：renderer/settings 内部；数据走 window.deskpet 白名单。
 */

import type {
  MemoryContextItem,
  MemoryContextResponse,
  MemoryContextSection,
} from "../../../shared/contracts/ipc";
import { api, byId, showBanner } from "../dom";
import { MEMORY_KIND_LABELS, refreshMemories } from "../memory";
import { currentDevChar } from "./state";

/** 注入页（T2.3-B1）：让 sidecar 干跑一次装配；不调模型、不 mark_used，反复点也不会污染统计。 */
export async function refreshDevContext(): Promise<void> {
  const charId = currentDevChar();
  const host = byId("dev-context");
  if (charId === null || host === null) {
    return;
  }
  const queryInput = byId("dev-query");
  const query = queryInput instanceof HTMLInputElement ? queryInput.value.trim() : "";
  try {
    renderDevContext(await api.memory.context({ char_id: charId, query }));
  } catch (error: unknown) {
    showBanner("预览记忆装配失败：" + String(error));
  }
}

/** 画六段装配：每段报「用了多少 / 预算多少 / 多少条」，最后是原文形态的最终注入文本。 */
function renderDevContext(response: MemoryContextResponse): void {
  const host = byId("dev-context");
  if (host !== null) {
    host.replaceChildren();
    const total = document.createElement("p");
    total.className = "placeholder";
    total.textContent =
      "合计 " +
      String(response.total_tokens) +
      " / " +
      String(response.budget_tokens) +
      " token" +
      (response.dropped.length === 0 ? "" : " · 被裁掉：" + response.dropped.join("、")) +
      (response.injected_ids.length === 0
        ? ""
        : " · 注入记忆 id：" + response.injected_ids.join(","));
    host.append(total);
    for (const section of response.sections) {
      host.append(renderDevSection(section));
    }
  }
  const textHost = byId("dev-context-text");
  if (textHost !== null) {
    textHost.textContent =
      response.text === "" ? "（装配为空：这个角色还没有可注入的内容）" : response.text;
  }
}

/**
 * L0 事实行的「编辑」控件（T2.3-B2）：点开换成 textarea，保存走 PATCH /memory/{id}。
 *
 * 只有 facts 段、ref_id > 0、且不是行为观察（kind=action）的行才给编辑：行为观察是从
 * usage.db 派生的，sidecar 也会拒，界面上干脆不露。
 */
function buildMemoryEditControls(item: MemoryContextItem, text: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "row";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn-ghost btn-sm";
  edit.textContent = "编辑";
  box.append(edit);

  edit.addEventListener("click", () => {
    const area = document.createElement("textarea");
    area.className = "memory-edit";
    area.value = item.text;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary btn-sm";
    save.textContent = "保存";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-ghost btn-sm";
    cancel.textContent = "取消";
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    actions.append(save, cancel);
    text.replaceWith(area);
    box.replaceWith(actions);

    cancel.addEventListener("click", () => {
      area.replaceWith(text);
      actions.replaceWith(box);
    });
    save.addEventListener("click", () => {
      void saveMemoryEdit(item.ref_id, area.value, save, cancel);
    });
  });
  return box;
}

/** 保存一次编辑；失败只在这块面板提示，不弹全局错误（与记忆面板同一口径）。 */
async function saveMemoryEdit(
  memoryId: number,
  text: string,
  ...buttons: HTMLButtonElement[]
): Promise<void> {
  const body = text.trim();
  if (body === "") {
    showBanner("记忆内容不能是空的。");
    return;
  }
  for (const button of buttons) {
    button.disabled = true;
  }
  try {
    const result = await api.memory.edit({ memory_id: memoryId, text: body });
    if (!result.updated) {
      showBanner("这条记忆已经不在了（可能刚被删掉）。");
    } else if (result.merged) {
      showBanner("改完与同角色另一条重复，已经并成一条。");
    } else {
      showBanner("已保存这条记忆，下一轮注入就用新内容。");
    }
  } catch (error: unknown) {
    showBanner("保存记忆失败：" + String(error));
    for (const button of buttons) {
      button.disabled = false;
    }
    return;
  }
  await refreshDevContext();
  await refreshMemories();
}

/** 一段的 DOM：标题行 + 每条内容（ref_id / 种类 / 角色 / 重要度 / token）。 */
function renderDevSection(section: MemoryContextSection): HTMLElement {
  const box = document.createElement("section");
  box.className = "dev-section";
  const head = document.createElement("p");
  head.className = "placeholder";
  head.textContent =
    section.title +
    "（" +
    section.name +
    "）：" +
    String(section.used_tokens) +
    " / " +
    String(section.budget_tokens) +
    " token · " +
    String(section.items.length) +
    " 条" +
    (section.dropped ? " · 已被裁掉" : "");
  box.append(head);
  for (const item of section.items) {
    const row = document.createElement("article");
    row.className = "dev-message";
    const meta = document.createElement("p");
    meta.className = "placeholder";
    meta.textContent = [
      item.ref_id === 0 ? "" : "#" + String(item.ref_id),
      item.kind === "" ? "" : (MEMORY_KIND_LABELS[item.kind] ?? item.kind),
      item.role === "" ? "" : item.role,
      item.importance === 0 ? "" : "重要度 " + item.importance.toFixed(2),
      String(item.tokens) + " token",
    ]
      .filter((part) => part !== "")
      .join(" · ");
    const text = document.createElement("p");
    text.textContent = item.text;
    row.append(meta, text);
    if (section.name === "facts" && item.ref_id > 0 && item.kind !== "action") {
      row.append(buildMemoryEditControls(item, text));
    }
    box.append(row);
  }
  return box;
}
