/**
 * 文件职责：桌宠主窗的界面状态（位置 / 缩放 / 穿透 / 置顶 / 当前角色）与它的本机存档。
 *
 * 为什么单独成模块：§6.11 要求位置与缩放写 data/ui.json（本机运行时目录、不进角色包），
 * 而「窗口该多大」是纯计算——放在这里就能用 vitest 直接测，不必拉起 Electron。
 * 依赖方向：main -> node:fs / node:path + ./ipc（只 import type，不 import electron）。
 * 谁调用：app/main/ui-controller.ts（读写与套用）、app/main/windows.ts（算主窗尺寸）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { UiStatePatch, UiStatePayload } from "./ipc";

/** 存档文件名；落在数据目录下（需求 §6.11，data/ 已 gitignore）。 */
export const UI_STATE_FILENAME = "ui.json";

/** 立绘缩放范围（§6.11：0.5×–2×，默认 1×）。 */
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export const SCALE_DEFAULT = 1;

/** 立绘包围盒基准尺寸：当前用占位图（D7），M3 接入真实素材后由素材尺寸决定。 */
export const PET_STAGE_WIDTH = 320;
export const PET_STAGE_HEIGHT = 420;

/**
 * 立绘下方聊天条的固定高度与最小宽度（§6.11）。
 *
 * T2.2 修：最小宽度从 320 提到 560、高度从 56 提到 64——320px 时聊天条里的
 * 「麦克风 + 发送 + 打断 + 角色 + 设置 + 暂停 + 语音状态」会把输入框挤成 0 宽，
 * 用户根本看不见自己输入了什么（真机反馈）。窗口宽度取「立绘包围盒 × 缩放」与
 * 这个最小值里的较大者，所以 1× 时窗口宽 560。
 */
export const CHAT_BAR_HEIGHT = 64;
export const CHAT_BAR_MIN_WIDTH = 560;

export const DEFAULT_UI_STATE: UiStatePayload = {
  x: 0,
  y: 0,
  scale: SCALE_DEFAULT,
  click_through: true,
  always_on_top: false,
  char_id: null,
};

/** 缩放钳到 0.5–2；坏值（NaN / 非数）退回默认 1×。 */
export function clampScale(value: number): number {
  if (!Number.isFinite(value)) {
    return SCALE_DEFAULT;
  }
  return Math.min(Math.max(value, SCALE_MIN), SCALE_MAX);
}

/** 主窗内容尺寸 = 立绘包围盒 × 缩放，高度再加聊天条；宽度不低于聊天条最小宽度。 */
export function computePetWindowSize(scale: number): { width: number; height: number } {
  const effective = clampScale(scale);
  return {
    width: Math.max(Math.round(PET_STAGE_WIDTH * effective), CHAT_BAR_MIN_WIDTH),
    height: Math.round(PET_STAGE_HEIGHT * effective) + CHAT_BAR_HEIGHT,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 逐字段校验存档：坏字段退回默认值，整份坏 JSON 也退回默认值。
 * 为什么不抛错：界面状态丢了只是位置没记住，不该拦住桌宠启动。
 */
export function parseUiState(raw: string | null): UiStatePayload {
  if (raw === null || raw.trim() === "") {
    return { ...DEFAULT_UI_STATE };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ...DEFAULT_UI_STATE };
  }
  const record = data as Record<string, unknown>;
  const charId = record["char_id"];
  return {
    x: isFiniteNumber(record["x"]) ? Math.round(record["x"]) : DEFAULT_UI_STATE.x,
    y: isFiniteNumber(record["y"]) ? Math.round(record["y"]) : DEFAULT_UI_STATE.y,
    scale: isFiniteNumber(record["scale"]) ? clampScale(record["scale"]) : DEFAULT_UI_STATE.scale,
    click_through:
      typeof record["click_through"] === "boolean"
        ? record["click_through"]
        : DEFAULT_UI_STATE.click_through,
    always_on_top:
      typeof record["always_on_top"] === "boolean"
        ? record["always_on_top"]
        : DEFAULT_UI_STATE.always_on_top,
    char_id: typeof charId === "string" && charId !== "" ? charId : null,
  };
}

/** 把界面的增量改动并进当前状态；坏值直接忽略（保留原值），不引入新字段。 */
export function applyUiStatePatch(current: UiStatePayload, patch: UiStatePatch): UiStatePayload {
  const next: UiStatePayload = { ...current };
  if (isFiniteNumber(patch.x)) {
    next.x = Math.round(patch.x);
  }
  if (isFiniteNumber(patch.y)) {
    next.y = Math.round(patch.y);
  }
  if (isFiniteNumber(patch.scale)) {
    next.scale = clampScale(patch.scale);
  }
  if (typeof patch.click_through === "boolean") {
    next.click_through = patch.click_through;
  }
  if (typeof patch.always_on_top === "boolean") {
    next.always_on_top = patch.always_on_top;
  }
  if (patch.char_id !== undefined) {
    next.char_id = typeof patch.char_id === "string" && patch.char_id !== "" ? patch.char_id : null;
  }
  return next;
}

export async function readUiState(file: string): Promise<UiStatePayload> {
  try {
    return parseUiState(await readFile(file, "utf8"));
  } catch {
    // 首次运行没有存档属正常路径（§6.11），不是错误
    return { ...DEFAULT_UI_STATE };
  }
}

/** 原子写：先写 .tmp 再 rename，避免崩溃留下半截 JSON（与 runtime.json 同一套做法）。 */
export async function writeUiState(file: string, state: UiStatePayload): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + ".tmp";
  await writeFile(temp, JSON.stringify(state) + "\n", "utf8");
  await rename(temp, file);
}
