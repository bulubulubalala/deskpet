/**
 * 文件职责：扫描 characters/ 目录，列出聊天条「角色切换」弹出层可选的角色。
 *
 * 为什么由主进程直接扫目录：§6.3 的 M1 路由里没有「列角色」接口（导入/管理属 M2），
 * 而角色包本身就是目录结构——直接读 card.json 比等一条新路由更快，也不改契约。
 * 依赖方向：main -> node:fs / node:path + ./ipc（CharacterSummary）。
 * 谁调用：app/main/ui-controller.ts 的 characters()（IPC deskpet:char:list）。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CharacterSummary } from "./ipc";

/** 角色包必需文件（§6.1）；没有它的子目录视为半成品，直接跳过。 */
export const CARD_FILENAME = "card.json";

/** 下划线开头的目录是约定保留位（如 _shared），不当角色看。 */
function looksLikeCharacterDir(name: string): boolean {
  return !name.startsWith("_") && !name.startsWith(".");
}

/**
 * 列出角色：坏包只跳过、不拦整次枚举（体检与报错由 M2 的导入流程负责）。
 * 返回按 char_id 排序，保证弹出层顺序稳定。
 */
export async function listCharacters(charactersDir: string): Promise<readonly CharacterSummary[]> {
  let entries;
  try {
    entries = await readdir(charactersDir, { withFileTypes: true });
  } catch {
    // characters/ 还不存在（首次运行）等价于「一个角色都没有」
    return [];
  }
  const summaries: CharacterSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !looksLikeCharacterDir(entry.name)) {
      continue;
    }
    const display = await readDisplayName(join(charactersDir, entry.name, CARD_FILENAME));
    if (display === null) {
      continue;
    }
    summaries.push({ char_id: entry.name, display_name: display });
  }
  return summaries.sort((left, right) => left.char_id.localeCompare(right.char_id));
}

async function readDisplayName(cardPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(cardPath, "utf8");
  } catch {
    return null;
  }
  let card: unknown;
  try {
    card = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof card !== "object" || card === null) {
    return null;
  }
  const value = (card as Record<string, unknown>)["display_name"];
  return typeof value === "string" && value !== "" ? value : null;
}
