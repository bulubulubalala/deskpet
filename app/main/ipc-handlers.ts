/**
 * 文件职责：把 IPC 白名单的通道接到引擎与会话编排上（需求 §6.10）。
 *
 * 为什么收在一个模块：IPC 是 renderer 唯一能碰到主进程的入口，通道与实现集中在一处，
 * 想核对「界面能做什么」时只看这个文件即可（CODE_STYLE §1.3 的白名单意图）。
 * 依赖方向：main -> electron（ipcMain）+ ./ipc 契约 + ./engine + ./chat-orchestrator。
 * 谁调用：app/main/index.ts 在引擎起来之前注册；返回的注销函数交给 will-quit 调用。
 */
import { app, ipcMain, type BrowserWindow } from "electron";

import type { ChatOrchestrator } from "./chat-orchestrator";
import type { HealthView, SidecarEngine } from "./engine";
import { readEnvFile, updateEnvFile } from "./env-file";
import {
  IPC_CHANNELS,
  type AppInfo,
  type CharacterSummary,
  type ChatCancelRequest,
  type ChatCancelResponse,
  type ChatSendRequest,
  type ChatSendResponse,
  type MemoryClearRequest,
  type MemoryClearResponse,
  type MemoryDeleteRequest,
  type MemoryDeleteResponse,
  type MemoryListRequest,
  type MemoryListResponse,
  type ProviderCapability,
  type ProviderSettingsPatchEntry,
  type ProviderSettingsPayload,
  type ProviderTestReport,
  type UiPointerMessage,
  type UiStatePatch,
  type UiStatePayload,
  type VoiceStatePayload,
  type VoiceStopRequest,
  type VoiceStopResponse,
} from "./ipc";
import type { MainLogger } from "./logger";
import { buildProviderSettings, providerPatchToEnv } from "./provider-settings";
import type { SidecarClient } from "./sidecar-client";
import type { UiController } from "./ui-controller";

export interface IpcHandlerDeps {
  readonly engine: SidecarEngine;
  readonly orchestrator: ChatOrchestrator;
  readonly ui: UiController;
  readonly logger: MainLogger;
  /** 供给探测要打到 sidecar /providers/test；端点由心跳同步（T1.14b）。 */
  readonly client: SidecarClient;
  /** 「模型供给」读写的 .env 路径；密钥只在这条链路上流动，永不回传渲染层。 */
  readonly envFilePath: string;
  /** 推送用；窗口可能不存在或正在关闭，取到的可能是 null 或已销毁的实例。 */
  readonly getWindow: () => BrowserWindow | null;
}

/**
 * 生成「推给渲染层」的函数；窗口没了就静默丢弃。
 * 单独导出是因为会话编排（T1.6b）也要推事件与音频，而它不持有 ipcMain。
 */
export function rendererPusher(
  getWindow: () => BrowserWindow | null,
): (channel: string, payload: unknown) => void {
  return (channel, payload) => {
    const window = getWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    window.webContents.send(channel, payload);
  };
}

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

