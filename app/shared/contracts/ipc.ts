/**
 * 文件职责：renderer ↔ main ↔ preload 的共享契约（通道常量 + 入参/回参类型 + 心跳视图）。
 *
 * 依赖方向：app/shared 只被引用，不引用 main / renderer / preload，也不 import electron 与 node 内置。
 * 谁调用：main 用它注册 handler（ipc-handlers.ts），preload 用它暴露白名单方法，renderer 用它给返回值和 DOM 取数标注类型。
 */

import {
  PROVIDER_VALUES,
  UI_FPS_DEFAULT,
  UI_FPS_OPTIONS,
  type ProviderValue,
  type UiFps,
} from "../defaults";

/** 白名单通道：只允许这些名字出现在 ipcMain.handle / ipcRenderer.invoke。 */
export type { AsrModelState, AsrModelStatus, ModelProgress, ModelStatus } from "./models";

export { IPC_CHANNELS } from "../ipc-channels";
export type { IpcChannel } from "../ipc-channels";

/**
 * 设置窗左侧导航的页码，取值必须与 app/renderer/settings.html 的 data-pane 一致。
 *
 * 为什么要让主进程认识页码：首次运行引导（M2）要「点一下直接落在模型供给页」，
 * 否则用户得自己在外观/手势/角色包/模型供给里找到该填的那一页——这是实测最容易卡住的一步。
 */
export type SettingsPaneId =
  "appearance" | "gestures" | "packs" | "providers" | "engine" | "memory" | "dev";

/** 打开设置窗的请求；pane 不传 = 停在「外观」。 */
export interface SettingsOpenRequest {
  readonly pane?: SettingsPaneId;
}

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
/** 三个能力面的供给名，与 sidecar/contracts/health.py 的 ProviderCapability 对齐（§6.13）。 */
export const PROVIDER_CAPABILITIES = ["llm", "asr", "tts"] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/** ProviderHealth 的字段清单（运行时可取，供跨语言契约测试对账）。 */
export const PROVIDER_HEALTH_FIELDS = ["capability", "name", "configured", "detail"] as const;

export interface ProviderHealth {
  capability: ProviderCapability;
  name: string;
  configured: boolean;
  detail?: string;
}

/** sidecar GET /health 的镜像；字段名必须与 contracts/health.py 的 HealthResponse 一致。 */
export const HEALTH_SNAPSHOT_FIELDS = [
  "status",
  "uptime_s",
  "modules",
  "providers",
  "voice",
  "version",
] as const;

export interface HealthSnapshot {
  status: "ok" | "degraded" | "starting";
  uptime_s: number;
  modules: ModuleHealth[];
  providers: ProviderHealth[];
  voice: VoiceState;
  version: string;
}

/** sidecar 生命周期状态机；取值与 app/main/heartbeat.ts 的状态机一致。 */
export type EngineState = "starting" | "online" | "offline" | "restarting" | "failed";

/**
 * 给 UI 的心跳视图：状态机 + 进程信息 + 最后一次 /health 的结果。
 * 刻意区分 null（未知）与 0（确实是 0），让界面能诚实显示。
 */
export interface HealthView {
  readonly state: EngineState;
  readonly sidecar_port: number | null;
  readonly sidecar_pid: number | null;
  readonly uptime_s: number | null;
  readonly modules: readonly ModuleHealth[] | null;
  readonly providers: readonly ProviderHealth[] | null;
  readonly version: string | null;
  readonly restarts_used: number;
  readonly last_error: string | null;
}

/** IPC appGetInfo 的返回：sidecar 未起来时端口与 pid 为空。 */
export interface AppInfo {
  app_version: string;
  sidecar_port?: number;
  sidecar_pid?: number;
}

/** 「检查更新」的三种结论：已是最新 / 有新版 / 没查成（断网、仓库不可达）。 */
export const UPDATE_CHECK_STATUSES = ["latest", "available", "failed"] as const;
export type UpdateCheckStatus = (typeof UPDATE_CHECK_STATUSES)[number];

