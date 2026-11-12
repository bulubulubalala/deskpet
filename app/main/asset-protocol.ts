/**
 * 文件职责：给渲染层提供只读的 `deskpet-asset://` 角色资源协议。
 *
 * 为什么不直接 file://：模型加载器用 fetch/XHR，file:// 在渲染层受 CSP / CORS 限制；
 * 关闭 webSecurity 又会把整个应用的安全边界拆掉。自定义协议只暴露 characters/ 下的文件，
 * 路径由纯函数校验后再读。
 */
import { protocol } from "electron";
import { readFile } from "node:fs/promises";

import { CHARACTER_ASSET_SCHEME, resolveCharacterAssetPath } from "./character-asset-path";

let schemeRegistered = false;
let handlerRegistered = false;

/** 必须在 app ready 之前调用；重复调用无副作用。 */
export function registerCharacterAssetScheme(): void {
  if (schemeRegistered) {
    return;
  }
  schemeRegistered = true;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CHARACTER_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** app ready 之后调用；只注册一次。 */
export function registerCharacterAssetProtocol(charactersDir: string): void {
  if (handlerRegistered) {
    return;
  }
  handlerRegistered = true;
  protocol.handle(CHARACTER_ASSET_SCHEME, async (request) => {
    const resolved = resolveCharacterAssetPath(charactersDir, request.url);
    if (resolved === null) {
      return new Response("Not Found", { status: 404 });
    }
    try {
      const data = await readFile(resolved.filePath);
      return new Response(new Uint8Array(data), {
        headers: { "content-type": resolved.mime },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  });
}
