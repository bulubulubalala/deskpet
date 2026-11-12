/**
 * 文件职责：定义 window.deskpet 的形状（renderer 能看到的全部能力）。
 *
 * 为什么单独一个文件：这是渲染层与主进程之间的类型契约；renderer 只 import 这里的类型，
 * 具体实现留在 index.ts（contextBridge 只能在那里调用）。
 * 依赖方向：preload -> ../main/ipc（通道常量与 payload 类型）与 ../main/engine（只 import type）。
 */
import type { HealthView } from "../shared/contracts/ipc";
import type {
  AppInfo,
  AppUpdateInfo,
  AsrModelState,
  TouchGateState,
  TouchIntentMessage,
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
  MemoryBehaviorResponse,
  MemoryClearRequest,
  MemoryClearResponse,
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
  MemoryContextRequest,
  MemoryContextResponse,
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
  MicStatus,
  NativeMicStartResponse,
  VoiceStatePayload,
  VoiceStreamEvent,
  SettingsPaneId,
} from "../shared/contracts/ipc";

/** 暴露给渲染层的 API；字段名与 ipc.ts 的通道一一对应。 */
export interface DeskpetApi {
  readonly health: {
    /** 主动拉一次心跳快照（界面刚加载时用）。 */
    get(): Promise<HealthView>;
    /** 订阅心跳推送；返回值是退订函数。 */
    onChanged(listener: (view: HealthView) => void): () => void;
  };
  readonly sidecar: {
    /** 手动重启 sidecar（不替用户修语音引擎，D14）。 */
    restart(): Promise<HealthView>;
  };
  readonly app: {
    getInfo(): Promise<AppInfo>;
    /** 手动检查更新：只问一次远端，不自动联网。 */
    checkUpdate(): Promise<AppUpdateInfo>;
    /** 打开这次查到的发布页（地址由主进程决定，界面传不了 URL）。 */
    openUpdatePage(): Promise<void>;
    /** 把已脱敏的错误详情写到系统剪贴板。 */
    copyText(text: string): Promise<void>;
  };
  readonly chat: {
    /** 发一句话；accepted=false 表示上一轮还没结束（先 cancel 再发）。 */
    send(request: ChatSendRequest): Promise<ChatSendResponse>;
    /** 打断：停播由渲染层做，这里作废在途的生成与合成。 */
    cancel(request: ChatCancelRequest): Promise<ChatCancelResponse>;
    /** 订阅 §6.2 事件流（台词 / 记忆 / 动作 / 结束 / 错误）。 */
    onEvent(listener: (envelope: ChatEventEnvelope) => void): () => void;
    /** 订阅合成好的音频（自己播放，不落盘）。 */
    onAudio(listener: (message: TtsAudioMessage) => void): () => void;
  };
  readonly voice: {
    /** 订阅语音状态（界面用它切换「在听 / 在想 / 在说」）。 */
    onState(listener: (payload: VoiceStatePayload) => void): () => void;
    /** 全双工（P2）：开始一句收音（WS audio.start）。 */
    begin(request: VoiceBeginRequest): void;
    /** 全双工（P2）：音频块上行（裸 PCM，16bit / 16k / 单声道）。 */
    audio(chunk: VoiceAudioChunk): void;
    /** 全双工（P2）：这一句说完了（WS audio.end）。 */
    end(request: VoiceEndRequest): void;
    /** 全双工（P2）：打断在途的识别 / 生成 / 合成。 */
    cancel(): void;
    /** 全双工（P2）：订阅 sidecar 推来的语音事件（asr.final / llm.s / error…）。 */
    onEvent(listener: (event: VoiceStreamEvent) => void): () => void;
    /** 当前 Windows 麦克风权限状态（设置页诊断用）。 */
    micStatus(): Promise<MicStatus>;
    /** 打开 Windows 麦克风隐私设置。 */
    openMicSettings(): Promise<void>;
    /** 打开 Windows 声音设置（选择默认输入设备 / 改采样率 / 关闭独占模式）。 */
    openSoundSettings(): Promise<void>;
    /** Chromium 麦克风不可用时，启动 sidecar 的 Windows 原生采集。 */
    startNative(): Promise<NativeMicStartResponse>;
    /** 停止原生采集；切走语音模式 / 退出时调用。 */
    stopNative(): Promise<void>;
    /** 主进程转发来的 48 kHz / 16-bit / 单声道 PCM。 */
    onNativeAudio(listener: (pcm: Uint8Array) => void): () => void;
    /** 原生采集进程出错 / 退出。 */
    onNativeError(listener: (message: string) => void): () => void;
  };
  /** 桌面形态（T1.12a）：位置 / 缩放 / 穿透 / 置顶 / 当前角色。 */
  readonly ui: {
    getState(): Promise<UiStatePayload>;
    setState(patch: UiStatePatch): Promise<UiStatePayload>;
    onStateChanged(listener: (state: UiStatePayload) => void): () => void;
    /** 报指针是否在立绘 / 聊天条范围内；主进程据此开关透明区穿透。 */
    pointer(message: UiPointerMessage): void;
    /** 报立绘包围盒与聊天条实测高度；主进程据此定窗口大小（T2.2 修）。 */
    metrics(message: UiMetricsMessage): void;
    /** 订阅全桌面鼠标位置（相对主窗内容区）；只有 Live2D 舞台开启追踪时主进程才推（T2.27）。 */
    onCursor(listener: (message: UiCursorMessage) => void): () => void;
    /** 开关全桌面鼠标追踪；Live2D 舞台创建时开，PNG / 销毁时关（T2.27）。 */
    setCursorTracking(enabled: boolean): void;
    /** 报一次拖动位移；主进程按当前窗口位置加上它（T2.2：JS 拖动，不用 app-region）。 */
    drag(message: UiDragMessage): void;
    /** 报当前输入模式（T2.6）：文字 / 语音 / 互动三选一。 */
    setInputMode(message: UiInputModeMessage): void;
    /** 提前报 demand 触摸：主进程立刻停播 + cancel，完整事实稍后仍走 touch()。 */
    touchIntent(message: TouchIntentMessage): void;
    /** 报一次立绘触摸（一串聚合）：main 记账，并决定要不要为它花一次 LLM（T2.3-C2c）。 */
    touch(message: TouchMessage): void;
    /** 订阅互动冷却 / 额度快照（T2.16）。 */
    onTouchGate(listener: (state: TouchGateState) => void): () => void;
    /** 请求把主窗收进托盘（不退出程序，T2.3-C2c）。 */
    minimize(): void;
  };
  readonly settings: {
    /** 打开设置窗（单实例）；pane 指定落在哪一页，不传 = 外观。 */
    open(pane?: SettingsPaneId): Promise<void>;
  };
  readonly companion: {
    /** 打开主动陪伴设置独立窗口（单实例）。 */
    open(): Promise<void>;
  };
  readonly usage: {
    stats(): Promise<UsageStats>;
    setRecording(enabled: boolean): Promise<UsageStats>;
    clear(): Promise<UsageStats>;
  };
  /** 数据导出（M3）：打一个 zip（记忆库快照 + 设置脱敏 + 角色 + 日志摘要）并返回它在磁盘上的位置。 */
  readonly data: {
    export(): Promise<DataExportResult>;
    /** 从数据包恢复记忆库：返回 null 表示用户取消了选择；真正替换发生在下次引擎启动时。 */
    restore(): Promise<DataRestoreResult | null>;
    /** 备份目录现状（D9）：每日快照 / 操作前留底 / 恢复残骸各有多少、多大。 */
    backups(): Promise<DataBackupsResult>;
    /** 立即备份一份；返回空路径表示没做成（记忆库没打开、磁盘满等）。 */
    backupNow(): Promise<DataBackupNowResult>;
    /** 在资源管理器里打开数据目录（备份在它的 backups/ 子目录里）。 */
    openDir(): Promise<void>;
  };
  readonly models: {
    list(): Promise<ModelStatus[]>;
    install(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    onProgress(listener: (progress: ModelProgress) => void): () => void;
  };
  /**
   * 语音识别模型（D7）：本地识别第一次用之前可以提前下好，避免点麦克风时静默等几百 MB。
   * model() 只读现状；prefetchModel() 只起任务，进度靠再调一次 model() 看。
   */
  readonly asr: {
    model(): Promise<AsrModelState>;
    prefetchModel(): Promise<AsrModelState>;
  };
  /**
   * 模型供给（T1.14b / §6.13）：配置写在 .env，改完要重启 sidecar 才生效。
   * get 只回「密钥已配 / 未配」；set 里 api_key / local_token 传 null = 不改、"" = 清空。
   */
  readonly providers: {
    get(): Promise<ProviderSettingsPayload>;
    set(patch: readonly ProviderSettingsPatchEntry[]): Promise<ProviderSettingsPayload>;
    /** 让 sidecar 真的去连一次候选端点（云端 ASR / TTS 后置实现，会明说尚未实现）。 */
    test(request: ProviderTestRequest): Promise<ProviderTestReport>;
    /** 拉取云端模型列表（支持当前表单未保存的 URL / 密钥）。 */
    listModels(request: ProviderModelsRequest): Promise<ProviderModelsResponse>;
  };
  /**
   * 记忆管理（T2.1b / §6.4）：界面只能看与删，写入永远由对话链路产生。
   * 记忆是增强项，这里失败只影响设置窗的这块面板，不影响聊天。
   */
  readonly memory: {
    list(request: MemoryListRequest): Promise<MemoryListResponse>;
    /** 删一条记忆；下一轮装配立刻看不到它（F3 验收 4）。 */
    remove(request: MemoryDeleteRequest): Promise<MemoryDeleteResponse>;
    /** 改一条 L0 记忆（开发者模式，T2.3-B2）；updated=false 表示该 id 不在。 */
    edit(request: MemoryEditRequest): Promise<MemoryEditResponse>;
    /** 清空该角色记忆；keep_days 不传 = 全清，返回真删掉的条数。 */
    clear(request: MemoryClearRequest): Promise<MemoryClearResponse>;
    /** 读 / 写「行为记忆」总开关（T2.1c）；enabled = null 只读，改完重启后台引擎生效。 */
    behavior(request: MemoryBehaviorRequest): Promise<MemoryBehaviorResponse>;
    /** 读语义检索状态（T2.32）：enabled / Ollama 可用性 / 已索引与待索引数。 */
    embeddingStatus(request: MemoryEmbeddingStatusRequest): Promise<MemoryEmbeddingStatus>;
    /** 读 / 写语义检索开关（T2.40）；enabled=null 只读，写后需重启 sidecar。 */
    embeddingConfig(request: MemoryEmbeddingConfigRequest): Promise<MemoryEmbeddingConfig>;
    /** 手动补索引消息/事实向量（T2.32）；返回本次之后的总索引数与剩余数。 */
    embeddingIndex(request: MemoryEmbeddingIndexRequest): Promise<MemoryEmbeddingIndexResponse>;
    /** 时间线列表 / 手动整理 / 单条详情（T2.33）。 */
    timeline(request: MemoryTimelineRequest): Promise<MemoryTimelineResponse>;
    rebuildTimeline(request: MemoryTimelineRebuildRequest): Promise<MemoryTimelineRebuildResponse>;
    backfillTimeline(
      request: MemoryTimelineBackfillRequest,
    ): Promise<MemoryTimelineRebuildResponse>;
    periodDetail(periodId: number): Promise<MemoryPeriodDetail>;
    editPeriod(request: MemoryPeriodEditRequest): Promise<MemoryPeriodItem>;
    /** 手动日记 CRUD（T2.33）。 */
    diary(request: MemoryDiaryListRequest): Promise<MemoryDiaryListResponse>;
    addDiary(request: MemoryDiaryWriteRequest): Promise<MemoryDiaryItem>;
    updateDiary(request: MemoryDiaryPatchRequest): Promise<MemoryDiaryItem>;
    deleteDiary(entryId: number): Promise<boolean>;
    /** 记忆网络（T2.33）：时间桶 / 事实 / 日记节点与来源边。 */
    graph(request: MemoryGraphRequest): Promise<MemoryGraphResponse>;
    rebuildGraph(request: MemoryGraphRebuildRequest): Promise<MemoryGraphRebuildResponse>;
    /** 关系记忆读写（T2.33）。 */
    intentions(request: MemoryIntentionsRequest): Promise<MemoryIntentionsResponse>;
    addIntention(request: MemoryIntentionWriteRequest): Promise<MemoryIntentionItem>;
    resolveIntention(intentionId: number): Promise<boolean>;
    relation(charId: string): Promise<MemoryRelationItem>;
    saveRelation(charId: string, request: MemoryRelationUpdateRequest): Promise<MemoryRelationItem>;
    /** 开发者模式「原文」页（T2.3-B1）：翻该角色的历史原文，按 id 倒序、一次一页。 */
    messages(request: MemoryMessagesRequest): Promise<MemoryMessagesResponse>;
    summaries(request: MemorySummariesRequest): Promise<MemorySummariesResponse>;
    editSummary(request: MemorySummaryEditRequest): Promise<MemorySummaryItem | null>;
    deleteSummary(summaryId: number): Promise<boolean>;
    editMessage(request: MemoryMessageEditRequest): Promise<MemoryMessageItem | null>;
    deleteMessage(messageId: number): Promise<boolean>;
    /** 开发者模式「注入上下文」页（T2.3-B1）：干跑一次下一轮装配，只读、不 mark_used。 */
    context(request: MemoryContextRequest): Promise<MemoryContextResponse>;
  };
  /**
   * 开发者模式开关（T2.3-B1）：存在 data/dev.json，不是安全边界，只控制设置窗显隐。
   * get 读当前值；set 传 enabled = null 表示只读（与 memory.behavior 同一套语义）。
   */
  readonly dev: {
    get(): Promise<DevModeResponse>;
    set(request: DevModeRequest): Promise<DevModeResponse>;
  };
  readonly characters: {
    /** 列出 characters/ 下可选角色（聊天条的角色切换弹出层）。 */
    list(): Promise<readonly CharacterSummary[]>;
    /** 读角色包立绘（data URL）；null = 这个包没有立绘，界面用内置占位图（T2.3-C2）。 */
    portrait(request: CharacterPortraitRequest): Promise<CharacterPortraitResponse>;
    /** 读角色包部位定义 hits.json；空数组 = 这个包还没画部位（T2.3-C2）。 */
    hits(request: CharacterHitsRequest): Promise<CharacterHitsResponse>;
    /** 读角色包形象配置 appearance.json；null = 这个包没有形象配置，回退 PNG 占位（T2.4）。 */
    appearance(request: CharacterAppearanceRequest): Promise<CharacterAppearanceResponse>;
    /** 订阅「characters/ 变了」：编辑器存下新角色包后，角色菜单要跟着刷新（T2.3-D）。 */
    onChanged(listener: (message: CharactersChangedMessage) => void): () => void;
    /**
     * 订阅「主进程要网格几何」（T2.44）：编辑器点「按模型网格生成部位」时，
     * 主进程会问主窗要一遍网格外接框；拿到后必须 replyHitsProbe 回话，否则那边会超时。
     */
    onHitsProbe(listener: (message: HitsProbeMessage) => void): () => void;
    replyHitsProbe(reply: HitsProbeReplyMessage): void;
  };
  /**
   * 角色包编辑器（T2.3-D）：上传 PNG → 裁切 → 画部位 → 填卡片 → 写 characters/<char_id>/。
   * 选图与写盘都在主进程：渲染层拿不到 fs，也不放开 CSP 的 file:。
   */
  readonly pack: {
    /** 打开编辑器独立窗口（单实例；再点只是拎到前台）。edit 只编辑部位，card 只编辑人设。 */
    openEditor(request?: PackOpenEditorRequest): Promise<void>;
    /** 弹系统文件选择框选立绘；canceled=true 表示用户关掉了对话框（不是错误）。 */
    pickImage(): Promise<PackPickImageResponse>;
    /** 落盘；ok=false 时 error 是给用户看的一句话（目录已存在 / 图片不合法 / 写盘失败）。 */
    save(request: PackSaveRequest): Promise<PackSaveResponse>;
    /** 编辑模式：读现有角色包（立绘 + 卡片展示字段 + 部位）。 */
    load(request: PackLoadRequest): Promise<PackLoadResponse>;
    /** 编辑模式：只把部位写回 hits.json。 */
    saveRegions(request: PackSaveRegionsRequest): Promise<PackSaveResponse>;
    /** 角色卡模式：只把显示名 / 简介 / 人格 / 说话风格写回 card.json + pack.json。 */
    saveCard(request: PackSaveCardRequest): Promise<PackSaveResponse>;
    /** 导出当前角色为 zip；主进程弹保存对话框。 */
    exportPack(request: PackExportRequest): Promise<PackExportResponse>;
    /** 选择 zip 导入角色包；主进程负责预览、冲突确认和落盘。 */
    importPack(request: PackImportRequest): Promise<PackImportResponse>;
    /**
     * 按 Live2D 网格顶点生成部位框（T2.44）：主进程转发给主窗算几何。
     * 只生成草稿，不落盘；主窗显示的不是这个角色时 ok=false + error 一句话。
     */
    generateRegions(request: PackGenerateRegionsRequest): Promise<PackGenerateRegionsResponse>;
    /** 拖拽文件时取绝对路径（Electron webUtils）；不传回渲染层做文件读取。 */
    pathForFile(file: File): string;
  };
}
