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

import type {
  CompanionSettings,
  InteractTrigger,
  TouchGesture,
  UiGestureSettings,
  UiStatePatch,
  UiStatePayload,
} from "./ipc";

/** 存档文件名；落在数据目录下（需求 §6.11，data/ 已 gitignore）。 */
export const UI_STATE_FILENAME = "ui.json";

/**
 * 界面存档的结构版本（T2.2 用户反馈第五轮）。
 *
 * 为什么需要它：v1 存档没有 version 字段，而那一版 always_on_top 默认 false；升级到 v2 后
 * 第一次读旧存档要把置顶打开（见 resolveAlwaysOnTop），否则老用户还是「点桌面就消失」。
 */
export const UI_STATE_VERSION = 2;

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
 * 立绘的**显示上限**（用户反馈：立绘窗口太大）。
 *
 * 素材本身可以是 1024×1536（真立绘），但桌面宠物不需要铺满半个屏幕：窗口按「等比缩小到
 * 不超过这个盒子」来算，图片由 CSS `object-fit: contain` 自动缩放——不改素材、不改缩放语义。
 * 420×630 是 2:3 竖图在 1080p 桌面上比较舒服的尺寸（加上聊天条约 722 高）。
 */
export const STAGE_DISPLAY_MAX_WIDTH = 420;
export const STAGE_DISPLAY_MAX_HEIGHT = 630;

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

/**
 * 默认状态：左上角、1×、允许穿透、**置顶**。
 *
 * 为什么置顶默认开（T2.2 用户反馈第五轮）：不置顶时点一下桌面（或任何别的窗口）就会把桌宠盖到
 * 后面，看起来像「窗口消失了」，只能去托盘点一下才回来——桌面宠物本来就该浮在最上面。
 * 想让它待在普通层，在设置窗里把「总是显示在最前面」关掉即可。
 */
/**
 * 手势偏好的默认值（方案 §5.1）：默认只有「点按钮」能进互动模式，五种手势全开。
 *
 * 为什么不默认放开「在立绘上滑一下」：那会在用户只是想摸两下、并不期待回应的时候占用
 * 每分钟 4 次的 LLM 配额（§4.3 第 2 条）；让用户自己想清楚再开，比默认话多好。
 */
export const DEFAULT_GESTURES: UiGestureSettings = {
  triggers: ["button"],
  enabled: ["tap", "stroke", "hold", "knead", "pat"],
};

export const DEFAULT_COMPANION: CompanionSettings = {
  enabled: true,
  screen_enabled: true,
  screen_interval_s: 30,
  screen_display_id: "",
  ocr_enabled: true,
  vision_model: "",
  proactive_enabled: true,
  observe_memory: true,
  app_activity_enabled: true,
  vision_consented: false,
  quiet_hours_start: -1,
  quiet_hours_end: -1,
};

export const DEFAULT_UI_STATE: UiStatePayload = {
  x: 0,
  y: 0,
  scale: SCALE_DEFAULT,
  click_through: true,
  always_on_top: true,
  char_id: null,
  stage_width: PET_STAGE_WIDTH,
  stage_height: PET_STAGE_HEIGHT,
  gestures: DEFAULT_GESTURES,
  companion: DEFAULT_COMPANION,
  tts_enabled: true,
  native_mic_fallback: false,
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
 *
 * 另外套一个**显示上限**（STAGE_DISPLAY_MAX_*）：大素材按等比缩到盒子里，避免
 * 1024×1536 的真立绘把窗口撑到半屏以上（用户反馈）。图片由 CSS `object-fit: contain`
 * 自动跟上，窗口与画面比例不会被拉歪。
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
  const scaledWidth = stageWidth * effective;
  const scaledHeight = stageHeight * effective;
  // 等比缩小到显示盒子里：只缩不放，小素材仍按原尺寸 / 下限走
  const fit = Math.min(
    1,
    STAGE_DISPLAY_MAX_WIDTH / scaledWidth,
    STAGE_DISPLAY_MAX_HEIGHT / scaledHeight,
  );
  return {
    width: Math.max(Math.round(scaledWidth * fit), STAGE_MIN_WIDTH, CHAT_BAR_MIN_WIDTH),
    height: Math.max(Math.round(scaledHeight * fit), STAGE_MIN_HEIGHT) + chatbar,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 手势偏好里的合法值：只认契约里列出的枚举，其余一律当没写（坏存档不该让手势后台崩）。 */
const INTERACT_TRIGGER_VALUES: readonly InteractTrigger[] = ["button", "stroke"];
const TOUCH_GESTURE_VALUES: readonly TouchGesture[] = ["tap", "stroke", "hold", "knead", "pat"];

function isInteractTrigger(value: unknown): value is InteractTrigger {
  return (
    typeof value === "string" && (INTERACT_TRIGGER_VALUES as readonly string[]).includes(value)
  );
}

function isTouchGesture(value: unknown): value is TouchGesture {
  return typeof value === "string" && (TOUCH_GESTURE_VALUES as readonly string[]).includes(value);
}

/** 读手势偏好：数组字段逐个过枚举；整块缺失或全是坏值时退回默认。 */
export function parseGestureSettings(value: unknown): UiGestureSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_GESTURES };
  }
  const record = value as Record<string, unknown>;
  const rawTriggers = Array.isArray(record["triggers"]) ? record["triggers"] : [];
  const rawEnabled = Array.isArray(record["enabled"]) ? record["enabled"] : [];
  const triggers = rawTriggers.filter(isInteractTrigger);
  const enabled = rawEnabled.filter(isTouchGesture);
  return {
    triggers: triggers.length > 0 ? triggers : [...DEFAULT_GESTURES.triggers],
    enabled: enabled.length > 0 ? enabled : [...DEFAULT_GESTURES.enabled],
  };
}

