/**
 * 文件职责：每条 IPC 请求通道的入参形状（可执行的契约）。
 *
 * 为什么要把「类型」再写一遍：app/shared/contracts/ipc.ts 里的 interface 编译后就不存在了，
 * 而 IPC 的入参来自另一个进程——拼错字段名、把 id 传成字符串、把数组传成对象，这类错误
 * 以前要一路穿到查库 / 写盘 / 算坐标的地方才炸，日志里只剩一行「某函数收到 undefined」。
 * 这里是主进程的入口闸门：形状不对当场拒掉，错误信息带字段路径（`request.memory_id：必须是整数`）。
 *
 * 为什么集中在一张表里而不是散在各 handler 旁边：表能一眼看全「界面一共能传什么进来」，
 * 也便于测试对着注册表逐条核对（tests/ipc-schemas.test.ts 会读源码，少一条或对不上都会红）。
 *
 * 覆盖范围：只覆盖 `registry.handle`（请求-响应）通道。单向通知（指针、拖动、音频块）高频且
 * 无关状态，校验收益小、开销反而显眼，暂时不在这里。
 *
 * 依赖方向：app/shared 内部（./ipc 的类型与枚举、./validate 的工具）；不 import electron / node。
 * 与契约同步：改 app/shared/contracts/ipc.ts 的请求字段时，这张表要一起改（`pnpm ipc:check` 会提醒）。
 */
import { PROVIDER_VALUES, UI_FPS_OPTIONS } from "../defaults";
import { IPC_CHANNELS } from "../ipc-channels";
import {
  CHAT_INPUT_MODES,
  INTERACT_TRIGGERS,
  MEMORY_QUERY_KINDS,
  PACK_OPEN_MODES,
  PROVIDER_CAPABILITIES,
  TOUCH_GESTURES,
} from "./ipc";
import {
  arrayOf,
  boolean,
  decimal,
  integer,
  none,
  nullable,
  object,
  oneOf,
  oneOfNumbers,
  optional,
  string,
  vector,
  type Schema,
} from "./validate";

/** 角色 id：目录名，长度限住即可（历史包可能带下划线 / 点，不做字符白名单）。 */
const charId = string({ min: 1, max: 64, label: "角色 id" });
/** 库里的自增主键。 */
const rowId = (label: string): Schema<number> => integer({ min: 1, label });
/** 列表类请求的条数：挡住「一次要十万条」。 */
const pageLimit = integer({ min: 1, max: 500, label: "条数" });

const touchRegion = object({
  id: string({ max: 64, label: "部位 id" }),
  name: string({ max: 80, label: "部位名" }),
});

const chatInteraction = object({
  gesture: oneOf(TOUCH_GESTURES),
  regions: arrayOf(touchRegion, { max: 16 }),
  count: integer({ min: 0, max: 999 }),
  duration_ms: integer({ min: 0, max: 3_600_000 }),
});

const regionDraft = object({
  id: string({ max: 64 }),
  name: string({ max: 80 }),
  rect: vector(4, { min: 0, max: 1, label: "归一化框" }),
  color: string({ max: 32 }),
  act: string({ max: 32 }),
});

const lookAtOrigin = vector(2, { min: 0, max: 1, label: "视线支点" });

const companionPatch = object({
  enabled: optional(boolean()),
  screen_enabled: optional(boolean()),
  screen_interval_s: optional(integer({ min: 1, max: 3600 })),
  screen_display_id: optional(string({ max: 64 })),
  ocr_enabled: optional(boolean()),
  vision_model: optional(string({ max: 120 })),
  proactive_enabled: optional(boolean()),
  observe_memory: optional(boolean()),
  app_activity_enabled: optional(boolean()),
  vision_consented: optional(boolean()),
  // -1 = 不启用（陪伴设置里那个「不启用」选项就是 -1；app/main/ui-state.ts 也按 -1..23 钳）
  quiet_hours_start: optional(integer({ min: -1, max: 23 })),
  quiet_hours_end: optional(integer({ min: -1, max: 23 })),
});

const gesturePatch = object({
  triggers: arrayOf(oneOf(INTERACT_TRIGGERS), { max: 4 }),
  enabled: arrayOf(oneOf(TOUCH_GESTURES), { max: 8 }),
});

const relationBody = object({
  familiarity: decimal({ min: 0, max: 100 }),
  trust: decimal({ min: 0, max: 100 }),
  warmth: decimal({ min: 0, max: 100 }),
  unresolved: string({ max: 2000 }),
  recent_conflict: string({ max: 2000 }),
});

