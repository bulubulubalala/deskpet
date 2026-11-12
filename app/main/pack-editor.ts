/**
 * 文件职责：角色包编辑器要读的素材与要写的文件（T2.3-D，需求 §6.1 / §6.11）。
 *
 * 为什么落盘规则放主进程：渲染层有 CSP、拿不到 fs，而且「写哪些文件、字段怎么写才能被
 * character_store 读回来」是一次性规则，散成两份迟早对不上；这里不 import electron，便于单测。
 * 依赖方向：main -> node:fs/promises + ./pack-editor/rules 的纯规则；谁调用：app/main/ipc/packs.ts。
 * 分工：本文件只管「会不会写坏」（拒绝覆盖、临时文件改名、失败转文案），校验与内容生成在 rules.ts。
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import { readCharacterPortrait } from "./character-assets";
import {
  CARD_TEXT_MAX,
  DEFAULT_PERSONALITY,
  DEFAULT_REGION_COLOR,
  DEFAULT_SPEAKING_STYLE,
  MAX_PORTRAIT_BYTES,
  MAX_REGIONS,
  buildPackFiles,
  decodeImageDataUrl,
  hitsOf,
  normalizeRegionsForUpdate,
  optionalFieldsOf,
  validatePackId,
  type PackSaveResult,
} from "./pack-editor/rules";
import type {
  PackLoadResponse,
  PackRegionDraft,
  PackSaveCardRequest,
  PackSaveRegionsRequest,
  PackSaveRequest,
} from "../shared/contracts/ipc";
import {
  DEFAULT_LOOK_AT_ORIGIN,
  faceRigOriginOf,
  normalizeLookAtOrigin,
  suggestLookAtOrigin,
  type FaceRigOrigin,
} from "./look-at-origin";

// 规则住在 ./pack-editor/rules.ts；对外仍从这一个入口取，调用方与测试不用改路径。
export * from "./pack-editor/rules";

/** 可选预览图：不存在 / 读不了就返回 null，让调用方回退到角色包立绘。 */
async function readOptionalImageDataUrl(filePath: string): Promise<string | null> {
  try {
    return await readImageAsDataUrl(filePath);
  } catch {
    return null;
  }
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

/** 读一个小 JSON；不存在 / 坏 JSON 都返回 null（调用方给默认值）。 */
async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从 JSON 里取一个字符串字段；缺失 / 非字符串给空串。 */
function textOf(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

/** 把 hits.json 的 regions 读成草稿并保留已有 id（坏项直接丢，不让一个框毁掉整份文件）。 */
function regionsOf(raw: Record<string, unknown> | null): PackRegionDraft[] {
  const list = raw?.["regions"];
  if (!Array.isArray(list)) {
    return [];
  }
  const drafts: PackRegionDraft[] = [];
  for (const entry of list.slice(0, MAX_REGIONS)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const rect = record["rect"];
    if (!Array.isArray(rect) || rect.length !== 4) {
      continue;
    }
    const numbers: number[] = [];
    for (const item of rect) {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        break;
      }
      numbers.push(item);
    }
    if (numbers.length !== 4) {
      continue;
    }
    const [x = 0, y = 0, w = 0, h = 0] = numbers;
    drafts.push({
      id: typeof record["id"] === "string" ? record["id"] : "",
      name: typeof record["name"] === "string" ? record["name"] : "",
      rect: [x, y, w, h],
      color: typeof record["color"] === "string" ? record["color"] : DEFAULT_REGION_COLOR,
      act: typeof record["act"] === "string" ? record["act"] : "",
      ...optionalFieldsOf({
        priority: record["priority"],
        padding: record["padding"],
        shape: record["shape"],
        drawables: record["drawables"],
      }),
    });
  }
  return normalizeRegionsForUpdate(drafts);
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

/**
 * 读一个现有角色包，供编辑器「编辑当前角色部位」用（T2.5）。
 *
 * 为什么只回投影：编辑器只需要展示名 + 立绘 + 部位；人格 / 音色 / 记忆绝不进编辑器，
 * 避免误改（本轮已定「只编辑部位」）。立绘缺失时报错，因为部位框必须画在某张图上。
 */
export async function loadCharacterPack(
  charactersDir: string,
  charIdRaw: string,
): Promise<PackLoadResponse> {
  const charId = charIdRaw.trim();
  const empty: PackLoadResponse = {
    ok: false,
    char_id: charId,
    display_name: "",
    description: "",
    personality: "",
    speaking_style: "",
    portrait_data_url: null,
    regions: [],
    look_at_origin: [DEFAULT_LOOK_AT_ORIGIN[0], DEFAULT_LOOK_AT_ORIGIN[1]],
    suggested_look_at_origin: [DEFAULT_LOOK_AT_ORIGIN[0], DEFAULT_LOOK_AT_ORIGIN[1]],
    error: "",
  };
  const invalid = validatePackId(charId);
  if (invalid !== null) {
    return { ...empty, error: invalid };
  }
  const root = join(charactersDir, charId);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new Error("not-a-directory");
    }
  } catch {
    return { ...empty, error: "找不到角色包 characters/" + charId + "。" };
  }
  const pack = await readJsonFile(join(root, "pack.json"));
  const card = await readJsonFile(join(root, "card.json"));
  const appearance = await readJsonFile(join(root, "appearance.json"));
  const hits = await readJsonFile(join(root, "hits.json"));
  const regions = regionsOf(hits);
  const modelRelative = textOf(appearance, "model");
  const safeModel =
    modelRelative !== "" && !modelRelative.includes("..") && !modelRelative.startsWith("/");

  // PSD2Live 的 faceRig 是最可靠的脸部中心；缺模型 / 缺文件时退回部位框。
  let faceRig: FaceRigOrigin | null = null;
  let preview: string | null = null;
  if (safeModel) {
    const modelDir = dirname(join(root, modelRelative));
    faceRig = faceRigOriginOf(await readJsonFile(join(modelDir, "model.psd2live.json")));
    // Live2D 的角色包立绘（png_fallback）往往是另一张构图；编辑部位 / 视觉原点要对着模型
    // 画布本身，所以优先用 model.preview.png（与 model 同尺寸的合成图）。
    preview = await readOptionalImageDataUrl(join(modelDir, "model.preview.png"));
  }
  const portrait = await readCharacterPortrait(charactersDir, charId);
  const suggested = suggestLookAtOrigin(regions, faceRig);
  const saved = normalizeLookAtOrigin(hits?.["look_at_origin"]);
  return {
    ok: true,
    char_id: charId,
    display_name: textOf(pack, "display_name") || textOf(card, "display_name") || charId,
    description: textOf(card, "description"),
    personality: textOf(card, "personality"),
    speaking_style: textOf(card, "speaking_style"),
    // 立绘可能缺失 / 坏掉：部位模式由编辑器的 null 检查拦住，角色卡模式不依赖立绘（T2.7）
    portrait_data_url: preview ?? portrait,
    regions,
    look_at_origin: saved ?? suggested,
    suggested_look_at_origin: suggested,
    error: "",
  };
}

