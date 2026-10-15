/**
 * 文件职责：renderer ↔ main 的 IPC 白名单契约（channel 常量 + payload 类型）。
 *
 * 依据：需求 §6.3（sidecar HTTP API）、§6.10（IPC 白名单）、CODE_STYLE §1.1 / §1.3。
 * 依赖方向：本模块不 import electron；main 用它注册 handler，preload 用它暴露白名单方法。
 * 谁调用：app/main/index.ts 与 app/preload/index.ts（T0.6 接上）。
 */

/** 白名单通道：只允许这些名字出现在 ipcMain.handle / ipcRenderer.invoke。 */
export const IPC_CHANNELS = {
  /** renderer 拉取一次心跳快照（main 转发 sidecar GET /health） */
  healthGet: "deskpet:health:get",
  /** main 推送心跳变化（连续 3 次失败判定离线后也会推，需求 §7.2） */
  healthChanged: "deskpet:health:changed",
  /** 手动重启 sidecar（不替用户修语音引擎，D14） */
  sidecarRestart: "deskpet:sidecar:restart",
  /** 取应用与 sidecar 的基本信息（版本号、端口、pid） */
  appGetInfo: "deskpet:app:get-info",
  /** 用户发一句话（聊天框回车或 ASR 结果）→ main 转发 sidecar POST /chat/stream（T1.3 实现） */
  chatSend: "deskpet:chat:send",
  /** main 推送 sidecar 流里的单个 §6.2 事件（T1.3 实现） */
  chatEvent: "deskpet:chat:event",
  /** 打断当前回复：停播 + 取消进行中的 TTS 与 LLM 流（F2，T1.6 实现） */
  chatCancel: "deskpet:chat:cancel",
  /** 开始收音（语音输入键，D9；T1.6 实现） */
  voiceStart: "deskpet:voice:start",
  /** 结束收音并送 ASR（T1.6 实现） */
  voiceStop: "deskpet:voice:stop",
  /** 语音状态机状态广播（main → renderer；任何错误路径都必须复位，§6.7） */
  voiceState: "deskpet:voice:state",
  /**
   * main → renderer 推一句合成好的语音（T1.6b）。
   *
   * 为什么必须新开通道：§6.10 原定的十条通道里没有能承载音频字节的；TTS 是「main 主动推」，
   * 不能靠 renderer 轮询。音频只走 IPC 内存，不落盘（§7.3）。
   */
  ttsAudio: "deskpet:tts:audio",
  /** renderer 拉一次界面状态（位置 / 缩放 / 穿透 / 置顶 / 当前角色，T1.12a） */
  uiGetState: "deskpet:ui:get-state",
  /** renderer 存界面状态；main 套用到窗口并回最新状态（T1.12a） */
  uiSetState: "deskpet:ui:set-state",
  /** main 推界面状态变化，让主窗与设置窗显示一致（T1.12a） */
  uiStateChanged: "deskpet:ui:state-changed",
  /** renderer 报指针是否落在立绘 / 聊天条范围内，main 据此开关透明区穿透（§6.11，T1.12a） */
  uiPointer: "deskpet:ui:pointer",
  /** 打开设置窗（聊天条与托盘两个入口都能到，F11，T1.12a） */
  settingsOpen: "deskpet:settings:open",
  /** 列出 characters/ 下的可选角色，供聊天条「角色切换」弹出层（T1.12a） */
  charList: "deskpet:char:list",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** 会被心跳观察的模块名，与 sidecar/contracts/health.py 的 ModuleName 对齐。 */
export const MODULE_NAMES = ["tts", "asr", "llm", "memory", "screen", "stage"] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

/** 模块状态，与 sidecar/contracts/health.py 的 ModuleState 对齐。 */
export const MODULE_STATES = ["idle", "loading", "ready", "error", "offline"] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

/** ModuleHealth 的字段清单（运行时可取，供跨语言契约测试对账）。 */
export const MODULE_HEALTH_FIELDS = ["name", "state", "detail"] as const;

export interface ModuleHealth {
  name: ModuleName;
  state: ModuleState;
  detail?: string;
}

/** GpuUsage 的字段清单（运行时可取）。 */
export const GPU_USAGE_FIELDS = ["loaded_mb", "total_mb"] as const;

export interface GpuUsage {
  loaded_mb: number;
  total_mb?: number;
}

/** sidecar GET /health 的镜像；字段名必须与 contracts/health.py 的 HealthResponse 一致。 */
export const HEALTH_SNAPSHOT_FIELDS = [
  "status",
  "uptime_s",
  "modules",
  "gpu",
  "voice",
  "version",
] as const;

export interface HealthSnapshot {
  status: "ok" | "degraded" | "starting";
  uptime_s: number;
  modules: ModuleHealth[];
  gpu: GpuUsage;
  voice: VoiceState;
  version: string;
}

/** IPC appGetInfo 的返回：sidecar 未起来时端口与 pid 为空。 */
export interface AppInfo {
  app_version: string;
  sidecar_port?: number;
  sidecar_pid?: number;
}

/** 聊天输入来源：聊天框打字 / 语音识别结果（与 sidecar ChatStreamRequest 对齐）。 */
export const CHAT_INPUT_MODES = ["text", "voice"] as const;
export type ChatInputMode = (typeof CHAT_INPUT_MODES)[number];

/** renderer → main：发一句话（IPC chatSend 的入参，字段对齐 §6.3 的 ChatStreamRequest）。 */
export interface ChatSendRequest {
  session_id: string;
  char_id: string;
  text: string;
  input_mode?: ChatInputMode;
  client_ts?: number;
}

/** §6.2 事件的判别值；sidecar 侧的唯一定义在 contracts/events.py，两侧必须同时改。 */
export const CHAT_EVENT_KINDS = ["s", "m", "a", "end", "e"] as const;
export type ChatEventKind = (typeof CHAT_EVENT_KINDS)[number];

/**
 * 每种事件的字段清单（运行时可取，供跨语言契约测试对账）。
 *
 * 为什么不用联合类型的字面量当唯一来源：类型在运行时不存在，而契约测试需要能遍历字段名。
 */
export const CHAT_EVENT_FIELDS: Record<ChatEventKind, readonly string[]> = {
  s: ["t", "i", "text", "emotion", "intensity", "act"],
  m: ["t", "kind", "text", "importance"],
  a: ["t", "act", "why"],
  end: ["t"],
  e: ["t", "code", "user_hint", "recoverable"],
};

/** 一句话：逐句播报，并驱动表情与动作（对应 SentenceEvent）。 */
export interface ChatSentenceEvent {
  t: "s";
  i: number;
  text: string;
  emotion?: string;
  intensity: number;
  act?: string;
}

/** 要写进记忆的事实（对应 MemoryEvent；去重与重要度计算在 M2）。 */
export interface ChatMemoryEvent {
  t: "m";
  kind: "fact" | "preference" | "event";
  text: string;
  importance: number;
}

/** 只驱动形象、不说话的动作（对应 ActEvent）。 */
export interface ChatActEvent {
  t: "a";
  act: string;
  why?: string;
}

/** 本轮回复结束（对应 EndEvent）。 */
export interface ChatEndEvent {
  t: "end";
}

/** 技术故障提示（对应 ErrorEvent，§6.7 的 A 级降级）；与角色台词分开显示。 */
export interface ChatErrorEvent {
  t: "e";
  code: string;
  user_hint: string;
  recoverable: boolean;
}

export type ChatEvent =
  ChatSentenceEvent | ChatMemoryEvent | ChatActEvent | ChatEndEvent | ChatErrorEvent;

/** main → renderer 的事件信封：seq 单调递增，便于 renderer 丢弃乱序或重复的事件。 */
export interface ChatEventEnvelope {
  session_id: string;
  seq: number;
  event: ChatEvent;
}

/** renderer → main：打断（停播 + 取消合成与生成）。cancelled=false 表示那条已经结束，属正常。 */
export interface ChatCancelRequest {
  session_id: string;
  request_id?: string;
}

export interface ChatCancelResponse {
  cancelled: boolean;
  reason?: string;
}

/**
 * IPC chatSend 的应答：只表示「这轮有没有接下来」，台词走 chatEvent 事件流。
 * accepted=false 说明上一轮还在跑（reason 给人看），界面别把它当失败。
 */
export interface ChatSendResponse {
  accepted: boolean;
  session_id: string;
  reason?: string;
}

/** renderer → main：结束收音并送识别（D9 的语音输入键放开时触发）。 */
export interface VoiceStopRequest {
  session_id: string;
  /** 采样率由渲染层决定（浏览器 AudioContext 常见 48000）；sidecar 接受 8000–48000。 */
  sample_rate: number;
  /** 裸 PCM：16bit 小端单声道，不带 wav 头（§3.4 不依赖 ffmpeg）。 */
  pcm: Uint8Array;
}

/** 识别结果；heard=false 表示「没听清」，界面提示重说而不是把空文本喂给模型（§6.7）。 */
export interface VoiceStopResponse {
  text: string;
  confidence: number;
  heard: boolean;
  language?: string;
}

/** main → renderer 的一句合成音频：字节 + 引擎侧性能数字（T1.13 从这里取实测数据）。 */
export interface TtsAudioMessage {
  session_id: string;
  request_id: string;
  /** 这一句的原文，界面可以拿它做字幕对齐。 */
  text: string;
  format: "wav";
  audio: Uint8Array;
  gen_ms: number;
  audio_ms: number;
  rtf: number;
}

/**
 * 语音状态机的状态（F2 / §4.3）。
 *
 * 「不允许停在 speaking」是硬要求（§6.7），T1.6 落地状态机时以本枚举为跨进程锚点；
 * cancelling 表示打断已受理、在途活动还没退干净（退干净后自动回 idle）。
 */
export const VOICE_STATES = ["idle", "listening", "thinking", "speaking", "cancelling"] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

/** main → renderer：语音状态变化（detail 只给人看的短句，不参与判断）。 */
export interface VoiceStatePayload {
  state: VoiceState;
  detail?: string;
}

/** 界面状态的字段清单（运行时可取，供契约测试对账）。 */
export const UI_STATE_FIELDS = [
  "x",
  "y",
  "scale",
  "click_through",
  "always_on_top",
  "char_id",
] as const;

/**
 * 主窗界面状态（§6.11 的 data/ui.json）。
 *
 * 为什么 x/y 也在契约里：位置只有主进程知道（窗口 moved 事件），renderer 只负责显示，
 * 让它在同一份状态里回读，两个窗口就不会各记一套。
 */
export interface UiStatePayload {
  x: number;
  y: number;
  /** 立绘缩放，0.5–2（§6.11）。 */
  scale: number;
  /** 允许立绘以外透明区域鼠标穿透；指针进入命中区时临时关掉（§6.11）。 */
  click_through: boolean;
  always_on_top: boolean;
  /** 当前角色；null 表示还没选（首次运行的导入向导会填）。 */
  char_id: string | null;
}

/** 界面状态的增量改动；只提交改了的字段。 */
export interface UiStatePatch {
  x?: number;
  y?: number;
  scale?: number;
  click_through?: boolean;
  always_on_top?: boolean;
  char_id?: string | null;
}

/** renderer → main：指针是否在可交互区（立绘或聊天条）内。 */
export interface UiPointerMessage {
  inside: boolean;
}

/** 聊天条角色切换弹出层的一项。 */
export interface CharacterSummary {
  char_id: string;
  display_name: string;
}
