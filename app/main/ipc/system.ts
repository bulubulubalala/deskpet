/**
 * 文件职责：与具体业务无关的「这台机器现在怎么样」类通道——健康、重启引擎、版本信息、模型下载。
 *
 * 为什么单独一个文件：这几条通道都是薄转发（问引擎、问模型管理器），
 * 与聊天/记忆/角色包的领域逻辑没有交集；放在一起也方便一眼看出「界面能问到哪些运行状态」。
 * 依赖方向：ipc/* -> 本文件 -> engine / model-manager / electron；不反向依赖界面。
 */
import { app, BrowserWindow, clipboard, shell } from "electron";

import {
  IPC_CHANNELS,
  type AppInfo,
  type AppUpdateInfo,
  type AsrModelState,
} from "../../shared/contracts/ipc";
import type { HealthView, SidecarEngine } from "../engine";
import type { IpcRegistry } from "../ipc-registry";
import type { IpcHandlerDeps } from "./deps";

/** 当前视图的 appGetInfo 返回；端口与 pid 未知时不带这两个字段（exactOptionalPropertyTypes 要求）。 */
function buildAppInfo(engine: SidecarEngine): AppInfo {
  const view: HealthView = engine.getHealth();
  const info: AppInfo = { app_version: app.getVersion() };
  return {
    ...info,
    ...(view.sidecar_port === null ? {} : { sidecar_port: view.sidecar_port }),
    ...(view.sidecar_pid === null ? {} : { sidecar_pid: view.sidecar_pid }),
  };
}

/**
 * 注册系统状态类通道。
 * @returns 注销函数：退订心跳推送（注册表本身由组合根统一 dispose）。
 */
export function registerSystemHandlers(registry: IpcRegistry, deps: IpcHandlerDeps): () => void {
  registry.handle(IPC_CHANNELS.healthGet, (): HealthView => deps.engine.getHealth());

  registry.handle(IPC_CHANNELS.sidecarRestart, async (): Promise<HealthView> => {
    deps.logger.info("ipc.sidecar_restart", "收到界面发来的手动重启 sidecar 请求");
    return await deps.engine.restartSidecar("用户手动触发");
  });

  registry.handle(IPC_CHANNELS.appGetInfo, (): AppInfo => buildAppInfo(deps.engine));

  // 检查更新（D6）：只查不比装。界面上是一次手动点击，主进程不会自己联网。
  registry.handle(
    IPC_CHANNELS.appCheckUpdate,
    async (): Promise<AppUpdateInfo> => await deps.updates.check(),
  );
  // 打开下载页：地址由主进程记住（或退回 releases 页），界面传不了 URL，避免被当成任意链接跳板
  registry.handle(IPC_CHANNELS.appOpenUpdatePage, async (): Promise<void> => {
    const url = deps.updates.releaseUrl();
    deps.logger.info("app.update_page_open", "打开更新下载页", { url });
    await shell.openExternal(url);
  });

  // 错误详情弹窗的「复制」：内容已在 sidecar 侧脱敏，这里只截断并记长度，绝不写正文
  registry.handle(IPC_CHANNELS.appCopyText, (_event, text: string): void => {
    const content = text.slice(0, 20_000);
    void clipboard.writeText(content);
    deps.logger.info("app.clipboard_copy", "错误详情已复制到剪贴板", {
      chars: content.length,
    });
  });

  registry.handle(IPC_CHANNELS.modelsList, async () => await deps.models.list());
  // 语音识别模型（D7）：读现状 / 起下载任务，都只是转发给 sidecar
  registry.handle(
    IPC_CHANNELS.asrModel,
    async (): Promise<AsrModelState> => await deps.client.asrModel(),
  );
  registry.handle(
    IPC_CHANNELS.asrModelPrefetch,
    async (): Promise<AsrModelState> => await deps.client.prefetchAsrModel(),
  );
  registry.handle(IPC_CHANNELS.modelsInstall, async (_event, id: string): Promise<void> => {
    await deps.models.install(id);
  });
  registry.handle(IPC_CHANNELS.modelsRemove, async (_event, id: string): Promise<void> => {
    await deps.models.remove(id);
  });

  // 心跳变化只推给渲染层，不做业务判断：状态机在主进程，界面只是显示器
  return deps.engine.onHealthChanged((view) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.healthChanged, view);
      }
    }
  });
}