/**
 * 只把部位写回 characters/<char_id>/hits.json（T2.5）。
 *
 * 为什么不动其它文件：编辑模式的边界就是「触摸区域」；card / voice / emotion_map / appearance
 * 与 assets 都可能被用户手工调过，重写会把它们覆盖成默认值。写入用 .tmp + rename，避免半截文件。
 */
export async function saveCharacterRegions(
  charactersDir: string,
  request: PackSaveRegionsRequest,
): Promise<PackSaveResult> {
  const charId = request.char_id.trim();
  const invalid = validatePackId(charId);
  if (invalid !== null) {
    return { ok: false, char_id: charId, error: invalid, files: [] };
  }
  const root = join(charactersDir, charId);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new Error("not-a-directory");
    }
  } catch {
    return {
      ok: false,
      char_id: charId,
      error: "找不到角色包 characters/" + charId + "。",
      files: [],
    };
  }
  const regions = normalizeRegionsForUpdate(request.regions);
  // 请求没带原点时保留旧值：老编辑器 / 旧调用方只保存 regions 不会把用户拖好的原点重置。
  const existing = await readJsonFile(join(root, "hits.json"));
  const lookAtOrigin = normalizeLookAtOrigin(request.look_at_origin) ??
    normalizeLookAtOrigin(existing?.["look_at_origin"]) ?? [
      DEFAULT_LOOK_AT_ORIGIN[0],
      DEFAULT_LOOK_AT_ORIGIN[1],
    ];
  const hits = hitsOf(regions, lookAtOrigin);
  const target = join(root, "hits.json");
  const temp = target + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(hits, null, 2) + "\n", "utf8");
    await rename(temp, target);
  } catch (error) {
    return {
      ok: false,
      char_id: charId,
      error: "写 hits.json 失败：" + (error instanceof Error ? error.message : String(error)),
      files: [],
    };
  }
  return { ok: true, char_id: charId, error: "", files: ["hits.json"] };
}

