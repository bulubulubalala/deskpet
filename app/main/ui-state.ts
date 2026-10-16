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

/**
 * 立绘包围盒的默认尺寸：当前是占位图的真实像素尺寸（D7，128×128）。
 *
 * T2.2 修：以前这里写死 320×420（一个与素材无关的基准框），窗口尺寸于是与素材脱钩；
 * 现在窗口尺寸 = 立绘包围盒 × 缩放 + 聊天条（§6.11），包围盒由渲染层量出来上报（PNG 用
 * 自然尺寸，M3 之后是 Live2D 模型的包围盒），上一回的测量结果存在 ui.json 里。
 */
export const PET_STAGE_WIDTH = 128;
export const PET_STAGE_HEIGHT = 128;

/** 包围盒合法上限：坏数据或超大素材不该把窗口铺满桌面。 */
export const STAGE_MAX = 2048;

/** 立绘区下限：气泡要放得下，立绘再小也得留出可视范围（§6.11）。 */
export const STAGE_MIN_WIDTH = 240;
export const STAGE_MIN_HEIGHT = 240;

/**
 * 聊天条的默认高度与最小宽度（§6.11）。
 *
 * T2.2 修：聊天条改成两行——输入框在上面（自动换行、会变高），按钮在下面一行，
 * 于是最小宽度从 560 降到 400（不再和输入框抢横向空间），默认高度 92px（两行 + 内边距）。
 * 真实高度由渲染层实测上报后覆盖（输入框长高时它会变，见 app/renderer/index.ts）。
 */
export const CHAT_BAR_HEIGHT = 92;
export const CHAT_BAR_MIN_WIDTH = 400;

/** 上报高度只接受这个区间：太小会把输入框压没，太大是坏数据。 */
export const CHAT_BAR_HEIGHT_MIN = 56;
export const CHAT_BAR_HEIGHT_MAX = 320;

export const DEFAULT_UI_STATE: UiStatePayload = {
  x: 0,
  y: 0,
  scale: SCALE_DEFAULT,
  click_through: true,
  always_on_top: false,
  char_id: null,
  stage_width: PET_STAGE_WIDTH,
  stage_height: PET_STAGE_HEIGHT,
};

/** 缩放钳到 0.5–2；坏值（NaN / 非数）退回默认 1×。 */
export function clampScale(value: number): number {
  if (!Number.isFinite(value)) {
    return SCALE_DEFAULT;
  }
  return Math.min(Math.max(value, SCALE_MIN), SCALE_MAX);
}

/** 包围盒合法化：非数 / 非正数退回默认，超过上限截到 STAGE_MAX（可能是渲染层报来的坏值）。 */
export function clampStage(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.round(value), STAGE_MAX);
}

/** 上报的聊天条高度合法化：坏值退回默认高度，越界截到区间边界。 */
export function clampChatbarHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CHAT_BAR_HEIGHT;
  }
  return Math.min(Math.max(Math.round(value), CHAT_BAR_HEIGHT_MIN), CHAT_BAR_HEIGHT_MAX);
}

/**
 * 主窗内容尺寸 = 立绘包围盒 × 缩放 + 聊天条（§6.11）。
 *
 * 宽度还要不低于立绘区下限与聊天条最小宽度——这两个下限是「再小就摆不下东西」，
 * 与素材本身的尺寸无关；素材比下限大时窗口就跟着素材走。
 */
export function computePetWindowSize(
  scale: number,
  stage: { width: number; height: number } = { width: PET_STAGE_WIDTH, height: PET_STAGE_HEIGHT },
  chatbarHeight: number = CHAT_BAR_HEIGHT,
): { width: number; height: number } {
  const effective = clampScale(scale);
  const stageWidth = clampStage(stage.width, PET_STAGE_WIDTH);
  const stageHeight = clampStage(stage.height, PET_STAGE_HEIGHT);
  const chatbar = clampChatbarHeight(chatbarHeight);
  return {
    width: Math.max(Math.round(stageWidth * effective), STAGE_MIN_WIDTH, CHAT_BAR_MIN_WIDTH),
    height: Math.max(Math.round(stageHeight * effective), STAGE_MIN_HEIGHT) + chatbar,
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
    stage_width: clampStage(record["stage_width"], DEFAULT_UI_STATE.stage_width),
    stage_height: clampStage(record["stage_height"], DEFAULT_UI_STATE.stage_height),
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