const providerTestOverrides = object({
  provider: optional(oneOf(PROVIDER_VALUES)),
  preset: optional(string({ max: 64 })),
  cloud_base_url: optional(string({ max: 500 })),
  cloud_model: optional(string({ max: 200 })),
  cloud_api_key: optional(nullable(string({ max: 400 }))),
  local_base_url: optional(string({ max: 500 })),
  local_model: optional(string({ max: 200 })),
  local_token: optional(nullable(string({ max: 400 }))),
  fallback_base_url: optional(string({ max: 500 })),
  fallback_model: optional(string({ max: 200 })),
});

const providerPatchEntry = object({
  capability: oneOf(PROVIDER_CAPABILITIES),
  provider: optional(oneOf(PROVIDER_VALUES)),
  preset: optional(string({ max: 64 })),
  cloud_base_url: optional(string({ max: 500 })),
  cloud_model: optional(string({ max: 200 })),
  cloud_api_key: optional(nullable(string({ max: 400 }))),
  local_base_url: optional(string({ max: 500 })),
  local_model: optional(string({ max: 200 })),
  local_token: optional(nullable(string({ max: 400 }))),
  fallback_base_url: optional(string({ max: 500 })),
  fallback_model: optional(string({ max: 200 })),
});

/**
 * 通道 → 入参形状。
 *
 * 键必须是 IPC_CHANNELS 的值（⾃检见 tests/ipc-schemas.test.ts）；只有「界面能调用的请求通道」
 * 需要在这里出现，主进程 → 界面的推送通道不在其中。
 */
