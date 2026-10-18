/**
 * 文件职责：角色包编辑器要读的素材与要写的文件（T2.3-D，需求 §6.1 / §6.11）。
 *
 * 为什么落盘规则放主进程：渲染层有 CSP、拿不到 fs，而且「写哪些文件、字段怎么写才能被
 * character_store 读回来」是一次性规则，散成两份迟早对不上；这里不 import electron，便于单测。
 * 依赖方向：main -> node:fs/promises + ./ipc 的草稿类型；谁调用：app/main/ipc-handlers.ts。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type { PackRegionDraft, PackSaveRequest } from "./ipc";

/** char_id 同时是目录名，规则与 sidecar/contracts/character.py 的 PackInfo 保持一致。 */
export const PACK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const PACK_ID_HINT =
  "char_id 只能是字母 / 数字 / 下划线 / 短横，最长 64 字，且不能以 _ 或 . 开头";
/** 素材上限与 character-assets.ts 的读取上限一致：写进去的必须读得回来。 */
export const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024;
export const MAX_REGIONS = 24;
export const REGION_NAME_MAX = 24;
export const CARD_TEXT_MAX = 2000;
export const DEFAULT_REGION_COLOR = "#ffb347";
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

/** 把外部选中的图片读成 data URL（选图那一步用）；读不了或太大时抛错，由 IPC 层转成文案。 */
export async function readImageAsDataUrl(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (info.size <= 0) {
    throw new Error("图片是空文件：" + filePath);
  }
  if (info.size > MAX_PORTRAIT_BYTES) {
    throw new Error("图片超过 8 MiB，先压小一点再用。");
  }
  const extension = extname(filePath).toLowerCase();
  const mime =
    extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
  const data = await readFile(filePath);
  return "data:" + mime + ";base64," + data.toString("base64");
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
    result.push({ id, name, rect, color, act: region.act });
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
  const hits = {
    version: 2,
    regions: regions.map((region) => ({
      id: region.id,
      name: region.name,
      rect: region.rect,
      color: region.color,
      act: region.act,
    })),
  };
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

/**
 * 落盘一个角色包：characters/<char_id>/{assets/portrait.*, card.json, pack.json,
 * appearance.json, hits.json}。已存在同名目录时拒绝（不覆盖已有角色），失败一律转成 ok=false。
 */
export async function saveCharacterPack(
  charactersDir: string,
  request: PackSaveRequest,
): Promise<PackSaveResult> {
  const charId = request.char_id.trim();
  const invalid = validatePackId(charId);
  if (invalid !== null) {
    return { ok: false, char_id: charId, error: invalid, files: [] };
  }
  const image = decodeImageDataUrl(request.portrait_data_url);
  if (image === null) {
    return {
      ok: false,
      char_id: charId,
      error: "立绘不是合法的 PNG / JPEG / WebP，或超过了 8 MiB。",
      files: [],
    };
  }
  const root = join(charactersDir, charId);
  const built = buildPackFiles({ ...request, char_id: charId }, image.mime);
  try {
    await stat(root);
    return {
      ok: false,
      char_id: charId,
      error: "characters/" + charId + " 已经存在了；换一个 char_id 或先删掉旧目录。",
      files: [],
    };
  } catch {
    // 不存在才是我们要的情况：继续往下建目录
  }
  try {
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, built.portraitName), image.data);
    for (const file of built.files) {
      await writeFile(join(root, file.name), file.content, "utf8");
    }
  } catch (error) {
    return {
      ok: false,
      char_id: charId,
      error: "写角色包失败：" + (error instanceof Error ? error.message : String(error)),
      files: [],
    };
  }
  return {
    ok: true,
    char_id: charId,
    error: "",
    files: [built.portraitName, ...built.files.map((file) => file.name)],
  };
}
