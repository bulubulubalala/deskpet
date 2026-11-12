/**
 * 文件职责：读角色包里的立绘与部位定义（hits.json），交给渲染层画与点（T2.3-C2）。
 *
 * 为什么由主进程读文件：渲染层只拿得到 preload 白名单（没有 fs），而渲染层的 CSP 是
 * `img-src 'self' data:`——立绘以 data URL 交给 <img>，不放开 file://、也不加自定义协议。
 * 依赖方向：main -> node:fs/promises / node:path + ./ipc（CharHitRegion）。
 * 谁调用：app/main/ipc-handlers.ts 的两条只读通道（deskpet:char:portrait / :hits）。
 */
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type {
  CharHitRegion,
  CharHitShape,
  CharacterActTarget,
  CharacterAppearance,
  CharacterHitsResponse,
} from "../shared/contracts/ipc";
import {
  COLOR_PATTERN,
  DEFAULT_REGION_COLOR,
  MAX_PORTRAIT_BYTES,
  MAX_REGION_DRAWABLES,
  MAX_REGION_PADDING,
  MAX_REGION_POLY_POINTS,
  MAX_REGION_PRIORITY,
  MAX_REGIONS,
  REGION_NAME_MAX,
} from "../shared/pack-limits";
import { normalizeLookAtOrigin } from "./look-at-origin";

/** appearance.json 的默认立绘（与 sidecar/services/character_store.py 的 DEFAULT_PORTRAIT 对齐）。 */
export const DEFAULT_PORTRAIT_RELATIVE = "assets/portrait.png";
export const APPEARANCE_FILENAME = "appearance.json";
export const HITS_FILENAME = "hits.json";

/** 角色 id 只允许安全字符，防止拼出包目录之外的路径。 */
const CHAR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function portraitRelative(appearance: unknown): string {
  if (typeof appearance !== "object" || appearance === null) {
    return DEFAULT_PORTRAIT_RELATIVE;
  }
  const value = (appearance as Record<string, unknown>)["portrait"];
  return typeof value === "string" && value !== "" ? value : DEFAULT_PORTRAIT_RELATIVE;
}

/** 立绘 → data URL；角色包没有立绘或读不到就返回 null（渲染层保留内置占位图）。 */
export async function readCharacterPortrait(
  charactersDir: string,
  charId: string,
): Promise<string | null> {
  if (!CHAR_ID_PATTERN.test(charId)) {
    return null;
  }
  const packRoot = join(charactersDir, charId);
  const relative = portraitRelative(await readJson(join(packRoot, APPEARANCE_FILENAME)));
  // 相对路径必须落在包内：绝对路径与 `..` 都不认
  if (relative.startsWith("/") || relative.includes("..")) {
    return null;
  }
  const bytes = await readFile(join(packRoot, relative)).catch(() => null);
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_PORTRAIT_BYTES) {
    return null;
  }
  const mime = MIME_BY_EXT[extname(relative).toLowerCase()];
  if (mime === undefined) {
    return null;
  }
  return "data:" + mime + ";base64," + bytes.toString("base64");
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseRegion(entry: unknown, index: number): CharHitRegion | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const rect = record["rect"];
  if (!Array.isArray(rect) || rect.length !== 4) {
    return null;
  }
  const numbers: number[] = [];
  for (const value of rect) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    numbers.push(value);
  }
  const x = numbers[0] ?? 0;
  const y = numbers[1] ?? 0;
  const w = numbers[2] ?? 0;
  const h = numbers[3] ?? 0;
  if (w <= 0 || h <= 0) {
    return null;
  }
  const rawName = typeof record["name"] === "string" ? record["name"] : "";
  const name =
    rawName.replace(/\s+/g, " ").trim().slice(0, REGION_NAME_MAX) || "部位" + (index + 1);
  const rawId = typeof record["id"] === "string" ? record["id"] : "";
  const id = rawId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "region-" + (index + 1);
  const colorValue = typeof record["color"] === "string" ? record["color"] : "";
  const color = COLOR_PATTERN.test(colorValue) ? colorValue : DEFAULT_REGION_COLOR;
  const actValue = typeof record["act"] === "string" ? record["act"] : "";
  return {
    id,
    name,
    rect: [clamp01(x), clamp01(y), clamp01(w), clamp01(h)],
    color,
    act: actValue.slice(0, 32),
    ...optionalRegionFields(record),
  };
}

/**
 * v2 的可选扩展字段（T2.42）：priority / padding / shape / drawables。
 *
 * 坏值一律丢掉而不是整条丢弃——老的手写 hits.json 没有这些键，写错了也不该让人物
 * 突然点不到；缺省行为与重制前完全一致（矩形 + 0 容差 + 优先级 0）。
 */
function optionalRegionFields(record: Record<string, unknown>): Partial<CharHitRegion> {
  const result: Partial<CharHitRegion> = {};
  const priority = record["priority"];
  if (typeof priority === "number" && Number.isFinite(priority)) {
    result.priority = Math.round(Math.min(MAX_REGION_PRIORITY, Math.max(0, priority)));
  }
  const padding = record["padding"];
  if (typeof padding === "number" && Number.isFinite(padding) && padding > 0) {
    result.padding = Math.min(MAX_REGION_PADDING, padding);
  }
  const shape = parseRegionShape(record["shape"]);
  if (shape !== undefined) {
    result.shape = shape;
  }
  const drawables = parseRegionDrawables(record["drawables"]);
  if (drawables !== undefined) {
    result.drawables = drawables;
  }
  return result;
}

