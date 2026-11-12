/**
 * 文件职责：把 `deskpet-asset://character/<char_id>/<relative>` 解析成角色包里的真实文件。
 *
 * 为什么单独成纯函数：自定义协议在 Electron 里跑，但路径穿越与 MIME 映射必须能脱离
 * Electron 单测。渲染层拿不到 fs；协议只允许读取 characters/<char_id>/ 内部。
 */
import { extname, resolve, sep } from "node:path";

import { PACK_ID_PATTERN } from "./pack-editor";

export const CHARACTER_ASSET_SCHEME = "deskpet-asset";
export const CHARACTER_ASSET_HOST = "character";

export interface CharacterAssetPath {
  readonly charId: string;
  readonly relative: string;
  readonly filePath: string;
  readonly mime: string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".json": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split("/").filter((part) => part !== "");
  const decoded: string[] = [];
  for (const part of parts) {
    let value: string;
    try {
      value = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (value === "" || value === "." || value === ".." || value.includes("\\")) {
      return null;
    }
    decoded.push(value);
  }
  return decoded;
}

/**
 * URL 形状固定为 `deskpet-asset://character/<char_id>/<relative>`。
 * 返回 null 表示不该读（非法 scheme/host、越界路径、非法 char_id）。
 */
export function resolveCharacterAssetPath(
  charactersDir: string,
  requestUrl: string,
): CharacterAssetPath | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== CHARACTER_ASSET_SCHEME + ":" || url.hostname !== CHARACTER_ASSET_HOST) {
    return null;
  }
  const segments = decodeSegments(url.pathname);
  if (segments === null || segments.length < 2) {
    return null;
  }
  const charId = segments[0] ?? "";
  if (!PACK_ID_PATTERN.test(charId)) {
    return null;
  }
  const relative = segments.slice(1).join("/");
  const root = resolve(charactersDir, charId);
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return null;
  }
  return {
    charId,
    relative,
    filePath,
    mime: MIME_BY_EXTENSION[extname(relative).toLowerCase()] ?? "application/octet-stream",
  };
}
