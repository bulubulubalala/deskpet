import AdmZip from "adm-zip";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { readCharacterHits } from "./character-assets";
import { loadCharacterPack, validatePackId } from "./pack-editor";

const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const KNOWN_ROOT_FILES = new Set([
  "pack.json",
  "card.json",
  "voice.json",
  "emotion_map.json",
  "appearance.json",
  "hits.json",
]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a"]);

export interface PackArchiveOptions {
  readonly includeVoice: boolean;
  readonly includeModel: boolean;
}

export interface PackExportResult {
  readonly ok: boolean;
  readonly canceled: boolean;
  readonly charId: string;
  readonly path: string;
  readonly files: number;
  readonly error: string;
}

export interface PackImportPreview {
  readonly ok: boolean;
  readonly charId: string;
  readonly displayName: string;
  readonly regionCount: number;
  readonly hasHits: boolean;
  readonly hasPortrait: boolean;
  readonly warnings: readonly string[];
  readonly error: string;
  readonly tempRoot: string;
}

export interface PackImportResult {
  readonly ok: boolean;
  readonly canceled: boolean;
  readonly charId: string;
  readonly displayName: string;
  readonly renamedFrom: string;
  readonly warnings: readonly string[];
  readonly error: string;
}

function safeEntryName(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  // 常见压缩工具会把目录也写成 `assets/`；去掉尾部斜杠后再做越界检查。
  const name = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (name === "" || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error("压缩包里有绝对路径");
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("压缩包里有越界路径");
  }
  return name;
}

function entryIsSymlink(entry: { header: { attr?: number } }): boolean {
  const mode = entry.header.attr;
  return mode !== undefined && (mode & 0o170000) === 0o120000;
}

function isAudio(relativePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

async function uniqueTargetId(charactersDir: string, base: string): Promise<string> {
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (validatePackId(candidate) !== null) {
      continue;
    }
    try {
      const info = await stat(join(charactersDir, candidate));
      if (!info.isDirectory()) {
        return candidate;
      }
    } catch {
      return candidate;
    }
  }
  throw new Error("找不到可用的新 char_id");
}

async function readPackId(root: string): Promise<string> {
  const raw = JSON.parse(await readFile(join(root, "pack.json"), "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null) {
    return "";
  }
  const value = (raw as Record<string, unknown>)["char_id"];
  return typeof value === "string" ? value.trim() : "";
}

async function updatePackId(root: string, charId: string): Promise<void> {
  const path = join(root, "pack.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  raw["char_id"] = charId;
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

async function writeEntriesToTemp(zip: AdmZip, tempRoot: string): Promise<string> {
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) {
    throw new Error("压缩包文件数太多");
  }
  let total = 0;
  for (const entry of entries) {
    const name = safeEntryName(entry.entryName);
    if ((entry.header.flags ?? 0) & 1) {
      throw new Error("不支持加密压缩包");
    }
    if (entryIsSymlink(entry)) {
      throw new Error("压缩包里有符号链接");
    }
    const size = entry.header.size;
    if (size > MAX_FILE_BYTES) {
      throw new Error("压缩包里有超过 100 MiB 的单文件");
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error("压缩包解压后超过 200 MiB");
    }
    const target = resolve(tempRoot, name);
    if (target !== tempRoot && !target.startsWith(tempRoot + sep)) {
      throw new Error("压缩包路径越界");
    }
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.getData());
  }
  const packEntries = entries.filter((entry) => {
    const name = safeEntryName(entry.entryName);
    return name === "pack.json" || name.endsWith("/pack.json");
  });
  if (packEntries.length !== 1) {
    throw new Error("压缩包必须包含且只包含一个 pack.json");
  }
  const packName = safeEntryName(packEntries[0]?.entryName ?? "");
  const packDir = dirname(packName);
  if (packDir === ".") {
    const raw = await readPackId(tempRoot);
    const derived = validatePackId(raw) === null ? raw : "";
    if (derived === "") {
      throw new Error("压缩包根目录缺少合法 char_id");
    }
    const targetRoot = join(tempRoot, derived);
    await mkdir(targetRoot, { recursive: true });
    for (const entry of await readdir(tempRoot)) {
      if (entry === derived) {
        continue;
      }
      await rename(join(tempRoot, entry), join(targetRoot, entry));
    }
    return targetRoot;
  }
  return join(tempRoot, packDir);
}

export async function inspectPackArchive(zipPath: string): Promise<PackImportPreview> {
  let tempRoot = "";
  try {
    tempRoot = await mkdtemp(join(tmpdir(), "deskpet-pack-"));
    const zip = new AdmZip(zipPath);
    const sourceRoot = await writeEntriesToTemp(zip, tempRoot);
    const folderId = basename(sourceRoot);
    const packId = await readPackId(sourceRoot);
    const charId = validatePackId(packId) === null ? packId : folderId;
    if (validatePackId(charId) !== null) {
      throw new Error(validatePackId(charId) ?? "非法 char_id");
    }
    const folderRoot = dirname(sourceRoot);
    const load = await loadCharacterPack(folderRoot, folderId);
    if (!load.ok) {
      throw new Error(load.error || "角色包体检未通过");
    }
    const regions = await readCharacterHits(folderRoot, folderId);
    const warnings: string[] = [];
    if (regions.length === 0) {
      warnings.push("没有 hits.json 或部位框为空；互动模式仍可触摸，但不会区分身体部位。");
    }
    if (load.portrait_data_url === null) {
      warnings.push("没有可用立绘，界面会使用占位图。");
    }
    return {
      ok: true,
      charId,
      displayName: load.display_name,
      regionCount: regions.length,
      hasHits: regions.length > 0,
      hasPortrait: load.portrait_data_url !== null,
      warnings,
      error: "",
      tempRoot,
    };
  } catch (error) {
    if (tempRoot !== "") {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      ok: false,
      charId: "",
      displayName: "",
      regionCount: 0,
      hasHits: false,
      hasPortrait: false,
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
      tempRoot: "",
    };
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      if (item.isDirectory()) {
        await walk(path);
      } else if (item.isFile()) {
        result.push(path);
      }
    }
  };
  await walk(root);
  return result;
}

export async function exportPackArchive(
  charactersDir: string,
  charIdRaw: string,
  outputPath: string,
  options: PackArchiveOptions,
): Promise<PackExportResult> {
  const charId = charIdRaw.trim();
  const invalid = validatePackId(charId);
  if (invalid !== null) {
    return { ok: false, canceled: false, charId, path: "", files: 0, error: invalid };
  }
  const sourceRoot = join(charactersDir, charId);
  const loaded = await loadCharacterPack(charactersDir, charId);
  if (!loaded.ok) {
    return {
      ok: false,
      canceled: false,
      charId,
      path: "",
      files: 0,
      error: loaded.error || "角色包无法读取",
    };
  }
  const zip = new AdmZip();
  let files = 0;
  for (const file of await listFiles(sourceRoot)) {
    const rel = relative(sourceRoot, file).replace(/\\/g, "/");
    const top = rel.split("/")[0] ?? "";
    if (top === "model" && !options.includeModel) {
      continue;
    }
    if (!options.includeVoice && (rel === "voice.json" || isAudio(rel))) {
      continue;
    }
    if (!KNOWN_ROOT_FILES.has(rel) && top !== "assets" && top !== "model") {
      continue;
    }
    zip.addFile(charId + "/" + rel, await readFile(file));
    files += 1;
  }
  if (files === 0) {
    return { ok: false, canceled: false, charId, path: "", files: 0, error: "没有可导出的文件" };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  zip.writeZip(outputPath);
  return { ok: true, canceled: false, charId, path: outputPath, files, error: "" };
}

export async function commitPackImport(
  preview: PackImportPreview,
  charactersDir: string,
  options: PackArchiveOptions,
  overwrite: boolean,
): Promise<PackImportResult> {
  if (!preview.ok || preview.tempRoot === "") {
    return {
      ok: false,
      canceled: false,
      charId: "",
      displayName: "",
      renamedFrom: "",
      warnings: preview.warnings,
      error: preview.error || "导入预览无效",
    };
  }
  try {
    const actualSource = await findPackRoot(preview.tempRoot);
    if (!options.includeVoice) {
      await rm(join(actualSource, "voice.json"), { force: true });
      for (const file of await listFiles(actualSource)) {
        const rel = relative(actualSource, file).replace(/\\/g, "/");
        if (isAudio(rel)) {
          await rm(file, { force: true });
        }
      }
    }
    if (!options.includeModel) {
      await rm(join(actualSource, "model"), { recursive: true, force: true });
    }
    let targetId = preview.charId;
    let renamedFrom = "";
    if (!overwrite) {
      try {
        const info = await stat(join(charactersDir, targetId));
        if (info.isDirectory()) {
          renamedFrom = targetId;
          targetId = await uniqueTargetId(charactersDir, targetId);
        }
      } catch {
        // 目标不存在，直接用原 id
      }
    }
    if (overwrite) {
      const target = join(charactersDir, targetId);
      const backup = target + ".bak-" + String(Date.now());
      let moved = false;
      try {
        const info = await stat(target);
        if (info.isDirectory()) {
          await rename(target, backup);
          moved = true;
        }
      } catch {
        // 没有旧目录
      }
      try {
        await cp(actualSource, target, { recursive: true });
        await updatePackId(target, targetId);
        if (moved) {
          await rm(backup, { recursive: true, force: true });
        }
      } catch (error) {
        if (moved) {
          await rm(target, { recursive: true, force: true }).catch(() => undefined);
          await rename(backup, target).catch(() => undefined);
        }
        throw error;
      }
    } else {
      await cp(actualSource, join(charactersDir, targetId), { recursive: true });
      await updatePackId(join(charactersDir, targetId), targetId);
    }
    return {
      ok: true,
      canceled: false,
      charId: targetId,
      displayName: preview.displayName,
      renamedFrom,
      warnings: preview.warnings,
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      charId: preview.charId,
      displayName: preview.displayName,
      renamedFrom: "",
      warnings: preview.warnings,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(preview.tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findPackRoot(tempRoot: string): Promise<string> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "pack.json")) {
      found.push(current);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "model" && entry.name !== "assets") {
        await walk(join(current, entry.name));
      }
    }
  };
  await walk(tempRoot);
  if (found.length !== 1) {
    throw new Error("压缩包预览目录不完整");
  }
  return found[0] ?? "";
}
