/**
 * 文件职责：通过 contextBridge 把 DeskpetApi 挂到 window.deskpet（需求 §6.10）。
 *
 * 为什么只暴露这一层：contextIsolation 打开时渲染层拿不到 ipcRenderer，
 * 白名单方法必须在这里显式转发，渲染层无法自己拼 channel 名去 invoke 别的接口。
 * 依赖方向：preload -> electron（contextBridge / ipcRenderer）+ ./api（类型）+ ../main/ipc（通道常量）。
 * 谁调用：Electron 在页面加载前自动执行（webPreferences.preload 指向打包后的 dist/preload/index.js）。
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { HealthView } from "../shared/contracts/ipc";
import type {
  AppInfo,
  AppUpdateInfo,
  AsrModelState,
  SettingsPaneId,
  TouchIntentMessage,
  TouchGateState,
  TouchMessage,
  CharacterAppearanceRequest,
  CharacterAppearanceResponse,
  CharacterHitsRequest,
  CharacterHitsResponse,
  CharacterPortraitRequest,
  CharacterPortraitResponse,
  CharacterSummary,
  ChatCancelRequest,
  ChatCancelResponse,
  ChatEventEnvelope,
  ChatSendRequest,
  ChatSendResponse,
  CharactersChangedMessage,
  DevModeRequest,
  DevModeResponse,
  MemoryBehaviorRequest,
  MicStatus,
  MemoryBehaviorResponse,
  MemoryClearRequest,
  MemoryClearResponse,
  MemoryContextRequest,
  MemoryContextResponse,
  MemoryDeleteRequest,
  MemoryDeleteResponse,
  MemoryEditRequest,
  MemoryEditResponse,
  MemoryEmbeddingConfig,
  MemoryEmbeddingConfigRequest,
  MemoryEmbeddingIndexRequest,
  MemoryEmbeddingIndexResponse,
  MemoryEmbeddingStatus,
  MemoryEmbeddingStatusRequest,
  MemoryDiaryItem,
  MemoryDiaryListRequest,
  MemoryDiaryListResponse,
  MemoryDiaryPatchRequest,
  MemoryDiaryWriteRequest,
  MemoryGraphRebuildRequest,
  MemoryGraphRebuildResponse,
  MemoryGraphRequest,
  MemoryGraphResponse,
  MemoryIntentionItem,
  MemoryIntentionWriteRequest,
  MemoryIntentionsRequest,
  MemoryIntentionsResponse,
  MemoryPeriodDetail,
  MemoryPeriodEditRequest,
  MemoryPeriodItem,
  MemoryRelationItem,
  MemoryRelationUpdateRequest,
  MemoryTimelineBackfillRequest,
  MemoryTimelineRebuildRequest,
  MemoryTimelineRebuildResponse,
  MemoryTimelineRequest,
  MemoryTimelineResponse,
  MemoryListRequest,
  MemoryListResponse,
  MemoryMessagesRequest,
  MemoryMessagesResponse,
  MemoryMessageEditRequest,
  MemoryMessageItem,
  MemorySummariesRequest,
  MemorySummariesResponse,
  MemorySummaryEditRequest,
  MemorySummaryItem,
  ModelProgress,
  ModelStatus,
  NativeMicStartResponse,
  PackPickImageResponse,
  PackLoadRequest,
  PackLoadResponse,
  PackOpenEditorRequest,
  PackSaveCardRequest,
  PackSaveRegionsRequest,
  PackSaveRequest,
  PackSaveResponse,
  PackExportRequest,
  PackExportResponse,
  PackGenerateRegionsRequest,
  PackGenerateRegionsResponse,
  HitsProbeMessage,
  HitsProbeReplyMessage,
  PackImportRequest,
  PackImportResponse,
  ProviderSettingsPatchEntry,
  ProviderSettingsPayload,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ProviderTestReport,
  ProviderTestRequest,
  DataBackupNowResult,
  DataBackupsResult,
  DataExportResult,
  DataRestoreResult,
  TtsAudioMessage,
  UsageStats,
  UiCursorMessage,
  UiDragMessage,
  UiInputModeMessage,
  UiMetricsMessage,
  UiPointerMessage,
  UiStatePatch,
  UiStatePayload,
  VoiceAudioChunk,
  VoiceBeginRequest,
  VoiceEndRequest,
  VoiceStatePayload,
  VoiceStreamEvent,
} from "../shared/contracts/ipc";
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
    checkUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.appCheckUpdate) as Promise<AppUpdateInfo>,
    openUpdatePage: () => ipcRenderer.invoke(IPC_CHANNELS.appOpenUpdatePage) as Promise<void>,
    copyText: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.appCopyText, text) as Promise<void>,
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
    onState: (listener) => subscribe<VoiceStatePayload>(IPC_CHANNELS.voiceState, listener),
    // 全双工（P2）：单向消息，主进程把音频块塞进 WS；事件由 voiceEvent 推回来
    begin: (request: VoiceBeginRequest) => {
      ipcRenderer.send(IPC_CHANNELS.voiceBegin, request);
    },
    audio: (chunk: VoiceAudioChunk) => {
      ipcRenderer.send(IPC_CHANNELS.voiceAudio, chunk);
    },
    end: (request: VoiceEndRequest) => {
      ipcRenderer.send(IPC_CHANNELS.voiceEnd, request);
    },
    cancel: () => {
      ipcRenderer.send(IPC_CHANNELS.voiceCancel);
    },
    onEvent: (listener) => subscribe<VoiceStreamEvent>(IPC_CHANNELS.voiceEvent, listener),
    micStatus: () => ipcRenderer.invoke(IPC_CHANNELS.voiceMicStatus) as Promise<MicStatus>,
    openMicSettings: () => ipcRenderer.invoke(IPC_CHANNELS.voiceOpenMicSettings) as Promise<void>,
    openSoundSettings: () =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceOpenSoundSettings) as Promise<void>,
    startNative: () =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceNativeStart) as Promise<NativeMicStartResponse>,
    stopNative: () => ipcRenderer.invoke(IPC_CHANNELS.voiceNativeStop) as Promise<void>,
    onNativeAudio: (listener) => subscribe<Uint8Array>(IPC_CHANNELS.voiceNativeAudio, listener),
    onNativeError: (listener) => subscribe<string>(IPC_CHANNELS.voiceNativeError, listener),
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
    // 全桌面鼠标追踪：主进程轮询系统光标后推相对坐标；开关是单向消息（T2.27）
    onCursor: (listener) => subscribe<UiCursorMessage>(IPC_CHANNELS.uiCursor, listener),
    setCursorTracking: (enabled: boolean) => {
      ipcRenderer.send(IPC_CHANNELS.uiCursorTrack, { enabled });
    },
    // JS 拖动位移：单向，主进程收到就直接移动窗口（T2.2）
    drag: (message: UiDragMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiDrag, message);
    },
    // 输入模式（T2.6）：单向；主进程据此拒绝跨模式输入并清理旧模式的排队触摸
    setInputMode: (message: UiInputModeMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiInputMode, message);
    },
    // demand 触摸刚成立：只用来提前停播 + cancel，完整事实随后仍走 touch()
    touchIntent: (message: TouchIntentMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiTouchIntent, message);
    },
    // 触摸：同样单向，记账与「要不要花一次 LLM」都在主进程（T2.3-C2c）
    touch: (message: TouchMessage) => {
      ipcRenderer.send(IPC_CHANNELS.uiCharHit, message);
    },
    onTouchGate: (listener) => subscribe<TouchGateState>(IPC_CHANNELS.uiTouchGate, listener),
    // 最小化到托盘：单向，hide() 之后没有要回传的东西（T2.3-C2c）
    minimize: () => {
      ipcRenderer.send(IPC_CHANNELS.uiMinimize);
    },
  },
  settings: {
    open: (pane?: SettingsPaneId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.settingsOpen,
        pane === undefined ? {} : { pane },
      ) as Promise<void>,
  },
  companion: {
    open: () => ipcRenderer.invoke(IPC_CHANNELS.companionOpen) as Promise<void>,
  },
  usage: {
    stats: () => ipcRenderer.invoke(IPC_CHANNELS.usageStats) as Promise<UsageStats>,
    setRecording: (enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.usageSetRecording, enabled) as Promise<UsageStats>,
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.usageClear) as Promise<UsageStats>,
  },
  data: {
    export: () => ipcRenderer.invoke(IPC_CHANNELS.dataExport) as Promise<DataExportResult>,
    restore: () =>
      ipcRenderer.invoke(IPC_CHANNELS.dataRestore) as Promise<DataRestoreResult | null>,
    backups: () => ipcRenderer.invoke(IPC_CHANNELS.dataBackups) as Promise<DataBackupsResult>,
    backupNow: () => ipcRenderer.invoke(IPC_CHANNELS.dataBackupNow) as Promise<DataBackupNowResult>,
    openDir: () => ipcRenderer.invoke(IPC_CHANNELS.dataOpenDir) as Promise<void>,
  },
  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList) as Promise<ModelStatus[]>,
    install: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsInstall, id) as Promise<void>,
    remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.modelsRemove, id) as Promise<void>,
    onProgress: (listener) => subscribe<ModelProgress>(IPC_CHANNELS.modelsProgress, listener),
  },
  asr: {
    model: () => ipcRenderer.invoke(IPC_CHANNELS.asrModel) as Promise<AsrModelState>,
    prefetchModel: () =>
      ipcRenderer.invoke(IPC_CHANNELS.asrModelPrefetch) as Promise<AsrModelState>,
  },
  providers: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.providersGet) as Promise<ProviderSettingsPayload>,
    set: (patch: readonly ProviderSettingsPatchEntry[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.providersSet, patch) as Promise<ProviderSettingsPayload>,
    test: (request: ProviderTestRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.providersTest, request) as Promise<ProviderTestReport>,
    listModels: (request: ProviderModelsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.providersModels, request) as Promise<ProviderModelsResponse>,
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
    embeddingStatus: (request: MemoryEmbeddingStatusRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryEmbeddingStatus,
        request,
      ) as Promise<MemoryEmbeddingStatus>,
    embeddingConfig: (request: MemoryEmbeddingConfigRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryEmbeddingConfig,
        request,
      ) as Promise<MemoryEmbeddingConfig>,
    embeddingIndex: (request: MemoryEmbeddingIndexRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryEmbeddingIndex,
        request,
      ) as Promise<MemoryEmbeddingIndexResponse>,
    timeline: (request: MemoryTimelineRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryTimeline, request) as Promise<MemoryTimelineResponse>,
    rebuildTimeline: (request: MemoryTimelineRebuildRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryTimelineRebuild,
        request,
      ) as Promise<MemoryTimelineRebuildResponse>,
    backfillTimeline: (request: MemoryTimelineBackfillRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryTimelineBackfill,
        request,
      ) as Promise<MemoryTimelineRebuildResponse>,
    periodDetail: (periodId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryPeriodDetail, periodId) as Promise<MemoryPeriodDetail>,
    editPeriod: (request: MemoryPeriodEditRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryPeriodEdit, request) as Promise<MemoryPeriodItem>,
    diary: (request: MemoryDiaryListRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDiaryList, request) as Promise<MemoryDiaryListResponse>,
    addDiary: (request: MemoryDiaryWriteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDiaryAdd, request) as Promise<MemoryDiaryItem>,
    updateDiary: (request: MemoryDiaryPatchRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDiaryUpdate, request) as Promise<MemoryDiaryItem>,
    deleteDiary: (entryId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDiaryDelete, entryId) as Promise<boolean>,
    graph: (request: MemoryGraphRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryGraph, request) as Promise<MemoryGraphResponse>,
    rebuildGraph: (request: MemoryGraphRebuildRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryGraphRebuild,
        request,
      ) as Promise<MemoryGraphRebuildResponse>,
    intentions: (request: MemoryIntentionsRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryIntentions,
        request,
      ) as Promise<MemoryIntentionsResponse>,
    addIntention: (request: MemoryIntentionWriteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryIntentionAdd, request) as Promise<MemoryIntentionItem>,
    resolveIntention: (intentionId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryIntentionResolve, intentionId) as Promise<boolean>,
    relation: (charId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryRelationGet, charId) as Promise<MemoryRelationItem>,
    saveRelation: (charId: string, request: MemoryRelationUpdateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryRelationSave, {
        char_id: charId,
        request,
      }) as Promise<MemoryRelationItem>,
    messages: (request: MemoryMessagesRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryMessages, request) as Promise<MemoryMessagesResponse>,
    summaries: (request: MemorySummariesRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.memorySummaries, request) as Promise<MemorySummariesResponse>,
    editSummary: (request: MemorySummaryEditRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryEditSummary,
        request,
      ) as Promise<MemorySummaryItem | null>,
    deleteSummary: (summaryId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDeleteSummary, summaryId) as Promise<boolean>,
    editMessage: (request: MemoryMessageEditRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.memoryEditMessage,
        request,
      ) as Promise<MemoryMessageItem | null>,
    deleteMessage: (messageId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDeleteMessage, messageId) as Promise<boolean>,
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
    /** 主进程问「这几个网格画在哪儿」（T2.44）：主窗算完用 replyHitsProbe 回。 */
    onHitsProbe: (listener) => subscribe<HitsProbeMessage>(IPC_CHANNELS.hitsProbe, listener),
    /** 网格外接框的答复；不走 invoke，因为它是 main 主动发起的问答。 */
    replyHitsProbe: (reply: HitsProbeReplyMessage) => {
      ipcRenderer.send(IPC_CHANNELS.hitsProbeReply, reply);
    },
  },
  // 角色包编辑器（T2.3-D）：打开窗口、选图、落盘三条都直接转发给主进程
  pack: {
    openEditor: (request?: PackOpenEditorRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.packOpenEditor,
        request ?? { mode: "create" },
      ) as Promise<void>,
    pickImage: () =>
      ipcRenderer.invoke(IPC_CHANNELS.packPickImage) as Promise<PackPickImageResponse>,
    save: (request: PackSaveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.packSave, request) as Promise<PackSaveResponse>,
    load: (request: PackLoadRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.packLoad, request) as Promise<PackLoadResponse>,
    saveRegions: (request: PackSaveRegionsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.packSaveRegions, request) as Promise<PackSaveResponse>,
    saveCard: (request: PackSaveCardRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.packSaveCard, request) as Promise<PackSaveResponse>,
    exportPack: (request: PackExportRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.packExport, request) as Promise<PackExportResponse>,
    importPack: (request: PackImportRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.packImport, request) as Promise<PackImportResponse>,
    /** 按 Live2D 网格顶点生成部位框（T2.44）：主进程去问主窗要几何。 */
    generateRegions: (request: PackGenerateRegionsRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.packGenerateRegions,
        request,
      ) as Promise<PackGenerateRegionsResponse>,
    pathForFile: (file: File) => webUtils.getPathForFile(file),
  },
};

contextBridge.exposeInMainWorld("deskpet", api);
