/**
 * 文件职责：通过 contextBridge 把 DeskpetApi 挂到 window.deskpet（需求 §6.10）。
 *
 * 为什么只暴露这一层：contextIsolation 打开时渲染层拿不到 ipcRenderer，
 * 白名单方法必须在这里显式转发，渲染层无法自己拼 channel 名去 invoke 别的接口。
 * 依赖方向：preload -> electron（contextBridge / ipcRenderer）+ ./api（类型）+ ../main/ipc（通道常量）。
 * 谁调用：Electron 在页面加载前自动执行（webPreferences.preload 指向打包后的 dist/preload/index.js）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { HealthView } from "../main/engine";
import {
  IPC_CHANNELS,
  type AppInfo,
  type TouchMessage,
  type CharacterAppearanceRequest,
  type CharacterAppearanceResponse,
  type CharacterHitsRequest,
  type CharacterHitsResponse,
  type CharacterPortraitRequest,
  type CharacterPortraitResponse,
  type CharacterSummary,
  type ChatCancelRequest,
  type ChatCancelResponse,
  type ChatEventEnvelope,
  type ChatSendRequest,
  type ChatSendResponse,
  type CharactersChangedMessage,
  type DevModeRequest,
  type DevModeResponse,
  type MemoryBehaviorRequest,
  type MemoryBehaviorResponse,
  type MemoryClearRequest,
  type MemoryClearResponse,
  type MemoryContextRequest,
  type MemoryContextResponse,
  type MemoryDeleteRequest,
  type MemoryDeleteResponse,
  type MemoryEditRequest,
  type MemoryEditResponse,
  type MemoryListRequest,
  type MemoryListResponse,
  type MemoryMessagesRequest,
  type MemoryMessagesResponse,
  type PackPickImageResponse,
  type PackSaveRequest,
  type PackSaveResponse,
  type ProviderCapability,
  type ProviderSettingsPatchEntry,
  type ProviderSettingsPayload,
  type ProviderTestReport,
  type TtsAudioMessage,
  type UiDragMessage,
  type UiMetricsMessage,
  type UiPointerMessage,
  type UiStatePatch,
  type UiStatePayload,
  type VoiceStatePayload,
  type VoiceStopRequest,
  type VoiceStopResponse,
} from "../main/ipc";
import type { DeskpetApi } from "./api";

/** 订阅一个主进程推送通道；返回值是退订函数（与 onChanged 同一套写法）。 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: DeskpetApi = {
  health: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.healthGet) as Promise<HealthView>,
    onChanged: (listener) => subscribe<HealthView>(IPC_CHANNELS.healthChanged, listener),
  },
  sidecar: {
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.sidecarRestart) as Promise<HealthView>,
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo) as Promise<AppInfo>,
  },
  chat: {
    send: (request: ChatSendRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSend, request) as Promise<ChatSendResponse>,
    cancel: (request: ChatCancelRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCancel, request) as Promise<ChatCancelResponse>,
    onEvent: (listener) => subscribe<ChatEventEnvelope>(IPC_CHANNELS.chatEvent, listener),
    onAudio: (listener) => subscribe<TtsAudioMessage>(IPC_CHANNELS.ttsAudio, listener),
  },
  voice: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.voiceStart) as Promise<VoiceStatePayload>,
    stop: (request: VoiceStopRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceStop, request) as Promise<VoiceStopResponse>,
    onState: (listener) => subscribe<VoiceStatePayload>(IPC_CHANNELS.voiceState, listener),
  },
  ui: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.uiGetState) as Promise<UiStatePayload>,
    setState: (patch: UiStatePatch) =>
      ipcRenderer.invoke(IPC_CHANNELS.uiSetState, patch) as Promise<UiStatePayload>,
    onStateChanged: (listener) => subscribe<UiStatePayload>(IPC_CHANNELS.uiStateChanged, listener),
    // 单向消息：主进程不需要回执，界面也不该等回执
    pointer: (message: UiPointerMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiPointer, message);
    },
    // 立绘包围盒与聊天条实测高度：同样单向，主进程收到就直接改窗口
    metrics: (message: UiMetricsMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiMetrics, message);
    },
    // JS 拖动位移：单向，主进程收到就直接移动窗口（T2.2）
    drag: (message: UiDragMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiDrag, message);
    },
    // 触摸：同样单向，记账与「要不要花一次 LLM」都在主进程（T2.3-C2c）
    touch: (message: TouchMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiCharHit, message);
    },
    // 最小化到托盘：单向，hide() 之后没有要回传的东西（T2.3-C2c）
    minimize: () => {
      ipcRenderer.send(IPC_CHANNELS.uiMinimize);
    },
  },
  settings: {
    open: () => ipcRenderer.invoke(IPC_CHANNELS.settingsOpen) as Promise<void>,
  },
  providers: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.providersGet) as Promise<ProviderSettingsPayload>,
    set: (patch: readonly ProviderSettingsPatchEntry[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.providersSet, patch) as Promise<ProviderSettingsPayload>,
    test: (capability: ProviderCapability) =>
      ipcRenderer.invoke(IPC_CHANNELS.providersTest, capability) as Promise<ProviderTestReport>,
  },
  memory: {
    list: (request: MemoryListRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryList, request) as Promise<MemoryListResponse>,
    remove: (request: MemoryDeleteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDelete, request) as Promise<MemoryDeleteResponse>,
    edit: (request: MemoryEditRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryEdit, request) as Promise<MemoryEditResponse>,
    clear: (request: MemoryClearRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryClear, request) as Promise<MemoryClearResponse>,
    behavior: (request: MemoryBehaviorRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryBehavior, request) as Promise<MemoryBehaviorResponse>,
    messages: (request: MemoryMessagesRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryMessages, request) as Promise<MemoryMessagesResponse>,
    context: (request: MemoryContextRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryContext, request) as Promise<MemoryContextResponse>,
  },
  // 开发者模式开关：只读写 data/dev.json，不进角色包也不进 .env（T2.3-B1）
  dev: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.devModeGet) as Promise<DevModeResponse>,
    set: (request: DevModeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.devModeSet, request) as Promise<DevModeResponse>,
  },
  characters: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.charList) as Promise<readonly CharacterSummary[]>,
    portrait: (request: CharacterPortraitRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.charPortrait, request) as Promise<CharacterPortraitResponse>,
    hits: (request: CharacterHitsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.charHits, request) as Promise<CharacterHitsResponse>,
    appearance: (request: CharacterAppearanceRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.charAppearance,
        request,
      ) as Promise<CharacterAppearanceResponse>,
    onChanged: (listener) =>
      subscribe<CharactersChangedMessage>(IPC_CHANNELS.charactersChanged, listener),
  },
  // 角色包编辑器（T2.3-D）：打开窗口、选图、落盘三条都直接转发给主进程
  pack: {
    openEditor: () => ipcRenderer.invoke(IPC_CHANNELS.packOpenEditor) as Promise<void>,
    pickImage: () =>
      ipcRenderer.invoke(IPC_CHANNELS.packPickImage) as Promise<PackPickImageResponse>,
    save: (request: PackSaveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.packSave, request) as Promise<PackSaveResponse>,
  },
};

contextBridge.exposeInMainWorld("deskpet", api);
