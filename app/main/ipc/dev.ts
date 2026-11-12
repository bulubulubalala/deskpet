/**
 * 文件职责：开发者模式开关（data/dev.json）。
 *
 * 为什么单独一个文件：它既不属于记忆也不属于设置窗——只控制「界面是否露出调试页」，
 * 而且明确不是安全边界（T2.3-B1）。一条独立通道配一个文件，比塞进 ui.ts 更好找。
 * 依赖方向：ipc/* -> 本文件 -> dev-mode；只是读写一个小 json。
 */
import {
  IPC_CHANNELS,
  type DevModeRequest,
  type DevModeResponse,
} from "../../shared/contracts/ipc";
import { readDevMode, writeDevMode } from "../dev-mode";
import type { IpcRegistry } from "../ipc-registry";
import type { IpcContext } from "./context";
import type { IpcHandlerDeps } from "./deps";

export function registerDevHandlers(
  registry: IpcRegistry,
  deps: IpcHandlerDeps,
  ctx: IpcContext,
): void {
  // 开发者模式开关（T2.3-B1）：存在 data/dev.json，与 settings.json / ui.json 都无关。
  // enabled = null 只读；这个开关不是安全边界，所以写它不需要额外确认。
  registry.handle(
    IPC_CHANNELS.devModeGet,
    async (): Promise<DevModeResponse> => await readDevMode(deps.devFile),
  );

  registry.handle(
    IPC_CHANNELS.devModeSet,
    async (_event, request: DevModeRequest): Promise<DevModeResponse> => {
      if (request.enabled === null) {
        return await readDevMode(deps.devFile);
      }
      await writeDevMode(deps.devFile, { enabled: request.enabled });
      ctx.recordActivity(request.enabled ? "用户打开了开发者模式。" : "用户关闭了开发者模式。");
      deps.logger.info("ipc.dev_mode", "开发者模式开关已写回 data/dev.json", {
        enabled: request.enabled,
      });
      return { enabled: request.enabled };
    },
  );
}