/** 「检查更新」的回包：只读，不下载也不安装（便携版靠覆盖目录升级）。 */
export interface AppUpdateInfo {
  status: UpdateCheckStatus;
  /** 当前运行的版本（来自 package.json，构建期注入应用）。 */
  current_version: string;
  /** 远端最新版本号；没查到时是空串。 */
  latest_version: string;
  /** 发布页地址；没查到或是非 https / 非 github 域名时是空串。 */
  url: string;
  /** 发布说明摘要，直接给人看（最多 400 字）。 */
  notes: string;
  /** status=failed 时的原因，一句话。 */
  error: string;
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
  proactive?: boolean;
  proactive_kind?: string;
  app_context?: readonly string[];
  screen_text?: string;
  /**
   * 部位点击这类互动事实（T2.3-C2b）：主进程自己发起回应时带上，renderer 走聊天框时不带。
   * 有它时 text 可以是空串——sidecar 会把互动写成人话，当作本轮的用户消息（见 core/prompt.py）。
   */
  interaction?: ChatInteraction;
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
  m: ["t", "kind", "text", "importance", "follow_up"],
  a: ["t", "act", "why"],
  end: ["t"],
  e: ["t", "code", "user_hint", "recoverable", "detail"],
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
  follow_up?: boolean;
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

/**
 * 一次技术错误的可排查现场（对应 contracts/errors.py 的 ErrorDetail）。
 * 全部字段在 sidecar 侧已经脱敏、截断；界面只负责展示与复制，不要再拼 URL/请求头。
 */
export interface ErrorDetail {
  message?: string;
  status?: number | null;
  body?: string;
  endpoint?: string;
  model?: string;
  request_id?: string;
  attempts?: number;
}

/** 技术故障提示（对应 ErrorEvent，§6.7 的 A 级降级）；与角色台词分开显示。 */
export interface ChatErrorEvent {
  t: "e";
  code: string;
  user_hint: string;
  recoverable: boolean;
  detail?: ErrorDetail;
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

/** 全双工：start / end 的字段（与 sidecar contracts/voice_ws.py 对齐）。 */
export const VOICE_BEGIN_FIELDS = ["session_id", "char_id", "sample_rate", "tts_enabled"] as const;

export interface VoiceBeginRequest {
  session_id: string;
  char_id: string;
  sample_rate: number;
  /** 语音输出开关：false 时 sidecar 只出文字事件，不做 TTS 合成。 */
  tts_enabled: boolean;
}

export const VOICE_END_FIELDS = ["session_id", "char_id"] as const;

export interface VoiceEndRequest {
  session_id: string;
  char_id: string;
}

/**
 * main → sidecar：走 /ws/voice 的文字轮输入帧（D1 第二期）。
 *
 * 为什么文字也走这条连接：文字轮与语音轮必须是同一条编排，逐句合成与语音状态才只有一个
 * 出处；字段与 ChatSendRequest 对齐（少了采样率），服务端定义在 contracts/voice_ws.py。
 */
export interface VoiceTextInput {
  t: "text";
  session_id: string;
  char_id: string;
  text: string;
  /** 语音输出开关：false 时 sidecar 只出文字事件，不做 TTS 合成。 */
  tts_enabled: boolean;
  input_mode?: ChatInputMode;
  client_ts?: number;
  screen_text?: string;
  interaction?: ChatInteraction;
  proactive?: boolean;
  proactive_kind?: string;
  app_context?: readonly string[];
}

/** 音频块：裸 PCM（16bit 小端 / 单声道），采样率由 begin 指定。 */
export interface VoiceAudioChunk {
  pcm: Uint8Array;
}

/** sidecar 语音事件里**经 voiceEvent 转发**的子集（state / tts.audio 走各自通道）。 */
export const VOICE_EVENT_KINDS = [
  "asr.partial",
  "asr.final",
  "asr.empty",
  "llm.s",
  "llm.m",
  "llm.a",
  "llm.end",
  "error",
] as const;
export type VoiceEventKind = (typeof VOICE_EVENT_KINDS)[number];

export interface VoiceAsrPartialEvent {
  t: "asr.partial";
  text: string;
}

export interface VoiceAsrFinalEvent {
  t: "asr.final";
  text: string;
  confidence: number;
}

export interface VoiceAsrEmptyEvent {
  t: "asr.empty";
}

export interface VoiceSentenceStreamEvent {
  t: "llm.s";
  i: number;
  text: string;
  emotion?: string | null;
  intensity: number;
  act?: string | null;
}

export interface VoiceMemoryStreamEvent {
  t: "llm.m";
  kind: string;
  text: string;
}

export interface VoiceActStreamEvent {
  t: "llm.a";
  act: string;
}

export interface VoiceEndStreamEvent {
  t: "llm.end";
}

export interface VoiceErrorStreamEvent {
  t: "error";
  code: string;
  user_hint: string;
  recoverable?: boolean;
  detail?: ErrorDetail;
}

export type VoiceStreamEvent =
  | VoiceAsrPartialEvent
  | VoiceAsrFinalEvent
  | VoiceAsrEmptyEvent
  | VoiceSentenceStreamEvent
  | VoiceMemoryStreamEvent
  | VoiceActStreamEvent
  | VoiceEndStreamEvent
  | VoiceErrorStreamEvent;

/** tts.audio 的元数据（音频本体是紧随其后的二进制帧）。 */
export interface TtsChunkMeta {
  request_id: string;
  text: string;
  format: "wav" | "mp3";
  seq: number;
  final: boolean;
  gen_ms: number;
  audio_ms: number;
  rtf: number;
}

/** main → renderer 的一句合成音频：字节 + 引擎侧性能数字（T1.13 从这里取实测数据）。 */
export interface TtsAudioMessage {
  session_id: string;
  request_id: string;
  /** 这一句的原文，界面可以拿它做字幕对齐。 */
  text: string;
  /** 音频容器格式：本地 IndexTTS 给 wav，edge 给 mp3（渲染层 decodeAudioData 两种都能解）。 */
  format: "wav" | "mp3";
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

export interface MicStatus {
  status: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
}

/** 原生麦克风 helper 的启动结果；失败时 error 直接给界面显示。 */
export interface NativeMicStartResponse {
  readonly ok: boolean;
  readonly error: string;
}

/** 界面状态的字段清单（运行时可取，供契约测试对账）。 */
export const COMPANION_SETTINGS_FIELDS = [
  "enabled",
  "screen_enabled",
  "screen_interval_s",
  "screen_display_id",
  "ocr_enabled",
  "vision_model",
  "proactive_enabled",
  "observe_memory",
  "app_activity_enabled",
  "vision_consented",
  "quiet_hours_start",
  "quiet_hours_end",
] as const;

export interface CompanionSettings {
  enabled: boolean;
  screen_enabled: boolean;
  screen_interval_s: number;
  screen_display_id: string;
  ocr_enabled: boolean;
  vision_model: string;
  proactive_enabled: boolean;
  observe_memory: boolean;
  app_activity_enabled: boolean;
  vision_consented: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
}

export const UI_STATE_FIELDS = [
  "x",
  "y",
  "scale",
  "click_through",
  "always_on_top",
  "char_id",
  "stage_width",
  "stage_height",
  "gestures",
  "tts_enabled",
  "companion",
  "native_mic_fallback",
] as const;

/** 立绘包围盒上报消息的字段清单（T2.2；窗口尺寸就靠这三个数算）。 */
export const UI_METRICS_FIELDS = ["stage_width", "stage_height", "chatbar_height"] as const;

/** 进入互动模式的方式（设置窗「手势」菜单，方案 §5.1）：点按钮，或在立绘上滑一下。 */
export const INTERACT_TRIGGERS = ["button", "stroke"] as const;
export type InteractTrigger = (typeof INTERACT_TRIGGERS)[number];

/** data/ui.json 里的手势偏好：哪些方式能进互动模式、哪些手势启用（方案 §5.1）。 */
export const UI_GESTURE_FIELDS = ["triggers", "enabled"] as const;

export interface UiGestureSettings {
  triggers: readonly InteractTrigger[];
  enabled: readonly TouchGesture[];
}

/** JS 拖动消息的字段（T2.2 用户反馈第五轮：只报开始 / 结束，位置由主进程跟随光标算）。 */
export const UI_DRAG_FIELDS = ["action"] as const;

/** 输入模式（T2.6）：文字 / 语音 / 互动三选一，同一时间恰好一个。 */
export const UI_INPUT_MODES = ["text", "voice", "touch"] as const;
export type UiInputMode = (typeof UI_INPUT_MODES)[number];

export const UI_INPUT_MODE_FIELDS = ["mode"] as const;

export interface UiInputModeMessage {
  mode: UiInputMode;
}

/** 拖动消息的两种动作：按下开始跟随、松开结束。 */
export const UI_DRAG_ACTIONS = ["start", "end"] as const;

// 帧率档位与供给来源是「主进程和渲染层都要读」的值，定义搬到了 app/shared/defaults.ts（D2）。
// 这里 import + 再导出：主进程侧的旧 import 路径继续可用，渲染层应直接 import app/shared。
export { UI_FPS_DEFAULT, UI_FPS_OPTIONS, PROVIDER_VALUES };
export type { ProviderValue, UiFps };

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
  /**
   * 立绘包围盒的原始像素尺寸（不乘缩放），由渲染层量出来上报后存盘（T2.2 修）。
   *
   * 为什么要存：窗口尺寸 = 立绘包围盒 × 缩放 + 聊天条（§6.11）。素材尺寸只有渲染层知道
   * （PNG 的自然尺寸，M3 之后是 Live2D 模型的包围盒），而窗口必须在渲染层上报之前就
   * 按正确尺寸建出来——所以上一回的测量结果要留在 ui.json 里。
   */
  stage_width: number;
  stage_height: number;
  /** 手势偏好（方案 §5.1）：设置窗改、渲染层读，跟位置一起存在 data/ui.json 里。 */
  gestures: UiGestureSettings;
  companion: CompanionSettings;
  /** 语音输出开关（聊天条麦克风旁的按钮）：关掉只显示文字，不做 TTS。 */
  tts_enabled: boolean;
  /** 兼容模式：Chromium 麦克风失败时是否允许启动 WDM-KS 原生兜底（默认关，避免独占设备）。 */
  native_mic_fallback: boolean;
  /** 渲染帧率上限（T2.43）：只影响 Live2D 舞台的重绘频率，PNG 立绘不受影响。 */
  fps: UiFps;
}

/** 界面状态的增量改动；只提交改了的字段。 */
export interface UiStatePatch {
  x?: number;
  y?: number;
  scale?: number;
  click_through?: boolean;
  always_on_top?: boolean;
  char_id?: string | null;
  gestures?: UiGestureSettings;
  companion?: CompanionSettings;
  tts_enabled?: boolean;
  native_mic_fallback?: boolean;
  fps?: UiFps;
}

/** renderer → main：指针是否在可交互区（立绘或聊天条）内。 */
export interface UiPointerMessage {
  inside: boolean;
}

/** 全桌面鼠标坐标的字段清单（相对主窗内容区，CSS px）。 */
export const UI_CURSOR_FIELDS = ["x", "y"] as const;

/** main → renderer：系统光标相对主窗内容区的位置；可能在窗口外（负值 / 超过宽高）。 */
export interface UiCursorMessage {
  x: number;
  y: number;
}

/** renderer → main：是否开启全桌面鼠标追踪（Live2D 舞台存在时开，PNG / 销毁时关）。 */
export interface UiCursorTrackMessage {
  enabled: boolean;
}

/** renderer → main：立绘包围盒与聊天条的实测尺寸（§6.11 的窗口尺寸随素材走）。 */
export interface UiMetricsMessage {
  /** 立绘原始像素宽（不乘缩放）。 */
  stage_width: number;
  /** 立绘原始像素高（不乘缩放）。 */
  stage_height: number;
  /** 聊天条实测高度：输入框自动换行变高时它会跟着变（F11）。 */
  chatbar_height: number;
}

/** 拖动动作（见 UI_DRAG_ACTIONS）。 */
export type UiDragAction = (typeof UI_DRAG_ACTIONS)[number];

/**
 * renderer → main：拖动开始 / 结束（T2.2 用户反馈第五轮）。
 *
 * 为什么不再报位移增量：渲染层给的 clientX 是相对本窗口的，而窗口会跟着光标一起动，
 * 两次 mousemove 的差值于是趋近于 0——「拖动不跟手、拖快一点就不动」的根因。现在只报两个
 * 时刻，位移由主进程读系统光标的屏幕坐标算（抓点偏置固定，窗口永远贴着光标）。
 */
export interface UiDragMessage {
  action: UiDragAction;
}

/** 聊天条角色切换弹出层的一项。 */
export interface CharacterSummary {
  char_id: string;
  display_name: string;
}

/** 部位定义的一项（hits.json 的 regions[]，T2.3-C2）。 */
export const CHAR_HIT_REGION_FIELDS = ["id", "name", "rect", "color", "act"] as const;

/** 命中形状（T2.42）：缺省时按 rect 当矩形用。 */
export interface CharHitShape {
  kind: "rect" | "ellipse" | "poly";
  /** kind 为 rect / ellipse 时使用（椭圆取这个外接矩形的内切椭圆）。 */
  rect?: readonly [number, number, number, number];
  /** kind 为 poly 时使用（3–64 个顶点，按顺序给，不要求凸）。 */
  points?: readonly (readonly [number, number])[];
}

export interface CharHitRegion {
  id: string;
  name: string;
  /** 素材归一化坐标 [x, y, w, h]（0–1）：换素材 / 缩放都不会算错（方案 §4.3）。 */
  rect: readonly [number, number, number, number];
  color: string;
  /** 部位动作标记（blush / shake / wave…）：M1 先留给模型参考，M3 由 Live2D 消费。 */
  act: string;
  /** 重叠时谁先算（越大越先，缺省 0）：脸、手这种小部位压在大块身体上（T2.42）。 */
  priority?: number;
  /** 命中容差（归一化，0–0.2）：指腹压偏一点也算点到（T2.42）。 */
  padding?: number;
  /** 静态形状，缺省用 rect（T2.42）。 */
  shape?: CharHitShape;
  /** Live2D 网格 id：命中框跟着网格顶点走，角色抬手后框不会留在原地（T2.42）。 */
  drawables?: readonly string[];
}

/** deskpet:char:portrait 的参数 / 响应。 */
export interface CharacterPortraitRequest {
  char_id: string;
}

export interface CharacterPortraitResponse {
  data_url: string | null;
}

/** deskpet:char:hits 的参数 / 响应。 */
export interface CharacterHitsRequest {
  char_id: string;
}

export interface CharacterHitsResponse {
  regions: readonly CharHitRegion[];
  /** 视线支点（画布归一化坐标，0–1）；没配为 null，Live2D 舞台用默认值（T2.28）。 */
  look_at_origin: [number, number] | null;
}

/**
 * 形象舞台的种类（appearance.json 的 stage，§6.6 / D10）：
 * png = 只画立绘；live2d = 用 Live2D 模型；hybrid = Live2D 待机 + 静态 CG 叠层。
 */
export const STAGE_KINDS = ["png", "live2d", "hybrid"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** appearance.json 里渲染层真正用得到的字段清单（运行时可取，供契约测试对账）。 */
export const CHARACTER_APPEARANCE_FIELDS = [
  "stage",
  "portrait",
  "model",
  "png_fallback",
  "hit_box",
  "motions",
  "expressions",
  "acts",
] as const;

/** 一个动作在两个后端上的落点（与 sidecar contracts/character.py 的 ActTarget 对齐）。 */
export interface CharacterActTarget {
  live2d: string | null;
  png: string | null;
}

/**
 * 渲染层要的形象配置（appearance.json 的投影）。
 *
 * 为什么只回这些字段：路径 / 映射表都由主进程按包内相对路径校验后再给，渲染层拿不到 fs，
 * 也不放开 CSP 的 file://（Stage 抽象层据此决定用 PNG 还是 Live2D，T2.4）。
 */
export interface CharacterAppearance {
  stage: StageKind;
  portrait: string | null;
  model: string | null;
  /** 缺 Live2D 模型时的立绘回退（D10）；为空则退回 portrait。 */
  png_fallback: string | null;
  /** Live2D 画布中人物占用的归一化框 [x,y,w,h]；用于把 hits.json 映射到模型坐标。 */
  hit_box: [number, number, number, number] | null;
  motions: Record<string, string>;
  expressions: Record<string, string>;
  acts: Record<string, CharacterActTarget>;
}

/** deskpet:char:appearance 的参数 / 响应。 */
export interface CharacterAppearanceRequest {
  char_id: string;
}

/** appearance.json 读不到 / 坏格式时为 null，渲染层据此回退内置占位图（不阻断别的功能）。 */
export interface CharacterAppearanceResponse {
  appearance: CharacterAppearance | null;
}

/**
 * 触摸手势（T2.3-C2c，方案 §4）：渲染层按指针轨迹分档，sidecar 用它选一条事实模板。
 *
 * 意义分工：tap 立足「几下」（力度），stroke 立足「摸过哪里」，hold/knead 立足「按了多久」，
 * pat 是连拍的 tap。模型只看到一句人话（core/prompt.py 的 build_interaction_note），看不到枚举。
 */
export const TOUCH_GESTURES = ["tap", "stroke", "hold", "knead", "pat"] as const;
export type TouchGesture = (typeof TOUCH_GESTURES)[number];

/** 被摸到的部位：只要显示名，几何判定在渲染层用归一化框算完。 */
export const TOUCH_REGION_FIELDS = ["id", "name"] as const;

export interface TouchRegion {
  id: string;
  name: string;
}

/**
 * renderer → main 的触摸事实（T2.3-C2c）：一串触摸聚合成一条。
 *
 * 为什么按「串」而不是按「下」上报：模型要能说出「他一口气戳了 5 下」「从手一路摸到胳膊」，
 * 单下上报只会让提示词里全是碎片，还会把闸门的每一分钟 4 次配额耗光。
 */
export const TOUCH_MESSAGE_FIELDS = ["gesture", "regions", "count", "duration_ms"] as const;

export interface TouchMessage {
  gesture: TouchGesture;
  regions: readonly TouchRegion[];
  /** 力度：同手势的触摸会话次数（tap/pat 是「几下」，其余恒为 1）。 */
  count: number;
  duration_ms: number;
}

/** 提前报的 demand（T2.6）：手势刚成立就停播，完整的部位 / 次数仍走 TouchMessage。 */
export const TOUCH_INTENT_FIELDS = ["gesture"] as const;

export interface TouchIntentMessage {
  gesture: TouchGesture;
}

/** 互动闸门的只读快照：冷却剩下的毫秒数 + 当前分钟剩余额度。 */
export interface TouchGateState {
  readonly cooldown_remaining_ms: number;
  readonly cooldown_total_ms: number;
  readonly rate_remaining: number;
  readonly rate_max: number;
  readonly pending: boolean;
}

/** 进提示词的互动事实：与 sidecar 的 ChatInteraction 逐字段对齐。 */
export const CHAT_INTERACTION_FIELDS = ["gesture", "regions", "count", "duration_ms"] as const;

export interface ChatInteraction {
  gesture: TouchGesture;
  regions: readonly TouchRegion[];
  count: number;
  duration_ms: number;
}

/** 设置窗「模型供给」一行的字段清单（运行时可取，供契约测试对账）。 */
export const PROVIDER_SETTINGS_FIELDS = [
  "capability",
  "provider",
  "cloud_base_url",
  "cloud_model",
  "cloud_api_key_set",
  "local_base_url",
  "local_model",
  "local_token_set",
  "fallback_base_url",
  "fallback_model",
] as const;

/**
 * 一个能力面的供给配置。
 *
 * 密钥与口令只有布尔量（已配 / 未配）：明文永远不回传渲染层，日志里也不许出现（§7.1）。
 * 云端 ASR / TTS 与本地部分字段在后置实现前一直是空串，界面据此显示「尚未实现」。
 */
export interface ProviderSettingsEntry {
  capability: ProviderCapability;
  provider: ProviderValue;
  /** 常用服务商预设 id（custom 表示自定义）；老配置由 base_url 反推。 */
  preset: string;
  cloud_base_url: string;
  cloud_model: string;
  cloud_api_key_set: boolean;
  local_base_url: string;
  local_model: string;
  local_token_set: boolean;
  /** 显式备用端点：只有 llm 用（§6.7 的退避顺序：主用 → 备用 → 另一个供给）。 */
  fallback_base_url: string;
  fallback_model: string;
}

export interface ProviderSettingsPayload {
  entries: ProviderSettingsEntry[];
  /** settings.json 的实际路径（给界面显示「写到哪」，不含任何内容）。 */
  config_file: string;
}

/**
 * 设置窗提交的一项改动。
 *
 * 三条语义：字段缺省 = 不改；api_key 传 null = 不改、传 "" = 清空、传字符串 = 覆盖。
 * 密钥只在「渲染层 → 主进程」这一跳出现，写完即丢。
 */
export interface ProviderSettingsPatchEntry {
  capability: ProviderCapability;
  provider?: ProviderValue;
  preset?: string;
  cloud_base_url?: string;
  cloud_model?: string;
  cloud_api_key?: string | null;
  local_base_url?: string;
  local_model?: string;
  local_token?: string | null;
  fallback_base_url?: string;
  fallback_model?: string;
}

/** 单条探测结论的字段清单，与 sidecar contracts/providers.py 的 ProviderProbeResult 对齐。 */
export const PROVIDER_PROBE_FIELDS = [
  "provider",
  "base_url",
  "model",
  "ok",
  "detail",
  "elapsed_ms",
] as const;

/** 一个候选端点的探测结论；detail 里绝不含密钥（sidecar 侧同样保证）。 */
export interface ProviderProbeResult {
  provider: string;
  base_url?: string;
  model?: string;
  ok: boolean;
  detail: string;
  elapsed_ms: number;
}

/** 一个能力面的探测报告：候选顺序与真实请求一致。 */
export interface ProviderTestReport {
  capability: ProviderCapability;
  results: ProviderProbeResult[];
}

/**
 * 「测试连接」的未保存表单值。
 *
 * 只有这一条请求会把密钥带到主进程 / sidecar：它用于测当前表单，不落盘、不日志、不进结果。
 * 省略的密钥字段表示沿用已保存配置；空串表示这次测试不用密钥。
 */
export interface ProviderTestOverrides {
  provider?: ProviderValue;
  preset?: string;
  cloud_base_url?: string;
  cloud_model?: string;
  cloud_api_key?: string | null;
  local_base_url?: string;
  local_model?: string;
  local_token?: string | null;
  fallback_base_url?: string;
  fallback_model?: string;
}

export interface ProviderTestRequest {
  capability: ProviderCapability;
  overrides?: ProviderTestOverrides;
}

/** 获取云端模型的列表；目前只支持 llm。 */
export interface ProviderModelsRequest {
  capability: ProviderCapability;
  overrides?: ProviderTestOverrides;
}

export interface ProviderModelsResponse {
  capability: ProviderCapability;
  models: string[];
  detail: string;
}

/** 模型可以写入的记忆种类，与 sidecar contracts/api_models.py 的 MemoryWriteRequest.kind 对齐。 */
export const MEMORY_KINDS = ["fact", "preference", "event"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * 列表筛选可以用的记忆种类：比可写入的多一个 action（T2.1c 的行为观察）。
 *
 * action 只由 sidecar 的行为记忆服务按用量计数派生，模型的 m 事件与手写记忆端点都不许
 * 造它（sidecar MemoryWriteRequest.kind 里故意没有这个值），所以单独列一份给筛选用。
 */
export const MEMORY_QUERY_KINDS = ["fact", "preference", "event", "action"] as const;
export type MemoryQueryKind = (typeof MEMORY_QUERY_KINDS)[number];

/** 记忆列表一行的字段清单（运行时可取，供契约测试对账）。 */
export const MEMORY_ITEM_FIELDS = [
  "id",
  "char_id",
  "kind",
  "tier",
  "text",
  "importance",
  "created_at",
  "last_used_at",
  "used_count",
  "source_msg_ids",
] as const;

/**
 * 设置窗记忆面板的一行，与 sidecar MemoryListItem 一一对应。
 *
 * kind / tier 故意是宽松的 string：库里可能有历史遗留值，界面显示原文好过整块列表 500
 * （sidecar 侧同样用 str 而不是 Literal，理由见 contracts/api_models.py）。
 */
export interface MemoryItem {
  id: number;
  char_id: string;
  kind: string;
  tier: string;
  text: string;
  importance: number;
  created_at: string;
  last_used_at: string;
  used_count: number;
  source_msg_ids: string;
}

/** renderer → main：列记忆；kind / tier 传空串表示不过滤（与 MemoryListQuery 一致）。 */
export interface MemoryListRequest {
  char_id: string;
  kind?: MemoryQueryKind | "";
  tier?: string;
  min_importance?: number;
  limit?: number;
}

export interface MemoryListResponse {
  items: MemoryItem[];
}

/** renderer → main：删一条记忆（幂等，deleted=false 表示本来就没有）。 */
export interface MemoryDeleteRequest {
  memory_id: number;
}

export interface MemoryDeleteResponse {
  deleted: boolean;
}

/** renderer → main：清空该角色记忆；keep_days 传 null / 不传 = 全清。 */
export interface MemoryClearRequest {
  char_id: string;
}

export interface MemoryClearResponse {
  deleted: number;
  /** 清空前留底的快照路径；空串表示没留成（库没打开，或写盘失败） */
  snapshot: string;
}

/** 编辑请求的字段清单（运行时可取，供契约测试对账）。 */
export const MEMORY_EDIT_REQUEST_FIELDS = ["memory_id", "text", "importance", "kind"] as const;

/**
 * renderer → main：改一条 L0 记忆（开发者模式，T2.3-B2）。
 *
 * importance 省略 / null 表示只改文本：重要度不传就保持原值，不让界面误把它清零。
 */
export interface MemoryEditRequest {
  memory_id: number;
  text: string;
  importance?: number | null;
  kind?: MemoryQueryKind;
}

/**
 * 编辑回执：updated=false 表示该 id 不存在（幂等，不报错）。
 *
 * merged=true 表示改完与同角色另一条撞了去重键，两条并成一条，item 是留下来的那条。
 */
export interface MemoryEditResponse {
  updated: boolean;
  merged: boolean;
  item: MemoryItem | null;
}

/** 「行为记忆」开关回执的字段清单（运行时可取，供契约测试对账）。 */
export const MEMORY_BEHAVIOR_FIELDS = ["enabled"] as const;

/**
 * renderer → main：读 / 写「行为记忆」总开关（T2.1c）。
 *
 * enabled = null 表示只读（设置窗打开时问一次当前值）；true / false 会落到 .env 的
 * DESKPET_MEMORY_BEHAVIOR_ENABLED，下一次 sidecar 启动才生效。
 */
export interface MemoryBehaviorRequest {
  enabled: boolean | null;
}

export interface MemoryBehaviorResponse {
  enabled: boolean;
}

/** 语义检索状态的字段清单，与 sidecar MemoryEmbeddingStatus 对齐（T2.32）。 */
export const MEMORY_EMBEDDING_STATUS_FIELDS = [
  "enabled",
  "available",
  "model",
  "provider",
  "model_dir",
  "base_url",
  "indexed",
  "pending",
  "error",
] as const;

/**
 * 设置窗「语义检索」卡片的快照。
 *
 * enabled=false 表示 .env 没开；available=false 表示 Ollama 不可达或模型缺失。
 * 两者都不影响聊天：检索会静默回退 FTS。
 */
export interface MemoryEmbeddingStatus {
  enabled: boolean;
  available: boolean;
  model: string;
  /** "ollama"=外接 Ollama；"onnx"=随包内置（T2.40）。 */
  provider: string;
  /** 内置模型目录；走 Ollama 时为空串。 */
  model_dir: string;
  base_url: string;
  indexed: number;
  pending: number;
  error: string;
}

/** renderer → main：读某个角色的语义索引状态。 */
export interface MemoryEmbeddingStatusRequest {
  char_id: string;
}

/** 补索引请求；limit 不传时由 sidecar 用默认值 200。 */
export const MEMORY_EMBEDDING_INDEX_REQUEST_FIELDS = ["char_id", "limit"] as const;

export interface MemoryEmbeddingIndexRequest {
  char_id: string;
  limit?: number;
}

/** 补索引回执的字段清单，与 sidecar MemoryEmbeddingIndexResponse 对齐。 */
export const MEMORY_EMBEDDING_INDEX_RESPONSE_FIELDS = ["indexed", "pending", "error"] as const;

export interface MemoryEmbeddingIndexResponse {
  indexed: number;
  pending: number;
  error: string;
}

/** 语义检索配置回执（T2.40）。 */
export const MEMORY_EMBEDDING_CONFIG_FIELDS = ["enabled", "model", "base_url"] as const;

export interface MemoryEmbeddingConfig {
  enabled: boolean;
  model: string;
  base_url: string;
}

export interface MemoryEmbeddingConfigRequest {
  enabled: boolean | null;
}

/** 时间线一行的字段清单，与 sidecar MemoryPeriodItem 对齐（T2.33）。 */
export const MEMORY_PERIOD_FIELDS = [
  "id",
  "char_id",
  "level",
  "period_start",
  "period_end",
  "label",
  "day_key",
  "summary",
  "source_count",
  "edited",
  "pinned",
] as const;

export interface MemoryPeriodItem {
  id: number;
  char_id: string;
  level: string;
  period_start: string;
  period_end: string;
  label: string;
  day_key: string;
  summary: string;
  source_count: number;
  edited: boolean;
  pinned: boolean;
}

/** renderer → main：拉时间线；levels 逗号分隔，留空表示全部。 */
export interface MemoryTimelineRequest {
  char_id: string;
  levels?: string;
  limit?: number;
}

export interface MemoryTimelineResponse {
  items: MemoryPeriodItem[];
}

export interface MemoryPeriodEditRequest {
  period_id: number;
  summary: string;
  label?: string;
  pinned?: boolean;
}

export interface MemoryPeriodDetail extends MemoryPeriodItem {
  sources: [string, number][];
}

export interface MemoryTimelineRebuildRequest {
  char_id: string;
}

export interface MemoryTimelineBackfillRequest {
  char_id: string;
  days?: number;
}

export const MEMORY_TIMELINE_REBUILD_FIELDS = ["episode", "day", "week", "month"] as const;

export interface MemoryTimelineRebuildResponse {
  episode: number;
  day: number;
  week: number;
  month: number;
}

/** 手动日记一行的字段清单。 */
export const MEMORY_DIARY_FIELDS = [
  "id",
  "char_id",
  "text",
  "occurred_at",
  "mood",
  "tags",
  "created_at",
  "updated_at",
] as const;

export interface MemoryDiaryItem {
  id: number;
  char_id: string;
  text: string;
  occurred_at: string;
  mood: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryDiaryListRequest {
  char_id: string;
  limit?: number;
}

export interface MemoryDiaryListResponse {
  items: MemoryDiaryItem[];
}

export interface MemoryDiaryWriteRequest {
  char_id: string;
  text: string;
  occurred_at?: string;
  mood?: string;
  tags?: string;
}

export interface MemoryDiaryPatchRequest {
  entry_id: number;
  text: string;
  mood?: string;
  tags?: string;
}

export const MEMORY_RELATION_FIELDS = [
  "char_id",
  "familiarity",
  "trust",
  "warmth",
  "unresolved",
  "recent_conflict",
  "updated_at",
] as const;

export interface MemoryRelationItem {
  char_id: string;
  familiarity: number;
  trust: number;
  warmth: number;
  unresolved: string;
  recent_conflict: string;
  updated_at: string;
}

export interface MemoryRelationUpdateRequest {
  familiarity: number;
  trust: number;
  warmth: number;
  unresolved: string;
  recent_conflict: string;
}

export const MEMORY_GRAPH_NODE_FIELDS = ["id", "kind", "label", "summary", "level"] as const;

export interface MemoryGraphNode {
  id: string;
  kind: string;
  label: string;
  summary: string;
  level: string;
}

export const MEMORY_GRAPH_EDGE_FIELDS = ["source", "target", "relation"] as const;

export interface MemoryGraphEdge {
  source: string;
  target: string;
  relation: string;
}

export interface MemoryGraphRequest {
  char_id: string;
  limit?: number;
}

export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export interface MemoryGraphRebuildRequest {
  char_id: string;
}

export const MEMORY_GRAPH_REBUILD_FIELDS = ["entities", "links"] as const;

export interface MemoryGraphRebuildResponse {
  entities: number;
  links: number;
}

export const MEMORY_INTENTION_FIELDS = [
  "id",
  "char_id",
  "text",
  "trigger_at",
  "trigger_context",
  "status",
  "created_at",
] as const;

export interface MemoryIntentionItem {
  id: number;
  char_id: string;
  text: string;
  trigger_at: string;
  trigger_context: string;
  status: string;
  created_at: string;
}

export interface MemoryIntentionsRequest {
  char_id: string;
  limit?: number;
}

export interface MemoryIntentionsResponse {
  items: MemoryIntentionItem[];
}

export interface MemoryIntentionWriteRequest {
  char_id: string;
  text: string;
  trigger_at?: string;
}

/** 开发者模式开关的落盘形状（data/dev.json）与 IPC 回执共用：只有一个布尔。 */
export const DEV_MODE_FIELDS = ["enabled"] as const;

export interface DevModeState {
  enabled: boolean;
}

/** renderer → main：enabled = null 表示只读（设置窗打开时问一次当前值）。 */
export interface DevModeRequest {
  enabled: boolean | null;
}

export type DevModeResponse = DevModeState;

/** 开发者模式「原文」页一行的字段清单（运行时可取，供契约测试对账）。 */
export const MEMORY_MESSAGE_FIELDS = [
  "message_id",
  "session_id",
  "role",
  "text",
  "created_at",
  "token_len",
  "covered_by",
] as const;

/**
 * 一行历史原文，与 sidecar MemoryMessageItem 一一对应（T2.3-B1）。
 *
 * covered_by = 覆盖这条原文的摘要 id，0 表示还没进过压缩链路；界面据此把它标灰（只读）。
 */
export interface MemoryMessageItem {
  message_id: number;
  session_id: string;
  role: string;
  text: string;
  created_at: string;
  token_len: number;
  covered_by: number;
}

/** renderer → main：翻页取原文；before_id 取更早（不传 = 最新一页）。 */
export interface MemoryMessagesRequest {
  char_id: string;
  limit?: number;
  before_id?: number | null;
}

export interface MemoryMessagesResponse {
  items: MemoryMessageItem[];
  has_more: boolean;
}

export interface MemorySummaryItem {
  id: number;
  char_id: string;
  tier: number;
  text: string;
  covers_from: string;
  covers_to: string;
  source_ids: string;
  created_at: string;
  archived_at: string;
}

export interface MemorySummariesRequest {
  char_id: string;
  limit?: number;
}

export interface MemorySummariesResponse {
  items: MemorySummaryItem[];
}

export interface MemorySummaryEditRequest {
  summary_id: number;
  text: string;
}

export interface MemoryMessageEditRequest {
  message_id: number;
  text: string;
}

/** 注入预览里一条内容的字段清单（运行时可取，供契约测试对账）。 */
export const MEMORY_CONTEXT_ITEM_FIELDS = [
  "text",
  "tokens",
  "ref_id",
  "kind",
  "role",
  "importance",
] as const;

/** 注入预览一段的字段清单（运行时可取，供契约测试对账）。 */
export const MEMORY_CONTEXT_SECTION_FIELDS = [
  "name",
  "title",
  "budget_tokens",
  "used_tokens",
  "dropped",
  "items",
] as const;

/** 注入预览里的一条内容；ref_id 是记忆 id（历史原文没有，为 0）。 */
export interface MemoryContextItem {
  text: string;
  tokens: number;
  ref_id: number;
  kind: string;
  role: string;
  importance: number;
}

/** 注入预览的一段（与 §6.4 的六层一一对应）。 */
export interface MemoryContextSection {
  name: string;
  title: string;
  budget_tokens: number;
  used_tokens: number;
  dropped: boolean;
  items: MemoryContextItem[];
}

/** renderer → main：预览「下一轮会注入什么」；query 留空 = 没有新话题时的基础注入。 */
export interface MemoryContextRequest {
  char_id: string;
  query?: string;
}

export interface MemoryContextResponse {
  char_id: string;
  query: string;
  empty: boolean;
  total_tokens: number;
  budget_tokens: number;
  dropped: string[];
  injected_ids: number[];
  sections: MemoryContextSection[];
  text: string;
}

/** 主进程上报的使用事实种类，与 sidecar contracts/api_models.py 的 UsageRecordRequest.fact 对齐（T2.3）。
 *
 * 为什么不是 IPC 通道：窗口位移只有主进程看得见（§6.11 的拖动也走 J 侧算），
 * 所以晃动判定与上报都在主进程完成，渲染层不需要参与。
 */
export const USAGE_FACTS = ["window_shake", "char_hit"] as const;
export type UsageFact = (typeof USAGE_FACTS)[number];

/** 上报请求体的字段（§6.9 的 /usage/record）：与 sidecar 的 UsageRecordRequest 逐字对齐。 */
export const USAGE_RECORD_REQUEST_FIELDS = [
  "fact",
  "char_id",
  "region_id",
  "gesture",
  "count",
] as const;

export interface UsageRecordRequest {
  fact: UsageFact;
  char_id: string;
  /** char_hit 专有：命中的部位 id、手势与这一串的力度（方案 §4）。 */
  region_id?: string;
  gesture?: string;
  count?: number;
}

/** UsageRecordResponse 的字段清单（运行时可取，供跨语言契约测试对账）。 */
export const USAGE_RECORD_FIELDS = ["recorded"] as const;

/** POST /usage/record 的响应：recorded=false 是没有可承接的会话或开关关着，不是错误。 */
export interface UsageRecordResponse {
  recorded: boolean;
}

export interface UsageCharacterStat {
  char_id: string;
  total_duration_sec: number;
  session_count: number;
}

/** F10 统计页快照；token 字段来自模型服务，未上报时为 0。 */
export interface UsageStats {
  recording_enabled: boolean;
  total_sessions: number;
  total_messages: number;
  total_duration_sec: number;
  today_sessions: number;
  today_messages: number;
  today_duration_sec: number;
  llm_calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  max_prompt_tokens: number;
  memory_tokens: number;
  characters: UsageCharacterStat[];
}

/** M3 数据导出：sidecar 打完包回的摘要（path 是机器上的绝对路径，主进程用它定位文件）。 */
export interface DataExportResult {
  path: string;
  bytes: number;
  created_at: string;
  entries: string[];
  skipped: string[];
}

/** 从数据包恢复（M3 / D9）：只到「暂存完成」，替换发生在下次引擎启动时。 */
export interface DataRestoreResult {
  archive: string;
  db_bytes: number;
  pending_path: string;
  entries: string[];
  restart_required: boolean;
}

/** 备份目录里的一个文件：kind 只用于界面分组，删除仍归各自的保留策略。 */
export const DATA_BACKUP_KINDS = ["daily", "before", "replaced", "rejected", "other"] as const;

export type DataBackupKind = (typeof DATA_BACKUP_KINDS)[number];

export interface DataBackupEntry {
  /** 文件名（不含目录）。 */
  file: string;
  kind: DataBackupKind;
  bytes: number;
  /** 修改时间（unix 秒）。 */
  modified_at: number;
}

/** 备份目录现状（D9）：界面用来显示「手头有哪些后悔药」。 */
export interface DataBackupsResult {
  dir: string;
  total_bytes: number;
  /** 按时间新→旧。 */
  entries: DataBackupEntry[];
}

/** 「立即备份」的结果；path 为空表示没做成（记忆库没打开、磁盘满等）。 */
export interface DataBackupNowResult {
  path: string;
  file: string;
  bytes: number;
}

/** 角色包编辑器：一个部位草稿（rect 是 0–1 归一化的 [x, y, w, h]，方案 §4.3）。 */
export const PACK_REGION_FIELDS = ["id", "name", "rect", "color", "act"] as const;

export interface PackRegionDraft {
  /**
   * 新建模式可发空串（主进程按名字派生）；**编辑模式会带上已有 id 并由主进程保留**，
   * 因为 usage.db 的 char_hits 是按 region_id 记账的，改名不应换 id。
   */
  id: string;
  name: string;
  rect: [number, number, number, number];
  color: string;
  act: string;
  /**
   * v2 可选扩展（T2.42）。编辑器里不常改，但**保存时必须原样带回去**：
   * 早先的实现只写前五个键，用户在编辑器里拖一下框就把优先级 / 网格绑定洗掉了（T2.44）。
   */
  priority?: number;
  padding?: number;
  shape?: CharHitShape;
  drawables?: string[];
}

/** 部位草稿的可选扩展字段清单（T2.44，供契约 / 测试对账）。 */
export const PACK_REGION_OPTIONAL_FIELDS = ["priority", "padding", "shape", "drawables"] as const;

/**
 * 「按模型网格生成部位」的默认映射（T2.44）：网格 id 来自 PSD2Live 的命名规则
 * （ArtMesh + 层名 PascalCase）。命不中的网格会被跳过，不会生成空框。
 */
export const MESH_REGION_TEMPLATES = [
  { id: "face", name: "脸", priority: 10, drawables: ["ArtMeshFace"] },
  { id: "hand_left", name: "左手", priority: 8, drawables: ["ArtMeshHandwearL"] },
  { id: "hand_right", name: "右手", priority: 8, drawables: ["ArtMeshHandwearR"] },
  { id: "chest", name: "胸", priority: 3, drawables: ["ArtMeshTopwear"] },
  { id: "hips", name: "胯", priority: 3, drawables: ["ArtMeshBottomwear"] },
  { id: "thigh_left", name: "左腿", priority: 5, drawables: ["ArtMeshLegwearL"] },
  { id: "thigh_right", name: "右腿", priority: 5, drawables: ["ArtMeshLegwearR"] },
] as const;

/** 选图回执的字段清单（运行时可取，供契约测试对账）。 */
export const PACK_PICK_IMAGE_FIELDS = ["canceled", "data_url", "file_name"] as const;

/** 选图回执：canceled=true 表示用户关掉了选择框（不是错误），此时其余字段是空串。 */
export interface PackPickImageResponse {
  canceled: boolean;
  data_url: string;
  file_name: string;
}

/** 保存请求的字段清单（运行时可取，供契约测试对账）。 */
export const PACK_SAVE_REQUEST_FIELDS = [
  "char_id",
  "display_name",
  "description",
  "personality",
  "speaking_style",
  "portrait_data_url",
  "regions",
  "look_at_origin",
] as const;

/** renderer → main：把编辑器里画好的角色包落盘（portrait 是裁切后的 PNG data URL）。 */
export interface PackSaveRequest {
  char_id: string;
  display_name: string;
  description: string;
  personality: string;
  speaking_style: string;
  portrait_data_url: string;
  regions: PackRegionDraft[];
  /** 视线支点（0–1）；没传时主进程用默认值（T2.28）。 */
  look_at_origin?: [number, number];
}

/** 保存回执的字段清单（运行时可取，供契约测试对账）。 */
export const PACK_SAVE_RESPONSE_FIELDS = ["ok", "char_id", "error", "files"] as const;

/** 保存回执：ok=false 时 error 是给用户看的一句话（目录已存在 / 图片不合法 / 写盘失败）。 */
export interface PackSaveResponse {
  ok: boolean;
  char_id: string;
  error: string;
  files: string[];
}

/** 打开编辑器的方式：create = 新建向导；edit = 只编辑当前角色的部位（T2.5）。 */
export const PACK_OPEN_MODES = ["create", "edit", "card"] as const;
export type PackOpenMode = (typeof PACK_OPEN_MODES)[number];

/** 打开编辑器请求的字段清单（运行时可取，供契约测试对账）。 */
export const PACK_OPEN_EDITOR_REQUEST_FIELDS = ["mode", "char_id"] as const;

/** renderer → main：打开编辑器；edit 模式必须带 char_id。 */
export interface PackOpenEditorRequest {
  mode: PackOpenMode;
  char_id?: string;
}

/** 读现有角色包（编辑器 edit 模式用）。 */
export const PACK_LOAD_REQUEST_FIELDS = ["char_id"] as const;

export interface PackLoadRequest {
  char_id: string;
}

/** 读现有角色包的字段清单（运行时可取，供契约测试对账）。 */
export const PACK_LOAD_RESPONSE_FIELDS = [
  "ok",
  "char_id",
  "display_name",
  "description",
  "personality",
  "speaking_style",
  "portrait_data_url",
  "regions",
  "look_at_origin",
  "suggested_look_at_origin",
  "error",
] as const;

/** 角色包投影：编辑模式只要卡片展示信息 + 立绘 + 现有部位；不含有记忆（D12）。 */
export interface PackLoadResponse {
  ok: boolean;
  char_id: string;
  display_name: string;
  description: string;
  personality: string;
  speaking_style: string;
  portrait_data_url: string | null;
  regions: PackRegionDraft[];
  /** 已保存的视觉原点；没有则等于建议值（T2.28）。 */
  look_at_origin: [number, number];
  /** 「放到脸部中心」用的建议值（faceRig → face → head → 默认）。 */
  suggested_look_at_origin: [number, number];
  error: string;
}

/** 只保存部位（edit 模式）的请求字段清单（运行时可取，供契约测试对账）。 */
export const PACK_SAVE_REGIONS_REQUEST_FIELDS = ["char_id", "regions", "look_at_origin"] as const;

/** renderer → main：只把部位写回 characters/<char_id>/hits.json，不动其它文件。 */
export interface PackSaveRegionsRequest {
  char_id: string;
  regions: PackRegionDraft[];
  /** 视线支点（0–1）；不传时保留原值 / 用默认值（T2.28）。 */
  look_at_origin?: [number, number];
}

/** 按网格生成部位的请求 / 响应字段清单（T2.44）。 */
export const PACK_GENERATE_REGIONS_REQUEST_FIELDS = ["char_id"] as const;
export const PACK_GENERATE_REGIONS_RESPONSE_FIELDS = ["ok", "regions", "error"] as const;

/** renderer → main：请主窗把 Live2D 网格外接框算出来，直接回一份部位草稿（T2.44）。 */
export interface PackGenerateRegionsRequest {
  char_id: string;
}

export interface PackGenerateRegionsResponse {
  ok: boolean;
  /** 生成出来的部位（rect 已按 hit_box 归一化）；不落盘，由编辑器决定是否采用。 */
  regions: PackRegionDraft[];
  error: string;
}

/** main → 主窗：要一组网格的外接框（0–1，按 hit_box 归一化）。 */
export interface HitsProbeMessage {
  request_id: string;
  drawables: readonly string[];
}

/** 主窗 → main：网格 id → 外接框；没这个网格就不出现。 */
export interface HitsProbeReplyMessage {
  request_id: string;
  /** 失败原因是给用户看的一句话（比如「主窗现在显示的不是这个角色」）。 */
  error: string;
  bounds: readonly { id: string; rect: [number, number, number, number] }[];
}

/** 只保存角色卡的请求字段清单（T2.7）。 */
export const PACK_SAVE_CARD_REQUEST_FIELDS = [
  "char_id",
  "display_name",
  "description",
  "personality",
  "speaking_style",
] as const;

/** renderer → main：只改 card.json / pack.json 的展示字段，不动立绘 / 部位 / 音色。 */
export interface PackSaveCardRequest {
  char_id: string;
  display_name: string;
  description: string;
  personality: string;
  speaking_style: string;
}

export interface PackArchiveOptions {
  include_voice: boolean;
  include_model: boolean;
}

export interface PackExportRequest {
  char_id: string;
  include_voice?: boolean;
  include_model?: boolean;
}

export interface PackExportResponse {
  ok: boolean;
  canceled: boolean;
  char_id: string;
  path: string;
  files: number;
  error: string;
}

export interface PackImportRequest {
  include_voice?: boolean;
  include_model?: boolean;
  /** 拖拽导入时由 preload 从 File 取得的绝对路径；为空则弹文件选择框。 */
  path?: string;
}

export interface PackImportResponse {
  ok: boolean;
  canceled: boolean;
  char_id: string;
  display_name: string;
  renamed_from: string;
  warnings: readonly string[];
  error: string;
}

/** 角色列表变化广播的字段清单（运行时可取，供契约测试对账）。 */
export const CHARACTERS_CHANGED_FIELDS = ["char_id"] as const;

export interface CharactersChangedMessage {
  char_id: string;
}
