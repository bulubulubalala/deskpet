/**
 * 文件职责：IPC 组合根——建注册表、建上下文，按域把通道模块挂上去，返回一个注销函数。
 *
 * 为什么只剩装配：原先这个文件 1607 行，里面塞着聊天、语音、触摸、记忆、角色包五套状态机。
 * 拆成 app/main/ipc/* 之后，它只回答「界面一共能碰到哪些域」——每个域一行，
 * 想核对白名单仍然只看这里（CODE_STYLE §1.3 的白名单意图没有变），具体实现看各域模块。
 * 依赖方向：main -> 本文件 -> app/main/ipc/*（各域）-> 具体服务；不反向依赖渲染层。
 * 谁调用：app/main/index.ts 在引擎起来之前注册；返回的注销函数交给 will-quit 调用。
 */
import { ipcMain } from "electron";

import { registerCharacterHandlers } from "./ipc/characters";
import { registerChatHandlers } from "./ipc/chat";
import { createIpcContext } from "./ipc/context";
import { registerDevHandlers } from "./ipc/dev";
import type { IpcHandlerDeps } from "./ipc/deps";
import { registerMemoryHandlers } from "./ipc/memory";
import { registerPackHandlers } from "./ipc/packs";
import { registerProviderHandlers } from "./ipc/providers";
import { registerSystemHandlers } from "./ipc/system";
import { registerTouchHandlers } from "./ipc/touch";
import { registerUiHandlers } from "./ipc/ui";
import { registerVoiceHandlers } from "./ipc/voice";
import { IPC_INPUT_SCHEMAS } from "../shared/contracts/ipc-schemas";
import { IpcRegistry } from "./ipc-registry";

// 依赖清单与推送函数的老入口保持可用：调用方（index.ts）不必知道它们搬进了 ipc/ 子目录
export type { IpcHandlerDeps } from "./ipc/deps";
export { rendererPusher } from "./ipc/context";

export function registerIpcHandlers(deps: IpcHandlerDeps): () => void {
  // 所有通道都经注册表进来，退出时 registry.dispose() 一次性摘掉（不再手工维护注销清单）。
  // 入参形状集中登记在 app/shared/contracts/ipc-schemas.ts：坏数据在入口就被拒，不穿到查库/写盘。
  const registry = new IpcRegistry(ipcMain, {
    schemas: IPC_INPUT_SCHEMAS,
    onInvalidArgument: (channel, error) => {
      deps.logger.warn("ipc.invalid_argument", "界面传了不合契约的参数：" + channel, {
        fields: { channel, path: error.path },
      });
    },
  });
  const ctx = createIpcContext(deps);

  // 有一技之长需要自己收尾的模块（心跳订阅、触摸定时器、网格探测）返回清理函数，这里统一收着
  const cleanups = [
    registerSystemHandlers(registry, deps),
    registerTouchHandlers(registry, deps, ctx),
    registerPackHandlers(registry, deps, ctx),
  ];

  // 其余模块只注册通道，生命周期跟着注册表走
  registerChatHandlers(registry, deps);
  registerVoiceHandlers(registry, deps);
  registerUiHandlers(registry, deps, ctx);
  registerCharacterHandlers(registry, deps);
  registerMemoryHandlers(registry, deps);
  registerProviderHandlers(registry, deps, ctx);
  registerDevHandlers(registry, deps, ctx);

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    // 注销交给注册表：注册过的通道都登记在里面，退出时一次性摘掉（不再手工维护 86 行清单）
    registry.dispose();
  };
}
