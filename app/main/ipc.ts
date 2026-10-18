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
  /** renderer 报立绘包围盒与聊天条实测高度，main 据此定窗口尺寸（§6.11，T2.2 修） */
  uiMetrics: "deskpet:ui:metrics",
  /** renderer 报一次拖动位移，main 按当前窗口位置加上它（§6.11，T2.2 真机反馈：不用 app-region） */
  uiDrag: "deskpet:ui:drag",
  /** 打开设置窗（聊天条与托盘两个入口都能到，F11，T1.12a） */
  settingsOpen: "deskpet:settings:open",
  /** 列出 characters/ 下的可选角色，供聊天条「角色切换」弹出层（T1.12a） */
  charList: "deskpet:char:list",
  /** 读角色包立绘（data URL）；没有立绘回 null，界面继续用内置占位图（T2.3-C2） */
  charPortrait: "deskpet:char:portrait",
  /** 读角色包的部位定义 hits.json（0–1 归一化框，T2.3-C2） */
  charHits: "deskpet:char:hits",
  /** renderer 报一次立绘部位点击，main 负责记账（T2.3-C2） */
  uiCharHit: "deskpet:ui:char-hit",
  /** 读「模型供给」设置；密钥只回「已配置 / 未配置」（T1.14b） */
  providersGet: "deskpet:settings:providers:get",
  /** 写「模型供给」设置，落到 .env；改完需重启 sidecar 生效（T1.14b） */
  providersSet: "deskpet:settings:providers:set",
  /** 按能力面探测供给端点连通性（转发 sidecar POST /providers/test，T1.14b） */
  providersTest: "deskpet:settings:providers:test",
  /** 列某个角色的记忆条目，供设置窗记忆面板（转发 sidecar GET /memory/list，T2.1b） */
  memoryList: "deskpet:memory:list",
  /** 删掉一条记忆，下一轮立刻不再注入（F3 验收 4，T2.1b） */
  memoryDelete: "deskpet:memory:delete",
  /** 清空某个角色的记忆（可选只保留最近 N 天，T2.1b） */
  memoryClear: "deskpet:memory:clear",
  /** 读 / 写「行为记忆」总开关（落 .env，改完需重启 sidecar 生效，T2.1c） */
  memoryBehavior: "deskpet:memory:behavior",
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
  "stage_width",
  "stage_height",
] as const;

/** 立绘包围盒上报消息的字段清单（T2.2；窗口尺寸就靠这三个数算）。 */
export const UI_METRICS_FIELDS = ["stage_width", "stage_height", "chatbar_height"] as const;

/** JS 拖动消息的字段（T2.2 用户反馈第五轮：只报开始 / 结束，位置由主进程跟随光标算）。 */
export const UI_DRAG_FIELDS = ["action"] as const;

/** 拖动消息的两种动作：按下开始跟随、松开结束。 */
export const UI_DRAG_ACTIONS = ["start", "end"] as const;

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
export const CHAR_HIT_REGION_FIELDS = ["id", "name", "rect", "color", "reactions", "act"] as const;

export interface CharHitRegion {
  id: string;
  name: string;
  /** 素材归一化坐标 [x, y, w, h]（0–1）：换素材 / 缩放都不会算错（方案 §4.3）。 */
  rect: readonly [number, number, number, number];
  color: string;
  /** 离线兜底台词：LLM 不可用时用角色包里的这几句（方案 §4.3 降级）。 */
  reactions: readonly string[];
  act: string;
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
}

export const CHAR_HIT_KINDS = ["single", "double", "hold"] as const;
export type CharHitKind = (typeof CHAR_HIT_KINDS)[number];

/** renderer → main 的部位点击事实；连击由渲染层统计（方案 §4.3 第 1 条）。 */
export const CHAR_HIT_MESSAGE_FIELDS = [
  "region_id",
  "region_name",
  "streak",
  "gap_ms",
  "kind",
] as const;

export interface CharHitMessage {
  region_id: string;
  region_name: string;
  streak: number;
  gap_ms: number;
  kind: CharHitKind;
}

/**
 * 互动事实（T2.3-C2b）：部位点击带进提示词的那几个字段。
 *
 * 为什么另立类型而不复用 CharHitMessage：gap_ms 只是渲染层算连击的中间量，进提示词没有意义；
 * 这里只留「哪个部位、连了多少下、点还是按住」。
 */
export const CHAT_INTERACTION_FIELDS = ["region_id", "region_name", "streak", "kind"] as const;

export interface ChatInteraction {
  region_id: string;
  region_name: string;
  streak: number;
  kind: CharHitKind;
}

/** 供给来源：本地引擎或云端接口（§6.13 的双轨）。 */
export const PROVIDER_VALUES = ["cloud", "local"] as const;
export type ProviderValue = (typeof PROVIDER_VALUES)[number];

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
  /** .env 的实际路径（给界面显示「写到哪」，不含任何内容）。 */
  env_file: string;
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
  "kind",
  "tier",
  "text",
  "importance",
  "created_at",
  "last_used_at",
  "used_count",
] as const;

/**
 * 设置窗记忆面板的一行，与 sidecar MemoryListItem 一一对应。
 *
 * kind / tier 故意是宽松的 string：库里可能有历史遗留值，界面显示原文好过整块列表 500
 * （sidecar 侧同样用 str 而不是 Literal，理由见 contracts/api_models.py）。
 */
export interface MemoryItem {
  id: number;
  kind: string;
  tier: string;
  text: string;
  importance: number;
  created_at: string;
  last_used_at: string;
  used_count: number;
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
  keep_days?: number | null;
}

export interface MemoryClearResponse {
  deleted: number;
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

/** 主进程上报的使用事实种类，与 sidecar contracts/api_models.py 的 UsageRecordRequest.fact 对齐（T2.3）。
 *
 * 为什么不是 IPC 通道：窗口位移只有主进程看得见（§6.11 的拖动也走 J 侧算），
 * 所以晃动判定与上报都在主进程完成，渲染层不需要参与。
 */
export const USAGE_FACTS = ["window_shake", "char_hit"] as const;
export type UsageFact = (typeof USAGE_FACTS)[number];

/** POST /usage/record 的请求体（T2.3-C1）：char_id 为空表示「不知道记给谁」。
 */
/** 上报请求体的字段（§6.9 的 /usage/record）：与 sidecar 的 UsageRecordRequest 逐字对齐。 */
export const USAGE_RECORD_REQUEST_FIELDS = ["fact", "char_id", "region_id", "streak"] as const;

export interface UsageRecordRequest {
  fact: UsageFact;
  char_id: string;
  /** char_hit 专有：命中的部位 id 与这一串累计点了几下（方案 §4.3 第 2 条）。 */
  region_id?: string;
  streak?: number;
}

/** UsageRecordResponse 的字段清单（运行时可取，供跨语言契约测试对账）。 */
export const USAGE_RECORD_FIELDS = ["recorded"] as const;

/** POST /usage/record 的响应：recorded=false 是没有可承接的会话或开关关着，不是错误。 */
export interface UsageRecordResponse {
  recorded: boolean;
}
