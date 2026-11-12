/**
 * 文件职责：角色包编辑器的「规则」——校验 char_id / 图片、归一化部位、生成要落盘的 JSON 内容。
 *
 * 为什么与读写分开：这些函数全是纯的（同样输入必得同样输出），能脱开磁盘单测；
 * 落盘顺序、拒绝覆盖、临时文件改名那些「会失败」的部分留在 ../pack-editor.ts。
 * 依赖方向：main -> 本文件 -> shared/contracts 的类型 + ./look-at-origin；不碰 fs、不碰 electron。
 */
import type { CharHitShape, PackRegionDraft, PackSaveRequest } from "../../shared/contracts/ipc";
import {
  CARD_TEXT_MAX,
  DEFAULT_REGION_COLOR,
  MAX_PORTRAIT_BYTES,
  MAX_REGION_DRAWABLES,
  MAX_REGION_PADDING,
  MAX_REGION_POLY_POINTS,
  MAX_REGION_PRIORITY,
  MAX_REGIONS,
  PACK_ID_PATTERN,
  REGION_NAME_MAX,
} from "../../shared/pack-limits";
import { DEFAULT_LOOK_AT_ORIGIN, normalizeLookAtOrigin } from "../look-at-origin";

/** char_id 的规则文字提示；正则本身在 shared/pack-limits（写入、读取、界面三处共用一份）。 */
export const PACK_ID_HINT =
  "char_id 只能是字母 / 数字 / 下划线 / 短横，最长 64 字，且不能以 _ 或 . 开头";
/** 写盘规则统一从 shared/pack-limits 来；这里重新导出，保持既有 import 路径不变。 */
export {
  CARD_TEXT_MAX,
  DEFAULT_REGION_COLOR,
  MAX_PORTRAIT_BYTES,
  MAX_REGION_PADDING,
  MAX_REGION_POLY_POINTS,
  MAX_REGION_PRIORITY,
  MAX_REGIONS,
  PACK_ID_PATTERN,
  REGION_NAME_MAX,
};
/** personality / speaking_style 在卡片里必填，界面允许留空，那就写一句占位而不是空字符串。 */
export const DEFAULT_PERSONALITY = "（还没有写人格：下次编辑角色包时补上。）";
export const DEFAULT_SPEAKING_STYLE = "（还没有写说话风格：下次编辑角色包时补上。）";

const IMAGE_MAGIC: readonly { readonly mime: string; readonly bytes: readonly number[] }[] = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

export interface DecodedImage {
  readonly mime: string;
  readonly data: Buffer;
}

export interface PackTextFile {
  readonly name: string;
  readonly content: string;
}

export interface PackFileSet {
  /** 立绘在角色包里的相对路径（按真实 mime 定扩展名，别把 jpg 写成 .png）。 */
  readonly portraitName: string;
  readonly files: readonly PackTextFile[];
}

export interface PackSaveResult {
  readonly ok: boolean;
  readonly char_id: string;
  readonly error: string;
  readonly files: readonly string[];
}

/** 校验 char_id：合法返回 null，否则返回给用户看的一句话。 */
export function validatePackId(raw: string): string | null {
  const id = raw.trim();
  if (id === "") {
    return "先填一个 char_id（英文，会当作 characters/ 下的目录名）。";
  }
  if (!PACK_ID_PATTERN.test(id)) {
    return PACK_ID_HINT + "。";
  }
  return null;
}

/** 按 mime 给立绘定扩展名；未知 mime 回退 png（调用方已经用 decodeImageDataUrl 挡过）。 */
export function imageExtension(mime: string): string {
  if (mime === "image/jpeg") {
    return "jpg";
  }
  if (mime === "image/webp") {
    return "webp";
  }
  return "png";
}

/**
 * data URL -> 字节。只认 png / jpeg / webp，且必须与文件头一致（扩展名骗人的图不写进包里）。
 * 失败返回 null：调用方统一回一句「图片不是 PNG / JPEG / WebP，或超过 8 MiB」。
 */
export function decodeImageDataUrl(dataUrl: string): DecodedImage | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (match === null) {
    return null;
  }
  const mime = match[1] ?? "";
  const encoded = match[2] ?? "";
  let data: Buffer;
  try {
    data = Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
  if (data.byteLength === 0 || data.byteLength > MAX_PORTRAIT_BYTES) {
    return null;
  }
  const magic = IMAGE_MAGIC.find((entry) => entry.mime === mime);
  if (magic === undefined) {
    return null;
  }
  const ok = magic.bytes.every((byte, index) => data[index] === byte);
  // webp 还要看 RIFF 之后第 8 字节起的 "WEBP"：只看 RIFF 会把 wav 也放进来
  const webpOk = mime !== "image/webp" || data.subarray(8, 12).toString("latin1") === "WEBP";
  return ok && webpOk ? { mime, data } : null;
}
function clampUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 与 app/renderer/editor.ts 的默认部位名一致：编辑器一进来就有的那个全身框。 */
export const BODY_REGION_NAME = "身体";