/**
 * 读置顶开关（T2.2 用户反馈第五轮）。
 *
 * v1 存档没有 version 字段，那时 always_on_top 默认 false；直接沿用会让老用户一直遇到
 * 「点桌面就消失」。所以 v1 存档读进来时强制打开一次，之后按存档里的值走。
 */
function resolveAlwaysOnTop(record: Record<string, unknown>): boolean {
  const version = isFiniteNumber(record["version"]) ? Math.round(record["version"]) : 1;
  if (version < UI_STATE_VERSION) {
    return true;
  }
  return typeof record["always_on_top"] === "boolean"
    ? record["always_on_top"]
    : DEFAULT_UI_STATE.always_on_top;
}

/**
 * 逐字段校验存档：坏字段退回默认值，整份坏 JSON 也退回默认值。
 * 为什么不抛错：界面状态丢了只是位置没记住，不该拦住桌宠启动。
 */
function companionBool(
  record: Record<string, unknown>,
  key: keyof CompanionSettings,
  fallback: boolean,
): boolean {
  return typeof record[key] === "boolean" ? record[key] : fallback;
}

function companionInt(
  record: Record<string, unknown>,
  key: keyof CompanionSettings,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = record[key];
  return isFiniteNumber(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback;
}

function companionText(
  record: Record<string, unknown>,
  key: keyof CompanionSettings,
  fallback: string,
): string {
  const value = record[key];
  return typeof value === "string" ? value.trim().slice(0, 128) : fallback;
}

export function parseCompanionSettings(value: unknown): CompanionSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_COMPANION };
  }
  const record = value as Record<string, unknown>;
  const enabled = companionBool(record, "enabled", DEFAULT_COMPANION.enabled);
  const fallback = enabled;
  return {
    enabled,
    screen_enabled: companionBool(record, "screen_enabled", fallback),
    screen_interval_s: companionInt(
      record,
      "screen_interval_s",
      DEFAULT_COMPANION.screen_interval_s,
      2,
      60,
    ),
    screen_display_id: companionText(record, "screen_display_id", ""),
    ocr_enabled: companionBool(record, "ocr_enabled", fallback),
    vision_model: companionText(record, "vision_model", ""),
    proactive_enabled: companionBool(record, "proactive_enabled", fallback),
    observe_memory: companionBool(record, "observe_memory", fallback),
    app_activity_enabled: companionBool(record, "app_activity_enabled", fallback),
    vision_consented: companionBool(record, "vision_consented", false),
    quiet_hours_start: companionInt(record, "quiet_hours_start", -1, -1, 23),
    quiet_hours_end: companionInt(record, "quiet_hours_end", -1, -1, 23),
  };
}

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
    always_on_top: resolveAlwaysOnTop(record),
    char_id: typeof charId === "string" && charId !== "" ? charId : null,
    stage_width: clampStage(record["stage_width"], DEFAULT_UI_STATE.stage_width),
    stage_height: clampStage(record["stage_height"], DEFAULT_UI_STATE.stage_height),
    gestures: parseGestureSettings(record["gestures"]),
    companion: parseCompanionSettings(record["companion"]),
    tts_enabled:
      typeof record["tts_enabled"] === "boolean"
        ? record["tts_enabled"]
        : DEFAULT_UI_STATE.tts_enabled,
    native_mic_fallback:
      typeof record["native_mic_fallback"] === "boolean"
        ? record["native_mic_fallback"]
        : DEFAULT_UI_STATE.native_mic_fallback,
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
  if (patch.gestures !== undefined) {
    next.gestures = parseGestureSettings(patch.gestures);
  }
  if (patch.companion !== undefined) {
    next.companion = parseCompanionSettings(patch.companion);
  }
  if (typeof patch.tts_enabled === "boolean") {
    next.tts_enabled = patch.tts_enabled;
  }
  if (typeof patch.native_mic_fallback === "boolean") {
    next.native_mic_fallback = patch.native_mic_fallback;
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
  // 带上 version：下次启动才知道这份存档是不是旧的（见 UI_STATE_VERSION）
  const payload = { ...state, version: UI_STATE_VERSION };
  await writeFile(temp, JSON.stringify(payload) + "\n", "utf8");
  await rename(temp, file);
}