export const IPC_INPUT_SCHEMAS: Readonly<Record<string, Schema<unknown>>> = {
  // ---- 角色 ----
  [IPC_CHANNELS.charList]: none(),
  [IPC_CHANNELS.charPortrait]: object({ char_id: charId }),
  [IPC_CHANNELS.charHits]: object({ char_id: charId }),
  [IPC_CHANNELS.charAppearance]: object({ char_id: charId }),

  // ---- 聊天 ----
  [IPC_CHANNELS.chatSend]: object({
    session_id: string({ min: 1, max: 128, label: "会话 id" }),
    char_id: charId,
    text: string({ max: 20_000, label: "台词" }),
    input_mode: optional(oneOf(CHAT_INPUT_MODES)),
    client_ts: optional(decimal({ min: 0 })),
    proactive: optional(boolean()),
    proactive_kind: optional(string({ max: 64 })),
    app_context: optional(arrayOf(string({ max: 500 }), { max: 20 })),
    screen_text: optional(string({ max: 4000 })),
    interaction: optional(chatInteraction),
  }),
  [IPC_CHANNELS.chatCancel]: object({
    session_id: string({ min: 1, max: 128, label: "会话 id" }),
    request_id: optional(string({ max: 200 })),
  }),

  // ---- 开发者模式 ----
  [IPC_CHANNELS.devModeGet]: none(),
  [IPC_CHANNELS.devModeSet]: object({ enabled: nullable(boolean()) }),

  // ---- 记忆：列表与增删改 ----
  [IPC_CHANNELS.memoryList]: object({
    char_id: charId,
    kind: optional(oneOf([...MEMORY_QUERY_KINDS, ""])),
    tier: optional(string({ max: 32 })),
    min_importance: optional(decimal({ min: 0, max: 10 })),
    limit: optional(pageLimit),
  }),
  [IPC_CHANNELS.memoryDelete]: object({ memory_id: rowId("记忆 id") }),
  [IPC_CHANNELS.memoryEdit]: object({
    memory_id: rowId("记忆 id"),
    text: string({ max: 4000, label: "记忆文本" }),
    importance: optional(nullable(decimal({ min: 0, max: 10 }))),
    kind: optional(oneOf(MEMORY_QUERY_KINDS)),
  }),
  [IPC_CHANNELS.memoryClear]: object({ char_id: charId }),
  [IPC_CHANNELS.memoryBehavior]: object({ enabled: nullable(boolean()) }),

  // ---- 记忆：语义检索 ----
  [IPC_CHANNELS.memoryEmbeddingStatus]: object({ char_id: charId }),
  [IPC_CHANNELS.memoryEmbeddingConfig]: object({ enabled: nullable(boolean()) }),
  [IPC_CHANNELS.memoryEmbeddingIndex]: object({
    char_id: charId,
    limit: optional(integer({ min: 1, max: 2000, label: "条数" })),
  }),

  // ---- 记忆：时间线 ----
  [IPC_CHANNELS.memoryTimeline]: object({
    char_id: charId,
    levels: optional(string({ max: 64 })),
    limit: optional(pageLimit),
  }),
  [IPC_CHANNELS.memoryTimelineRebuild]: object({ char_id: charId }),
  [IPC_CHANNELS.memoryTimelineBackfill]: object({
    char_id: charId,
    days: optional(integer({ min: 1, max: 3650, label: "天数" })),
  }),
  [IPC_CHANNELS.memoryPeriodDetail]: rowId("时段 id"),
  [IPC_CHANNELS.memoryPeriodEdit]: object({
    period_id: rowId("时段 id"),
    summary: string({ max: 20_000, label: "时段小结" }),
    label: optional(string({ max: 200 })),
    pinned: optional(boolean()),
  }),

  // ---- 记忆：手写日记 ----
  [IPC_CHANNELS.memoryDiaryList]: object({ char_id: charId, limit: optional(pageLimit) }),
  [IPC_CHANNELS.memoryDiaryAdd]: object({
    char_id: charId,
    text: string({ max: 20_000, label: "日记正文" }),
    occurred_at: optional(string({ max: 64 })),
    mood: optional(string({ max: 64 })),
    tags: optional(string({ max: 500 })),
  }),
  [IPC_CHANNELS.memoryDiaryUpdate]: object({
    entry_id: rowId("日记 id"),
    text: string({ max: 20_000, label: "日记正文" }),
    mood: optional(string({ max: 64 })),
    tags: optional(string({ max: 500 })),
  }),
  [IPC_CHANNELS.memoryDiaryDelete]: rowId("日记 id"),

  // ---- 记忆：关系 / 待办 / 图谱 ----
  [IPC_CHANNELS.memoryRelationGet]: charId,
  [IPC_CHANNELS.memoryRelationSave]: object({ char_id: charId, request: relationBody }),
  [IPC_CHANNELS.memoryIntentions]: object({ char_id: charId, limit: optional(pageLimit) }),
  [IPC_CHANNELS.memoryIntentionAdd]: object({
    char_id: charId,
    text: string({ max: 2000, label: "待办文本" }),
    trigger_at: optional(string({ max: 64 })),
  }),
  [IPC_CHANNELS.memoryIntentionResolve]: rowId("待办 id"),
  [IPC_CHANNELS.memoryGraph]: object({ char_id: charId, limit: optional(pageLimit) }),
  [IPC_CHANNELS.memoryGraphRebuild]: object({ char_id: charId }),

  // ---- 记忆：原文 / 摘要 / 注入预览 ----
  [IPC_CHANNELS.memoryMessages]: object({
    char_id: charId,
    limit: optional(pageLimit),
    before_id: optional(nullable(integer({ min: 1 }))),
  }),
  [IPC_CHANNELS.memorySummaries]: object({ char_id: charId, limit: optional(pageLimit) }),
  [IPC_CHANNELS.memoryEditSummary]: object({
    summary_id: rowId("摘要 id"),
    text: string({ max: 20_000, label: "摘要文本" }),
  }),
  [IPC_CHANNELS.memoryDeleteSummary]: rowId("摘要 id"),
  [IPC_CHANNELS.memoryEditMessage]: object({
    message_id: rowId("消息 id"),
    text: string({ max: 20_000, label: "原文" }),
  }),
  [IPC_CHANNELS.memoryDeleteMessage]: rowId("消息 id"),
  [IPC_CHANNELS.memoryContext]: object({
    char_id: charId,
    query: optional(string({ max: 1000 })),
  }),

  // ---- 角色包 ----
  [IPC_CHANNELS.packOpenEditor]: optional(
    object({ mode: oneOf(PACK_OPEN_MODES), char_id: optional(charId) }),
  ),
  [IPC_CHANNELS.packPickImage]: none(),
  [IPC_CHANNELS.packSave]: object({
    char_id: charId,
    display_name: string({ max: 80 }),
    description: string({ max: 2000 }),
    personality: string({ max: 4000 }),
    speaking_style: string({ max: 2000 }),
    portrait_data_url: string({ max: 12_000_000, label: "立绘 data URL" }),
    regions: arrayOf(regionDraft, { max: 24 }),
    look_at_origin: optional(lookAtOrigin),
  }),
  [IPC_CHANNELS.packLoad]: object({ char_id: charId }),
  [IPC_CHANNELS.packSaveRegions]: object({
    char_id: charId,
    regions: arrayOf(regionDraft, { max: 24 }),
    look_at_origin: optional(lookAtOrigin),
  }),
  [IPC_CHANNELS.packGenerateRegions]: object({ char_id: charId }),
  [IPC_CHANNELS.packSaveCard]: object({
    char_id: charId,
    display_name: string({ max: 80 }),
    description: string({ max: 2000 }),
    personality: string({ max: 4000 }),
    speaking_style: string({ max: 2000 }),
  }),
  [IPC_CHANNELS.packExport]: object({
    char_id: charId,
    include_voice: optional(boolean()),
    include_model: optional(boolean()),
  }),
  [IPC_CHANNELS.packImport]: optional(
    object({
      include_voice: optional(boolean()),
      include_model: optional(boolean()),
      path: optional(string({ max: 4096 })),
    }),
  ),

  // ---- 模型供给 / 用量 / 数据 ----
  [IPC_CHANNELS.providersGet]: none(),
  [IPC_CHANNELS.providersSet]: arrayOf(providerPatchEntry, { max: 8, label: "供给改动" }),
  [IPC_CHANNELS.providersTest]: object({
    capability: oneOf(PROVIDER_CAPABILITIES),
    overrides: optional(providerTestOverrides),
  }),
  [IPC_CHANNELS.providersModels]: object({
    capability: oneOf(PROVIDER_CAPABILITIES),
    overrides: optional(providerTestOverrides),
  }),
  [IPC_CHANNELS.usageStats]: none(),
  [IPC_CHANNELS.usageSetRecording]: boolean(),
  [IPC_CHANNELS.usageClear]: none(),
  [IPC_CHANNELS.dataExport]: none(),
  [IPC_CHANNELS.dataRestore]: none(),
  [IPC_CHANNELS.dataBackups]: none(),
  [IPC_CHANNELS.dataBackupNow]: none(),
  [IPC_CHANNELS.dataOpenDir]: none(),

  // ---- 系统 ----
  [IPC_CHANNELS.healthGet]: none(),
  [IPC_CHANNELS.sidecarRestart]: none(),
  [IPC_CHANNELS.appGetInfo]: none(),
  [IPC_CHANNELS.modelsList]: none(),
  [IPC_CHANNELS.modelsInstall]: string({ min: 1, max: 128, label: "模型 id" }),
  [IPC_CHANNELS.modelsRemove]: string({ min: 1, max: 128, label: "模型 id" }),
  // 语音识别模型（D7）：读现状与「开始下载」都不带参数
  [IPC_CHANNELS.asrModel]: none(),
  [IPC_CHANNELS.asrModelPrefetch]: none(),
  // 检查更新（D6）：不带参数；要打开的地址由主进程自己记住，不接受界面传入
  [IPC_CHANNELS.appCheckUpdate]: none(),
  [IPC_CHANNELS.appOpenUpdatePage]: none(),
  // 错误详情弹窗的「复制」：只收已脱敏文本，长度上限防止把整篇响应塞进剪贴板
  [IPC_CHANNELS.appCopyText]: string({ min: 1, max: 20_000, label: "复制内容" }),

  // ---- 界面形态 ----
  [IPC_CHANNELS.uiGetState]: none(),
  [IPC_CHANNELS.uiSetState]: object({
    x: optional(decimal({ min: -100_000, max: 100_000 })),
    y: optional(decimal({ min: -100_000, max: 100_000 })),
    scale: optional(decimal({ min: 0.5, max: 2 })),
    click_through: optional(boolean()),
    always_on_top: optional(boolean()),
    char_id: optional(nullable(charId)),
    gestures: optional(gesturePatch),
    companion: optional(companionPatch),
    tts_enabled: optional(boolean()),
    native_mic_fallback: optional(boolean()),
    fps: optional(oneOfNumbers(UI_FPS_OPTIONS)),
  }),
  [IPC_CHANNELS.settingsOpen]: optional(
    object({
      pane: optional(
        oneOf(["appearance", "gestures", "packs", "providers", "engine", "memory", "dev"]),
      ),
    }),
  ),
  [IPC_CHANNELS.companionOpen]: none(),

  // ---- 语音 ----
  [IPC_CHANNELS.voiceMicStatus]: none(),
  [IPC_CHANNELS.voiceOpenMicSettings]: none(),
  [IPC_CHANNELS.voiceOpenSoundSettings]: none(),
  [IPC_CHANNELS.voiceNativeStart]: none(),
  [IPC_CHANNELS.voiceNativeStop]: none(),
};

/** 通道没有登记形状时返回 null（注册表据此跳过校验，并在 `pnpm ipc:check` 里被点名）。 */
export function inputSchemaFor(channel: string): Schema<unknown> | null {
  return IPC_INPUT_SCHEMAS[channel] ?? null;
}