/** 部位 id：中文名没有可用的 ascii 部分就用 regionN，重名再补后缀（char_hits 表按它记账）。 */
export function regionId(name: string, index: number, taken: ReadonlySet<string>): string {
  // 默认的全身框固定叫 body：否则它也是中文名，会在 char_hits 里变成看不懂的 region1
  const base = name === BODY_REGION_NAME ? "body" : slugOf(name) || "region" + String(index + 1);
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(base + "-" + String(suffix))) {
    suffix += 1;
  }
  return base + "-" + String(suffix);
}

/** 0–1 的有限数字；非法给 null（形状字段用，缺一个点就整块作废）。 */
function unitOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? clampUnit(value, 0) : null;
}

/** 四个 0–1 数字组成的外接矩形；宽高必须为正，否则整块形状作废。 */
function rectOrNull(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const [x = null, y = null, w = null, h = null] = value.map(unitOrNull);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
    return null;
  }
  return [x, y, w, h];
}

/** 形状字段归一化：坏值整块丢掉（运行时于是回退到 rect），不做半信半疑的修补。 */
function shapeOrNull(value: unknown): CharHitShape | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind === "poly") {
    const points = record["points"];
    if (!Array.isArray(points)) {
      return null;
    }
    const kept: [number, number][] = [];
    for (const point of points.slice(0, MAX_REGION_POLY_POINTS)) {
      if (!Array.isArray(point) || point.length !== 2) {
        continue;
      }
      const x = unitOrNull(point[0]);
      const y = unitOrNull(point[1]);
      if (x === null || y === null) {
        continue;
      }
      kept.push([x, y]);
    }
    return kept.length >= 3 ? { kind: "poly", points: kept } : null;
  }
  if (kind === "rect" || kind === "ellipse") {
    const rect = rectOrNull(record["rect"]);
    return rect === null ? null : { kind, rect };
  }
  return null;
}

/** 网格 id 列表：去空白、去重、截上限；空列表等于没配。 */
function drawablesOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const kept: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const id = item.trim();
    if (id === "" || kept.includes(id)) {
      continue;
    }
    kept.push(id);
    if (kept.length >= MAX_REGION_DRAWABLES) {
      break;
    }
  }
  return kept.length === 0 ? null : kept;
}

/**
 * 把 v2 的可选字段原样搬运（T2.44）。
 *
 * 为什么需要它：部位草稿早先只有 id/name/rect/color/act 五个键，编辑器一保存就把
 * priority / padding / shape / drawables 洗掉了 —— 用户只是拖了一下框，Live2D 的动态命中
 * 就退回死矩形。这里按 character-assets.ts 的读取上限夹一遍，保证写进去的读得回来。
 */
export function optionalFieldsOf(source: {
  priority?: unknown;
  padding?: unknown;
  shape?: unknown;
  drawables?: unknown;
}): Pick<PackRegionDraft, "priority" | "padding" | "shape" | "drawables"> {
  const extras: Pick<PackRegionDraft, "priority" | "padding" | "shape" | "drawables"> = {};
  if (typeof source.priority === "number" && Number.isFinite(source.priority)) {
    extras.priority = Math.min(MAX_REGION_PRIORITY, Math.max(0, Math.round(source.priority)));
  }
  if (typeof source.padding === "number" && Number.isFinite(source.padding) && source.padding > 0) {
    extras.padding = Math.min(MAX_REGION_PADDING, source.padding);
  }
  const shape = shapeOrNull(source.shape);
  if (shape !== null) {
    extras.shape = shape;
  }
  const drawables = drawablesOrNull(source.drawables);
  if (drawables !== null) {
    extras.drawables = drawables;
  }
  return extras;
}

/** hits.json 的内容：可选字段只在有值时出现，缺省行为与旧版完全一致。 */
export function hitsOf(
  regions: readonly PackRegionDraft[],
  lookAtOrigin: readonly [number, number],
): Record<string, unknown> {
  return {
    version: 2,
    look_at_origin: [lookAtOrigin[0], lookAtOrigin[1]],
    regions: regions.map((region) => ({
      id: region.id,
      name: region.name,
      rect: region.rect,
      color: region.color,
      act: region.act,
      ...optionalFieldsOf(region),
    })),
  };
}

