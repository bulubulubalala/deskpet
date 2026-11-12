/**
 * 文件职责：开发者面板的「原文」页——按角色翻历史消息，标出每条有没有被摘要覆盖。
 *
 * 为什么单独一个文件：这一页只读、只关心消息流，和「注入预览」「可编辑事实」没有共同依赖。
 * 依赖方向：renderer/settings 内部；数据走 window.deskpet 白名单。
 */

import type { MemoryMessagesRequest } from "../../../shared/contracts/ipc";
import { api, byId, showBanner } from "../dom";
import { formatMemoryTime } from "../memory";
import { currentDevChar, devState, DEV_RAW_PAGE_SIZE } from "./state";

/**
 * 原文页（T2.3-B1）：拉一页历史原文；append = true 时接在现有列表后面。
 *
 * 只读：原文是压缩链路的输入，改了会让摘要的 covered_by 对不上，所以这里不提供编辑。
 */
export async function refreshDevRaw(append = false): Promise<void> {
  const charId = currentDevChar();
  const host = byId("dev-raw");
  if (charId === null || host === null) {
    return;
  }
  if (!append) {
    devState.rawItems = [];
    devState.rawBefore = null;
    const pending = document.createElement("p");
    pending.className = "placeholder";
    pending.textContent = "正在读取原文…";
    host.replaceChildren(pending);
  }
  try {
    const request: MemoryMessagesRequest = { char_id: charId, limit: DEV_RAW_PAGE_SIZE };
    if (append && devState.rawBefore !== null) {
      request.before_id = devState.rawBefore;
    }
    const response = await api.memory.messages(request);
    devState.rawItems = append ? devState.rawItems.concat(response.items) : response.items;
    devState.rawHasMore = response.has_more;
    const last = devState.rawItems[devState.rawItems.length - 1];
    devState.rawBefore = last === undefined ? null : last.message_id;
    renderDevRaw();
  } catch (error: unknown) {
    showBanner("读取历史原文失败：" + String(error));
  }
}

/** 画原文列表；每条上标一行元信息（角色 / 时间 / token / 有没有被摘要覆盖）。 */
function renderDevRaw(): void {
  const host = byId("dev-raw");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (devState.rawItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "还没有历史原文：先跟这个角色聊几句。";
    host.append(empty);
  }
  for (const item of devState.rawItems) {
    const row = document.createElement("article");
    row.className = "dev-message";
    const meta = document.createElement("p");
    meta.className = "placeholder";
    meta.textContent = [
      "#" + String(item.message_id),
      item.role === "user" ? "用户" : item.role === "assistant" ? "助手" : item.role,
      formatMemoryTime(item.created_at),
      String(item.token_len) + " token",
      item.covered_by === 0 ? "未被摘要覆盖" : "已被摘要 #" + String(item.covered_by) + " 覆盖",
    ].join(" · ");
    const text = document.createElement("p");
    text.textContent = item.text;
    row.append(meta, text);
    host.append(row);
  }
  const more = byId("dev-more");
  if (more instanceof HTMLButtonElement) {
    more.hidden = !devState.rawHasMore;
  }
}