/** [x, y, w, h] 校验：四个有限数、宽高为正；不合格返回 null。 */
function parseRectValue(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return null;
    }
    numbers.push(item);
  }
  const [x, y, w, h] = numbers as [number, number, number, number];
  if (w <= 0 || h <= 0) {
    return null;
  }
  return [clamp01(x), clamp01(y), clamp01(w), clamp01(h)];
}

/** shape 字段：矩形 / 椭圆认 rect，多边形认 points（少于 3 个有效顶点就当没写）。 */
function parseRegionShape(value: unknown): CharHitShape | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind === "rect" || kind === "ellipse") {
    const rect = parseRectValue(record["rect"]);
    return rect === null ? undefined : { kind, rect };
  }
  if (kind !== "poly") {
    return undefined;
  }
  const raw = record["points"];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const points: [number, number][] = [];
  for (const entry of raw.slice(0, MAX_REGION_POLY_POINTS)) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const [px, py] = entry as [unknown, unknown];
    if (
      typeof px !== "number" ||
      typeof py !== "number" ||
      !Number.isFinite(px) ||
      !Number.isFinite(py)
    ) {
      continue;
    }
    points.push([clamp01(px), clamp01(py)]);
  }
  return points.length >= 3 ? { kind: "poly", points } : undefined;
}

/** drawables 字段：去空、去重、截断；一个有效的都没有就当没写。 */
function parseRegionDrawables(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids: string[] = [];
  for (const entry of value.slice(0, MAX_REGION_DRAWABLES)) {
    if (typeof entry !== "string") {
      continue;
    }
    const id = entry.trim().slice(0, 64);
    if (id !== "" && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids.length === 0 ? undefined : ids;
}

/**
 * hits.json → 部位列表 + 视觉原点。
 *
 * 没有 / 坏格式一律空列表 + null 原点（点不到也不该拦住别的功能）；
 * 视觉原点是顶层字段，不混进 regions[]，避免影响触摸命中与 usage 记账（T2.28）。
 */
export async function readCharacterHits(
  charactersDir: string,
  charId: string,
): Promise<CharacterHitsResponse> {
  if (!CHAR_ID_PATTERN.test(charId)) {
    return { regions: [], look_at_origin: null };
  }
  const raw = await readJson(join(charactersDir, charId, HITS_FILENAME));
  if (typeof raw !== "object" || raw === null) {
    return { regions: [], look_at_origin: null };
  }
  const record = raw as Record<string, unknown>;
  const regions = record["regions"];
  const parsed: CharHitRegion[] = [];
  if (Array.isArray(regions)) {
    regions.slice(0, MAX_REGIONS).forEach((entry, index) => {
      const region = parseRegion(entry, index);
      if (region !== null) {
        parsed.push(region);
      }
    });
  }
  return {
    regions: parsed,
    look_at_origin: normalizeLookAtOrigin(record["look_at_origin"]),
  };
}

/** 只保留值为字符串的键：角色包里的映射表可能混进数字 / null，坏项直接丢。 */
function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function actTarget(value: unknown): CharacterActTarget | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    live2d: typeof record["live2d"] === "string" ? record["live2d"] : null,
    png: typeof record["png"] === "string" ? record["png"] : null,
  };
}

/** acts 映射：act 名 → { live2d, png }；坏项丢掉（缺一个 act 只影响那一个动作）。 */
function hitBoxOf(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return null;
    }
    numbers.push(item);
  }
  const [x = 0, y = 0, w = 0, h = 0] = numbers;
  if (w <= 0 || h <= 0) {
    return null;
  }
  const left = Math.min(Math.max(x, 0), 1);
  const top = Math.min(Math.max(y, 0), 1);
  return [left, top, Math.min(w, 1 - left), Math.min(h, 1 - top)];
}

function actMap(value: unknown): Record<string, CharacterActTarget> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const result: Record<string, CharacterActTarget> = {};
  for (const [key, item] of Object.entries(value)) {
    const target = actTarget(item);
    if (target !== null) {
      result[key] = target;
    }
  }
  return result;
}

/**
 * appearance.json → 渲染层要的形象配置（T2.4 Stage 抽象层）。
 *
 * 为什么单独一条通道：渲染层现在要按 stage 选 PNG / Live2D 实现、按 acts 播动作，
 * 而它拿不到 fs——主进程把整份投影读好递过去，渲染层只做「怎么画」。
 * 读不到 / 坏格式返回 null：渲染层回退内置占位图，不阻断别的功能。
 */
export async function readCharacterAppearance(
  charactersDir: string,
  charId: string,
): Promise<CharacterAppearance | null> {
  if (!CHAR_ID_PATTERN.test(charId)) {
    return null;
  }
  const raw = await readJson(join(charactersDir, charId, APPEARANCE_FILENAME));
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const stage = record["stage"];
  return {
    stage: stage === "live2d" || stage === "hybrid" ? stage : "png",
    portrait: typeof record["portrait"] === "string" ? record["portrait"] : null,
    model: typeof record["model"] === "string" ? record["model"] : null,
    png_fallback: typeof record["png_fallback"] === "string" ? record["png_fallback"] : null,
    hit_box: hitBoxOf(record["hit_box"]),
    motions: stringMap(record["motions"]),
    expressions: stringMap(record["expressions"]),
    acts: actMap(record["acts"]),
  };
}