/** 归一化草稿：矩形夹到 0–1、空名字补「部位 N」、颜色非法回退。 */
export function normalizeRegions(regions: readonly PackRegionDraft[]): PackRegionDraft[] {
  const taken = new Set<string>();
  const result: PackRegionDraft[] = [];
  for (const [index, region] of regions.slice(0, MAX_REGIONS).entries()) {
    const name = (region.name.trim() || "部位 " + String(index + 1)).slice(0, REGION_NAME_MAX);
    const id = regionId(name, index, taken);
    taken.add(id);
    const [x = 0, y = 0, w = 0, h = 0] = region.rect;
    const width = Math.max(0.02, clampUnit(w, 0.02));
    const height = Math.max(0.02, clampUnit(h, 0.02));
    const rect: [number, number, number, number] = [
      clampUnit(x, 0),
      clampUnit(y, 0),
      Math.min(width, 1 - clampUnit(x, 0)),
      Math.min(height, 1 - clampUnit(y, 0)),
    ];
    const color = /^#[0-9a-fA-F]{6}$/.test(region.color) ? region.color : DEFAULT_REGION_COLOR;
    result.push({ id, name, rect, color, act: region.act, ...optionalFieldsOf(region) });
  }
  return result;
}

/** 已有 region id 的形状：usage.db 的 char_hits 按它记账，编辑时必须尽量保留。 */
const REGION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 编辑模式下的部位归一化：**保留已有 id**（改名不换 id），新框才按名字派生。
 * 其余夹取规则与新建一致；重名 / 非法 id 会被换掉，保证落盘唯一。
 */
export function normalizeRegionsForUpdate(regions: readonly PackRegionDraft[]): PackRegionDraft[] {
  const taken = new Set<string>();
  const result: PackRegionDraft[] = [];
  for (const [index, region] of regions.slice(0, MAX_REGIONS).entries()) {
    const name = (region.name.trim() || "部位 " + String(index + 1)).slice(0, REGION_NAME_MAX);
    const wanted = region.id.trim();
    const id =
      REGION_ID_PATTERN.test(wanted) && !taken.has(wanted) ? wanted : regionId(name, index, taken);
    taken.add(id);
    const [x = 0, y = 0, w = 0, h = 0] = region.rect;
    const width = Math.max(0.02, clampUnit(w, 0.02));
    const height = Math.max(0.02, clampUnit(h, 0.02));
    const rect: [number, number, number, number] = [
      clampUnit(x, 0),
      clampUnit(y, 0),
      Math.min(width, 1 - clampUnit(x, 0)),
      Math.min(height, 1 - clampUnit(y, 0)),
    ];
    const color = /^#[0-9a-fA-F]{6}$/.test(region.color) ? region.color : DEFAULT_REGION_COLOR;
    result.push({
      id,
      name,
      rect,
      color,
      act: region.act.trim().slice(0, 32),
      ...optionalFieldsOf(region),
    });
  }
  return result;
}
/** 生成 card.json / pack.json / appearance.json / hits.json 的内容（纯函数，便于对拍）。 */
export function buildPackFiles(request: PackSaveRequest, mime: string): PackFileSet {
  const charId = request.char_id.trim();
  const displayName = request.display_name.trim() || charId;
  const description = request.description.trim().slice(0, CARD_TEXT_MAX);
  const regions = normalizeRegions(request.regions);
  const portraitName = "assets/portrait." + imageExtension(mime);
  const acts: Record<string, { live2d: string; png: string }> = {};
  for (const region of regions) {
    const act = region.act.trim();
    if (act !== "") {
      acts[act] = { live2d: "M_" + act, png: "fade" };
    }
  }
  const card = {
    name: charId,
    display_name: displayName,
    description,
    personality: request.personality.trim().slice(0, CARD_TEXT_MAX) || DEFAULT_PERSONALITY,
    speaking_style: request.speaking_style.trim().slice(0, CARD_TEXT_MAX) || DEFAULT_SPEAKING_STYLE,
    scenario: "",
    first_mes: "",
    alternate_greetings: [] as string[],
    mes_example: [] as string[],
    proactive: 0.4,
    verbosity: 0.5,
    nsfw: false,
    language: "zh",
    tts_lang: "ZH",
    relationship_initial: 0.5,
    anti_sycophancy: 0.7,
  };
  const pack = {
    pack_version: 1,
    char_id: charId,
    display_name: displayName,
    author: "本地自建",
    license: "私人自用；角色包不含记忆（D12）",
  };
  const appearance = {
    stage: "png",
    portrait: portraitName,
    model: null,
    png_fallback: portraitName,
    motions: {} as Record<string, string>,
    expressions: {} as Record<string, string>,
    acts,
  };
  const lookAtOrigin = normalizeLookAtOrigin(request.look_at_origin) ?? [
    DEFAULT_LOOK_AT_ORIGIN[0],
    DEFAULT_LOOK_AT_ORIGIN[1],
  ];
  const hits = hitsOf(regions, lookAtOrigin);
  const pretty = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
  return {
    portraitName,
    files: [
      { name: "card.json", content: pretty(card) },
      { name: "pack.json", content: pretty(pack) },
      { name: "appearance.json", content: pretty(appearance) },
      { name: "hits.json", content: pretty(hits) },
    ],
  };
}
