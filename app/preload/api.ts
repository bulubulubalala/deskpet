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
  CharacterSummary,
  ChatCancelRequest,
  ChatCancelResponse,
  ChatEventEnvelope,
  ChatSendRequest,
  ChatSendResponse,
  MemoryClearRequest,
  MemoryClearResponse,
  MemoryDeleteRequest,
  MemoryDeleteResponse,
  MemoryListRequest,
  MemoryListResponse,
  ProviderCapability,
  ProviderSettingsPatchEntry,
  ProviderSettingsPayload,
  ProviderTestReport,
  TtsAudioMessage,
  UiMetricsMessage,
  UiPointerMessage,
  UiStatePatch,
  UiStatePayload,
  VoiceStatePayload,
  VoiceStopRequest,
  VoiceStopResponse,
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
  };
  readonly settings: {
    /** 打开设置窗（单实例）。 */
    open(): Promise<void>;
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
    /** 清空该角色记忆；keep_days 不传 = 全清，返回真删掉的条数。 */
    clear(request: MemoryClearRequest): Promise<MemoryClearResponse>;
  };
  readonly characters: {
    /** 列出 characters/ 下可选角色（聊天条的角色切换弹出层）。 */
    list(): Promise<readonly CharacterSummary[]>;
  };
}
