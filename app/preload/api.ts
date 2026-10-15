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
  TtsAudioMessage,
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
  };
  readonly settings: {
    /** 打开设置窗（单实例）。 */
    open(): Promise<void>;
  };
  readonly characters: {
    /** 列出 characters/ 下可选角色（聊天条的角色切换弹出层）。 */
    list(): Promise<readonly CharacterSummary[]>;
  };
}
