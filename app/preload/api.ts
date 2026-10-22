/**
 * 文件职责：定义 window.deskpet 的形状（renderer 能看到的全部能力）。
 *
 * 为什么单独一个文件：这是渲染层与主进程之间的类型契约；renderer 只 import 这里的类型，
 * 具体实现留在 index.ts（contextBridge 只能在那里调用）。
 * 依赖方向：preload -> ../main/ipc（通道常量与 payload 类型）与 ../main/engine（只 import type）。
 */
import type { HealthView } from "../main/engine";
import type {
  AppInfo,
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
  MemoryContextRequest,
  MemoryContextResponse,
  MemoryListRequest,
  MemoryListResponse,
  MemoryMessagesRequest,
  MemoryMessagesResponse,
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
  ProviderCapability,
  ProviderSettingsPatchEntry,
  ProviderSettingsPayload,
  ProviderTestReport,
  TtsAudioMessage,
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
  VoiceStopRequest,
  VoiceStopResponse,
  VoiceStreamEvent,
} from "../main/ipc";

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
    /** 开始收音（D9 的语音输入键按下时）。 */
    start(): Promise<VoiceStatePayload>;
    /** 结束收音并送识别；heard=false 时提示「没听清」而不是发消息。 */
    stop(request: VoiceStopRequest): Promise<VoiceStopResponse>;
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
    /** 报一次拖动位移；主进程按当前窗口位置加上它（T2.2：JS 拖动，不用 app-region）。 */
    drag(message: UiDragMessage): void;
    /** 报当前输入模式（T2.6）：文字 / 语音 / 互动三选一。 */
    setInputMode(message: UiInputModeMessage): void;
    /** 提前报 demand 触摸：主进程立刻停播 + cancel，完整事实稍后仍走 touch()。 */
    touchIntent(message: TouchIntentMessage): void;
    /** 报一次立绘触摸（一串聚合）：main 记账，并决定要不要为它花一次 LLM（T2.3-C2c）。 */
    touch(message: TouchMessage): void;
    /** 请求把主窗收进托盘（不退出程序，T2.3-C2c）。 */
    minimize(): void;
  };
  readonly settings: {
    /** 打开设置窗（单实例）�?*/
    open(): Promise<void>;
  };
  readonly companion: {
    /** 打开主动陪伴设置独立窗口（单实例）。 */
    open(): Promise<void>;
  };
  readonly models: {
    list(): Promise<ModelStatus[]>;
    install(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    onProgress(listener: (progress: ModelProgress) => void): () => void;
  };
  /**
   * 模型供给（T1.14b / §6.13）：配置写在 .env，改完要重启 sidecar 才生效。
   * get 只回「密钥已配 / 未配」；set 里 api_key / local_token 传 null = 不改、"" = 清空。
   */
  readonly providers: {
    get(): Promise<ProviderSettingsPayload>;
    set(patch: readonly ProviderSettingsPatchEntry[]): Promise<ProviderSettingsPayload>;
    /** 让 sidecar 真的去连一次候选端点（云端 ASR / TTS 后置实现，会明说尚未实现）。 */
    test(capability: ProviderCapability): Promise<ProviderTestReport>;
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
    /** 开发者模式「原文」页（T2.3-B1）：翻该角色的历史原文，只读、按 id 倒序、一次一页。 */
    messages(request: MemoryMessagesRequest): Promise<MemoryMessagesResponse>;
    /** 开发者模式「注入上下文」页（T2.3-B1）：干跑一次下一轮装配，只看不 mark_used。 */
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
  };
}
