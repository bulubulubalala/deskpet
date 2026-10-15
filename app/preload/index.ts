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
  type CharacterSummary,
  type ChatCancelRequest,
  type ChatCancelResponse,
  type ChatEventEnvelope,
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
  type TtsAudioMessage,
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
    clear: (request: MemoryClearRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryClear, request) as Promise<MemoryClearResponse>,
  },
  characters: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.charList) as Promise<readonly CharacterSummary[]>,
  },
};

contextBridge.exposeInMainWorld("deskpet", api);
