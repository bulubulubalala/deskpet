/**
 * 文件职责：备份列表的纯展示逻辑——体积、时间、类型标签。没有任何 DOM / window 依赖，可以单测。
 *
 * 为什么单独一个文件：这些换算最容易出错（1024 进制、本地时区、非法值），
 * 抽出来才能在 node 下直接断言，而不是开一个 Electron 窗口肉眼看。
 * 依赖方向：只 import 共享契约的类型；不 import main，不碰 DOM。
 */

import type { DataBackupKind } from "../../../shared/contracts/ipc";

/** kind 是给人看的分类，不参与任何删除决策（删除归各自的保留策略）。 */
export const BACKUP_KIND_LABELS: Record<DataBackupKind, string> = {
  daily: "每日快照",
  before: "操作前留底",
  replaced: "恢复残骸：被换下的旧库",
  rejected: "恢复残骸：打不开的新库",
  other: "认不出的文件",
};

/** 1024 进制、保留一位小数；坏值给 "0 B"。 */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return String(Math.round(bytes)) + " B";
  }
  const mib = bytes / (1024 * 1024);
  if (mib < 1) {
    return (bytes / 1024).toFixed(1) + " KiB";
  }
  return mib.toFixed(1) + " MiB";
}

/** unix 秒 → 本机时区的「2026-11-09 20:15」；坏值给「—」。 */
export function formatBackupTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const date = new Date(seconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}
