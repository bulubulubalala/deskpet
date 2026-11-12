import { systemPreferences, type Session } from "electron";

import type { MainLogger } from "./logger";

interface MediaDetails {
  readonly mediaTypes?: readonly string[];
  readonly mediaType?: string;
  readonly securityOrigin?: string;
  readonly requestingUrl?: string;
}

function asMediaDetails(value: unknown): MediaDetails {
  return typeof value === "object" && value !== null ? value : {};
}

export function microphoneAccessStatus(): string {
  try {
    return systemPreferences.getMediaAccessStatus("microphone");
  } catch {
    return "unknown";
  }
}

export function configureMediaPermissions(target: Session, logger: MainLogger): void {
  target.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    // 原版没有这个处理器，Electron 默认会放行非媒体权限。这里只收窄到
    // 「媒体里明确是 video 的请求」，避免把空 mediaType / 其他权限误伤成拒绝。
    if (permission !== "media") {
      return true;
    }
    const media = asMediaDetails(details);
    const allow = media.mediaType !== "video";
    logger.info("media.permission_check", "媒体权限检查", {
      allowed: allow,
      media_type: media.mediaType ?? "",
    });
    return allow;
  });

  target.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(true);
      return;
    }
    const media = asMediaDetails(details);
    const types = media.mediaTypes ?? [];
    // 允许 audio / 空类型；只有明确包含 video 时才拒绝。
    const allow = !types.includes("video");
    logger.info("media.permission_request", "媒体权限请求", {
      allowed: allow,
      media_types: types.join(","),
      origin: media.securityOrigin ?? media.requestingUrl ?? "",
    });
    callback(allow);
  });
}