export function registerIpcHandlers(deps: IpcHandlerDeps): () => void {
  const push = rendererPusher(deps.getWindow);

  ipcMain.handle(IPC_CHANNELS.healthGet, (): HealthView => deps.engine.getHealth());

  ipcMain.handle(IPC_CHANNELS.sidecarRestart, async (): Promise<HealthView> => {
    deps.logger.info("ipc.sidecar_restart", "收到界面发来的手动重启 sidecar 请求");
    return await deps.engine.restartSidecar("用户手动触发");
  });

  ipcMain.handle(IPC_CHANNELS.appGetInfo, (): AppInfo => buildAppInfo(deps.engine));

  // 聊天与语音：主进程只做转发与编排，业务语义在 chat-orchestrator（T1.6b）
  ipcMain.handle(
    IPC_CHANNELS.chatSend,
    async (_event, request: ChatSendRequest): Promise<ChatSendResponse> =>
      await deps.orchestrator.send(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.chatCancel,
    async (_event, request: ChatCancelRequest): Promise<ChatCancelResponse> =>
      await deps.orchestrator.cancel(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.voiceStart,
    async (): Promise<VoiceStatePayload> => await deps.orchestrator.startListening(),
  );

  ipcMain.handle(
    IPC_CHANNELS.voiceStop,
    async (_event, request: VoiceStopRequest): Promise<VoiceStopResponse> =>
      await deps.orchestrator.stopListening(request),
  );

  // 界面形态（T1.12a）：状态存在主进程，主窗与设置窗都从同一份读
  ipcMain.handle(IPC_CHANNELS.uiGetState, (): UiStatePayload => deps.ui.getState());

  ipcMain.handle(
    IPC_CHANNELS.uiSetState,
    async (_event, patch: UiStatePatch): Promise<UiStatePayload> => await deps.ui.setState(patch),
  );

  ipcMain.handle(IPC_CHANNELS.settingsOpen, (): void => {
    deps.ui.openSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.charList,
    async (): Promise<readonly CharacterSummary[]> => await deps.ui.characters(),
  );

  // 指针进出一律走单向消息：renderer 只报事实，开关穿透由主进程决定（§6.11）
  ipcMain.on(IPC_CHANNELS.uiPointer, (_event, message: UiPointerMessage): void => {
    deps.ui.setPointerInside(message.inside);
  });

  // 模型供给（T1.14b）：配置的唯一事实来源是 .env，这里只做「读写 + 探测」三件事。
  // 读回来的密钥一律只给布尔量；写的时候用 applyEnvUpdates 保住注释与顺序（见 env-file.ts）。
  ipcMain.handle(IPC_CHANNELS.providersGet, async (): Promise<ProviderSettingsPayload> => ({
    entries: buildProviderSettings(await readEnvFile(deps.envFilePath)),
    env_file: deps.envFilePath,
  }));

  ipcMain.handle(
    IPC_CHANNELS.providersSet,
    async (
      _event,
      patch: readonly ProviderSettingsPatchEntry[],
    ): Promise<ProviderSettingsPayload> => {
      const updates = providerPatchToEnv(patch);
      const env = await updateEnvFile(deps.envFilePath, updates);
      // 只记改了几个键，不记键值：LLM key 与 TTS token 都在这条路上（§7.1）
      deps.logger.info("ipc.providers_set", "已把模型供给设置写回 .env", {
        changed: Object.keys(updates).length,
      });
      return { entries: buildProviderSettings(env), env_file: deps.envFilePath };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.providersTest,
    async (_event, capability: ProviderCapability): Promise<ProviderTestReport> =>
      await deps.client.testProvider(capability),
  );

  // 记忆管理（T2.1b）：界面只能看和删，写入永远由对话链路产生（§6.4）。
  // 记忆是增强项：sidecar 没起来时这里会抛 SidecarUnavailableError，设置窗只显示错误，不影响聊天。
  ipcMain.handle(
    IPC_CHANNELS.memoryList,
    async (_event, request: MemoryListRequest): Promise<MemoryListResponse> => ({
      items: await deps.client.listMemories(request),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryDelete,
    async (_event, request: MemoryDeleteRequest): Promise<MemoryDeleteResponse> => ({
      deleted: await deps.client.deleteMemory(request.memory_id),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryClear,
    async (_event, request: MemoryClearRequest): Promise<MemoryClearResponse> => {
      const deleted = await deps.client.clearMemories(request);
      // 只记「删了几条」，不记记忆正文：正文可能含用户隐私（§7.1）
      deps.logger.info("ipc.memory_clear", "用户清空了角色记忆", { deleted });
      return { deleted };
    },
  );

  // 心跳变化只推给渲染层，不做业务判断：状态机在主进程，界面只是显示器
  const unsubscribe = deps.engine.onHealthChanged((view) => {
    push(IPC_CHANNELS.healthChanged, view);
  });

  return () => {
    unsubscribe();
    // 注销通道，避免「窗口重建后旧 handler 还挂着」导致重复响应
    ipcMain.removeHandler(IPC_CHANNELS.healthGet);
    ipcMain.removeHandler(IPC_CHANNELS.sidecarRestart);
    ipcMain.removeHandler(IPC_CHANNELS.appGetInfo);
    ipcMain.removeHandler(IPC_CHANNELS.chatSend);
    ipcMain.removeHandler(IPC_CHANNELS.chatCancel);
    ipcMain.removeHandler(IPC_CHANNELS.voiceStart);
    ipcMain.removeHandler(IPC_CHANNELS.voiceStop);
    ipcMain.removeHandler(IPC_CHANNELS.uiGetState);
    ipcMain.removeHandler(IPC_CHANNELS.uiSetState);
    ipcMain.removeHandler(IPC_CHANNELS.settingsOpen);
    ipcMain.removeHandler(IPC_CHANNELS.charList);
    ipcMain.removeHandler(IPC_CHANNELS.providersGet);
    ipcMain.removeHandler(IPC_CHANNELS.providersSet);
    ipcMain.removeHandler(IPC_CHANNELS.providersTest);
    ipcMain.removeHandler(IPC_CHANNELS.memoryList);
    ipcMain.removeHandler(IPC_CHANNELS.memoryDelete);
    ipcMain.removeHandler(IPC_CHANNELS.memoryClear);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiPointer);
  };
}
