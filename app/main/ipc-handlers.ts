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
import {
  IPC_CHANNELS,
  type AppInfo,
  type ChatCancelRequest,
  type ChatCancelResponse,
  type ChatSendRequest,
  type ChatSendResponse,
  type VoiceStatePayload,
  type VoiceStopRequest,
  type VoiceStopResponse,
} from "./ipc";
import type { MainLogger } from "./logger";

export interface IpcHandlerDeps {
  readonly engine: SidecarEngine;
  readonly orchestrator: ChatOrchestrator;
  readonly logger: MainLogger;
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
  };
}
