/**
 * 文件职责：角色列表与角色包素材的只读投影（列表 / 立绘 / 部位框 / 外观）。
 *
 * 为什么单独一个文件：这四条通道只回答「characters/ 目录里现在有什么」，
 * 全部只读、坏包返回空值而不是报错；写盘在 packs.ts，两者边界清楚。
 * 依赖方向：ipc/* -> 本文件 -> character-assets（读盘）；不 import 编辑器。
 */
import {
  IPC_CHANNELS,
  type CharacterAppearanceRequest,
  type CharacterAppearanceResponse,
  type CharacterHitsRequest,
  type CharacterHitsResponse,
  type CharacterPortraitRequest,
  type CharacterPortraitResponse,
  type CharacterSummary,
} from "../../shared/contracts/ipc";
import {
  readCharacterAppearance,
  readCharacterHits,
  readCharacterPortrait,
} from "../character-assets";
import type { IpcRegistry } from "../ipc-registry";
import type { IpcHandlerDeps } from "./deps";

export function registerCharacterHandlers(registry: IpcRegistry, deps: IpcHandlerDeps): void {
  registry.handle(
    IPC_CHANNELS.charList,
    async (): Promise<readonly CharacterSummary[]> => await deps.ui.characters(),
  );

  // 角色包素材（T2.3-C2）：立绘以 data URL 交给渲染层（CSP 只放行 'self' 与 data:，不放开 file://），
  // hits.json 是 0–1 归一化框，命中换算在渲染层做。两者都只读，坏包返回空值而不是报错。
  registry.handle(
    IPC_CHANNELS.charPortrait,
    async (_event, request: CharacterPortraitRequest): Promise<CharacterPortraitResponse> => ({
      data_url: await readCharacterPortrait(deps.charactersDir, request.char_id),
    }),
  );

  registry.handle(
    IPC_CHANNELS.charHits,
    async (_event, request: CharacterHitsRequest): Promise<CharacterHitsResponse> =>
      await readCharacterHits(deps.charactersDir, request.char_id),
  );

  // appearance.json 的只读投影（T2.4）：Stage 抽象层据此选 PNG / Live2D 实现、按 acts 播动作
  registry.handle(
    IPC_CHANNELS.charAppearance,
    async (_event, request: CharacterAppearanceRequest): Promise<CharacterAppearanceResponse> => ({
      appearance: await readCharacterAppearance(deps.charactersDir, request.char_id),
    }),
  );
}