/**
 * 只改角色卡（T2.7）：card.json 的展示 / 人设字段 + pack.json 的 display_name。
 *
 * 为什么把立绘、hits、voice、appearance 全部留在原地：用户只是改“人设文案”，
 * 不应该顺带重写素材或触摸区域；这和 T2.5「编辑部位只动 hits.json」是同一条边界。
 */
export async function saveCharacterCard(
  charactersDir: string,
  request: PackSaveCardRequest,
): Promise<PackSaveResult> {
  const charId = request.char_id.trim();
  const invalid = validatePackId(charId);
  if (invalid !== null) {
    return { ok: false, char_id: charId, error: invalid, files: [] };
  }
  const root = join(charactersDir, charId);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new Error("not-a-directory");
    }
  } catch {
    return {
      ok: false,
      char_id: charId,
      error: "找不到角色包 characters/" + charId + "。",
      files: [],
    };
  }

  const cardPath = join(root, "card.json");
  const card = await readJsonFile(cardPath);
  if (card === null) {
    return {
      ok: false,
      char_id: charId,
      error: "这个角色包没有可读的 card.json。",
      files: [],
    };
  }
  const displayName =
    request.display_name.trim().slice(0, 64) || textOf(card, "display_name") || charId;
  const description = request.description.trim().slice(0, CARD_TEXT_MAX);
  const personality =
    request.personality.trim().slice(0, CARD_TEXT_MAX) ||
    textOf(card, "personality") ||
    DEFAULT_PERSONALITY;
  const speakingStyle =
    request.speaking_style.trim().slice(0, CARD_TEXT_MAX) ||
    textOf(card, "speaking_style") ||
    DEFAULT_SPEAKING_STYLE;
  const nextCard = {
    ...card,
    display_name: displayName,
    description,
    personality,
    speaking_style: speakingStyle,
  };

  const cardTemp = cardPath + ".tmp";
  const packPath = join(root, "pack.json");
  const pack = await readJsonFile(packPath);
  const packTemp = packPath + ".tmp";
  const files: string[] = ["card.json"];
  try {
    await writeFile(cardTemp, JSON.stringify(nextCard, null, 2) + "\n", "utf8");
    if (pack !== null) {
      const nextPack = { ...pack, display_name: displayName };
      await writeFile(packTemp, JSON.stringify(nextPack, null, 2) + "\n", "utf8");
      await rename(packTemp, packPath);
      files.push("pack.json");
    }
    await rename(cardTemp, cardPath);
  } catch (error) {
    await unlink(cardTemp).catch(() => undefined);
    await unlink(packTemp).catch(() => undefined);
    return {
      ok: false,
      char_id: charId,
      error: "写角色卡失败：" + (error instanceof Error ? error.message : String(error)),
      files: [],
    };
  }
  return { ok: true, char_id: charId, error: "", files };
}
