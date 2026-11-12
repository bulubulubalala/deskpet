/**
 * 文件职责：设置窗「记忆 → 备份与迁移」里的备份可见性——列出 data/backups 里的文件、立即备份、打开数据目录。
 *
 * 为什么单独一个文件：这块只跟磁盘上的备份文件打交道，不认识记忆条目、角色或语义索引；
 * 混进 list.ts 会让「记忆列表」和「磁盘上的后悔药」两套概念互相牵连。
 * 依赖方向：renderer -> ../dom、../../../shared/contracts；不 import main，不碰别的面板的 DOM。
 */

import type { DataBackupsResult } from "../../../shared/contracts/ipc";
import { api, byId, setText } from "../dom";
import { BACKUP_KIND_LABELS, formatBackupSize, formatBackupTime } from "./backup-format";

/** 列表里最多显示几条：更旧的仍在磁盘上，只是不必挤在这里。 */
const MAX_ROWS = 8;

/**
 * 读备份目录的重试次数与间隔。
 * 「恢复后立即重启引擎」返回时新 sidecar 可能还没开始接请求，一次失败就写死错误会让
 * 用户看不到刚生成的 memories-replaced-…；心跳 2 秒一拍，这里给足 3 秒。
 */
const REFRESH_ATTEMPTS = 6;
const REFRESH_RETRY_MS = 600;

function row(entry: DataBackupsResult["entries"][number]): HTMLElement {
  const element = document.createElement("div");
  element.className = "backup-row";

  const time = document.createElement("span");
  time.className = "backup-time";
  time.textContent = formatBackupTime(entry.modified_at);

  const file = document.createElement("span");
  file.className = "backup-file";
  file.textContent = entry.file;

  const size = document.createElement("span");
  size.className = "backup-size";
  size.textContent = formatBackupSize(entry.bytes);

  const kind = document.createElement("span");
  kind.className = "backup-kind";
  kind.textContent = BACKUP_KIND_LABELS[entry.kind] ?? BACKUP_KIND_LABELS.other;

  element.append(time, file, size, kind);
  return element;
}

/** 把目录现状画进卡片；空目录要说清「还没备份过」，而不是留一片白。 */
export function renderBackups(result: DataBackupsResult): void {
  const list = byId("data-backup-list");
  if (list === null) {
    return;
  }
  list.replaceChildren();
  if (result.entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "这个目录里还没有备份。点「立即备份」先存一份。";
    list.append(empty);
  } else {
    for (const entry of result.entries.slice(0, MAX_ROWS)) {
      list.append(row(entry));
    }
    if (result.entries.length > MAX_ROWS) {
      const more = document.createElement("p");
      more.className = "field-hint";
      more.textContent =
        "还有 " + String(result.entries.length - MAX_ROWS) + " 份更旧的备份没显示（仍在磁盘上）。";
      list.append(more);
    }
  }
  const where = result.dir === "" ? "" : " · " + result.dir;
  setText(
    "data-backup-summary",
    "共 " +
      String(result.entries.length) +
      " 份，合计 " +
      formatBackupSize(result.total_bytes) +
      where,
  );
}

/** 读一次备份目录；读不到只在这张卡片上说一句，不挡别的面板。 */
export async function refreshBackups(): Promise<void> {
  for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt += 1) {
    try {
      renderBackups(await api.data.backups());
      return;
    } catch (error: unknown) {
      if (attempt === REFRESH_ATTEMPTS) {
        setText("data-backup-summary", "读取备份目录失败：" + String(error));
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, REFRESH_RETRY_MS);
      });
    }
  }
}

async function onBackupNow(): Promise<void> {
  const button = byId("data-backup-now");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  setText("data-backup-status", "正在备份…（库大的话要几秒）");
  try {
    const result = await api.data.backupNow();
    setText(
      "data-backup-status",
      result.path === ""
        ? "这次没做成：记忆库可能还没打开，或磁盘写不进去。"
        : "已备份：" + result.file + "（" + formatBackupSize(result.bytes) + "）",
    );
    await refreshBackups();
  } catch (error: unknown) {
    setText("data-backup-status", "备份失败：" + String(error));
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

async function onOpenDir(): Promise<void> {
  try {
    await api.data.openDir();
  } catch (error: unknown) {
    setText("data-backup-status", "打不开数据目录：" + String(error));
  }
}

/** 记忆面板初始化时挂一次；重复调用不会叠加监听（每次都是新元素/新绑定）。 */
export function initBackupPane(): void {
  byId("data-backup-now")?.addEventListener("click", () => {
    void onBackupNow();
  });
  byId("data-backup-refresh")?.addEventListener("click", () => {
    void refreshBackups();
  });
  byId("data-open-dir")?.addEventListener("click", () => {
    void onOpenDir();
  });
  void refreshBackups();
}
