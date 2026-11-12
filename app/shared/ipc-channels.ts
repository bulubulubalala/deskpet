/**
 * 文件职责：IPC 通道白名单（D2 契约单一权威的第一块拼图）。
 *
 * 为什么不在 app/main/ipc.ts 里：channel 名是主进程与 preload「同时在运行时读」的东西，
 * 留在 main 里就会逼 preload 去 import 主进程实现。这里只放字符串常量与派生类型，
 * payload 类型仍留在 app/main/ipc.ts，待 M4 的 D2 完整落地再整体搬过来。
 *
 * 依赖方向：app/shared 不 import electron、node 内置模块与任何 app/main、app/renderer 代码。
 */
export const IPC_CHANNELS = {
  /** renderer 拉取一次心跳快照（main 转发 sidecar GET /health） */
  healthGet: "deskpet:health:get",
  /** main 推送心跳变化（连续 3 次失败判定离线后也会推，需求 §7.2） */
  healthChanged: "deskpet:health:changed",
  /** 手动重启 sidecar（不替用户修语音引擎，D14） */
  sidecarRestart: "deskpet:sidecar:restart",
  /** 取应用与 sidecar 的基本信息（版本号、端口、pid） */
  appGetInfo: "deskpet:app:get-info",
  /** 问一次 GitHub 最新发布，跟当前版本比大小（只读，不下载不安装） */
  appCheckUpdate: "deskpet:app:check-update",
  /** 在系统浏览器里打开发布页（地址由主进程自己决定，界面传不了 URL） */
  appOpenUpdatePage: "deskpet:app:open-update-page",
  /** 把一段已脱敏的错误详情写到系统剪贴板（弹窗里的「复制错误详情」） */
  appCopyText: "deskpet:app:copy-text",
  /** 用户发一句话（聊天框回车或 ASR 结果）→ main 转发 sidecar POST /chat/stream（T1.3 实现） */
  chatSend: "deskpet:chat:send",
  /** main 推送 sidecar 流里的单个 §6.2 事件（T1.3 实现） */
  chatEvent: "deskpet:chat:event",
  /** 打断当前回复：停播 + 取消进行中的 TTS 与 LLM 流（F2，T1.6 实现） */
  chatCancel: "deskpet:chat:cancel",

  /** 全双工（P2）：开始一句收音（对应 WS 的 audio.start） */
  voiceBegin: "deskpet:voice:begin",
  /** 全双工（P2）：音频块上行（16bit 小端 / 16k / 单声道 PCM） */
  voiceAudio: "deskpet:voice:audio",
  /** 全双工（P2）：这一句说完了（对应 WS 的 audio.end） */
  voiceEnd: "deskpet:voice:end",
  /** 全双工（P2）：打断（作废在途识别 / 生成 / 合成） */
  voiceCancel: "deskpet:voice:cancel",
  /** 全双工（P2）：sidecar 推来的语音事件（asr.final / llm.s / error …） */
  voiceEvent: "deskpet:voice:event",
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
  /** main → renderer：全桌面鼠标位置（相对主窗内容区，CSS px），供 Live2D 视线跟随（T2.27） */
  uiCursor: "deskpet:ui:cursor",
  /** renderer 开关全桌面鼠标追踪：只有 Live2D 舞台创建时打开，PNG / 销毁时关闭（T2.27） */
  uiCursorTrack: "deskpet:ui:cursor-track",
  /** renderer 报一次拖动位移，main 按当前窗口位置加上它（§6.11，T2.2 真机反馈：不用 app-region） */
  uiDrag: "deskpet:ui:drag",
  /** renderer 报当前输入模式（文字 / 语音 / 互动，T2.6）：三选一，main 据此拒绝跨模式输入 */
  uiInputMode: "deskpet:ui:input-mode",
  /** renderer 在触摸手势刚成立时提前报 demand，main 立刻停播 + cancel（T2.6） */
  uiTouchIntent: "deskpet:ui:touch-intent",
  /** main → renderer：互动的 8 秒冷却与每分钟 4 次额度快照（只读）。 */
  uiTouchGate: "deskpet:ui:touch-gate",
  /** renderer 请求把主窗收进托盘，不退出程序（聊天条按钮与托盘菜单共用，T2.3-C2c） */
  uiMinimize: "deskpet:ui:minimize",
  /** 打开设置窗（聊天条与托盘两个入口都能到，F11，T1.12a） */
  settingsOpen: "deskpet:settings:open",
  companionOpen: "deskpet:companion:open",
  /** 列出 characters/ 下的可选角色，供聊天条「角色切换」弹出层（T1.12a） */
  charList: "deskpet:char:list",
  /** 读角色包立绘（data URL）；没有立绘回 null，界面继续用内置占位图（T2.3-C2） */
  charPortrait: "deskpet:char:portrait",
  /** 读角色包的部位定义 hits.json（0–1 归一化框，T2.3-C2） */
  charHits: "deskpet:char:hits",
  /** 读角色包的形象配置 appearance.json（stage / model / 动作与表情映射），供 Stage 抽象层选实现（T2.4） */
  charAppearance: "deskpet:char:appearance",
  /** renderer 报一次立绘部位点击，main 负责记账（T2.3-C2） */
  uiCharHit: "deskpet:ui:char-hit",
  /** 读「模型供给」设置；密钥只回「已配置 / 未配置」（T1.14b） */
  providersGet: "deskpet:settings:providers:get",
  /** 写「模型供给」设置，落到 .env；改完需重启 sidecar 生效（T1.14b） */
  providersSet: "deskpet:settings:providers:set",
  /** 按能力面探测供给端点连通性（转发 sidecar POST /providers/test，T1.14b） */
  providersTest: "deskpet:settings:providers:test",
  /** 拉取云端端点 /models，供设置窗「获取模型列表」（支持未保存表单值） */
  providersModels: "deskpet:settings:providers:models",
  /** 列某个角色的记忆条目，供设置窗记忆面板（转发 sidecar GET /memory/list，T2.1b） */
  memoryList: "deskpet:memory:list",
  /** 删掉一条记忆，下一轮立刻不再注入（F3 验收 4，T2.1b） */
  memoryDelete: "deskpet:memory:delete",
  /** 改一条 L0 记忆的文本与重要度（开发者模式，转发 PATCH /memory/{id}，T2.3-B2） */
  memoryEdit: "deskpet:memory:edit",
  /** 清空某个角色的记忆（可选只保留最近 N 天，T2.1b） */
  memoryClear: "deskpet:memory:clear",
  /** 读 / 写「行为记忆」总开关（落 .env，改完需重启 sidecar 生效，T2.1c） */
  memoryBehavior: "deskpet:memory:behavior",
  /** 读语义检索状态（转发 GET /memory/embeddings/status，T2.32） */
  memoryEmbeddingStatus: "deskpet:memory:embedding-status",
  /** 读 / 写语义检索开关（落 .env，需重启 sidecar 生效，T2.40） */
  memoryEmbeddingConfig: "deskpet:memory:embedding-config",
  /** 手动补索引消息/事实向量（转发 POST /memory/embeddings/index，T2.32） */
  memoryEmbeddingIndex: "deskpet:memory:embedding-index",
  /** 时间线列表 / 手动整理 / 单条详情（T2.33） */
  memoryTimeline: "deskpet:memory:timeline",
  memoryTimelineRebuild: "deskpet:memory:timeline-rebuild",
  memoryTimelineBackfill: "deskpet:memory:timeline-backfill",
  memoryPeriodDetail: "deskpet:memory:period-detail",
  memoryPeriodEdit: "deskpet:memory:period-edit",
  /** 手动日记 CRUD（T2.33） */
  memoryDiaryList: "deskpet:memory:diary-list",
  memoryDiaryAdd: "deskpet:memory:diary-add",
  memoryDiaryUpdate: "deskpet:memory:diary-update",
  memoryDiaryDelete: "deskpet:memory:diary-delete",
  memoryGraph: "deskpet:memory:graph",
  memoryGraphRebuild: "deskpet:memory:graph-rebuild",
  /** 关系记忆读写（T2.33） */
  memoryRelationGet: "deskpet:memory:relation-get",
  memoryIntentions: "deskpet:memory:intentions",
  memoryIntentionAdd: "deskpet:memory:intention-add",
  memoryIntentionResolve: "deskpet:memory:intention-resolve",
  memoryRelationSave: "deskpet:memory:relation-save",
  /** F10 使用统计：读取汇总、暂停 / 恢复记录、清空。 */
  usageStats: "deskpet:usage:stats",
  usageSetRecording: "deskpet:usage:set-recording",
  usageClear: "deskpet:usage:clear",
  /** M3 数据导出：让 sidecar 打一个 zip（记忆库快照 + 设置脱敏 + 角色 + 日志摘要）。 */
  dataExport: "deskpet:data:export",
  /** 从导出包恢复记忆库：只暂存，重启引擎后生效（M3 / D9） */
  dataRestore: "deskpet:data:restore",
  /** 列出备份目录里的文件（每日快照 / 操作前留底 / 恢复残骸），只读（D9） */
  dataBackups: "deskpet:data:backups",
  /** 立即给记忆库做一份快照（用户主动点按钮，D9） */
  dataBackupNow: "deskpet:data:backup-now",
  /** 在资源管理器里打开数据目录（备份就在它的 backups/ 子目录里） */
  dataOpenDir: "deskpet:data:open-dir",
  /** 读开发者模式开关（data/dev.json，T2.3-B1）：只控制界面显隐，不是安全边界 */
  devModeGet: "deskpet:dev:get",
  /** 写开发者模式开关（同上）；enabled = null 表示只读 */
  devModeSet: "deskpet:dev:set",
  /** 开发者模式「原文」页：翻该角色的历史原文（转发 GET /memory/messages，只读，T2.3-B1） */
  memoryMessages: "deskpet:memory:messages",
  memorySummaries: "deskpet:memory:summaries",
  memoryEditSummary: "deskpet:memory:edit-summary",
  memoryDeleteSummary: "deskpet:memory:delete-summary",
  memoryEditMessage: "deskpet:memory:edit-message",
  memoryDeleteMessage: "deskpet:memory:delete-message",
  /** 开发者模式「注入上下文」页：干跑一次下一轮的记忆装配（转发 GET /memory/context） */
  memoryContext: "deskpet:memory:context",
  /** 打开角色包编辑器独立窗口（设置窗「新建角色包」入口，T2.3-D） */
  packOpenEditor: "deskpet:pack:open-editor",
  /** 弹系统文件选择框选一张立绘并回 data URL（不放开 CSP 的 file:，方案 §5.2） */
  packPickImage: "deskpet:pack:pick-image",
  /** 把编辑器画好的角色包写进 characters/<char_id>/（T2.3-D） */
  packSave: "deskpet:pack:save",
  /** 读现有角色包（立绘 + 卡片展示字段 + 部位），供「编辑当前角色部位」用（T2.5） */
  packLoad: "deskpet:pack:load",
  /** 只把部位写回 characters/<char_id>/hits.json（T2.5） */
  packSaveRegions: "deskpet:pack:save-regions",
  /** 只把角色卡（显示名 / 简介 / 人格 / 说话风格）写回 card.json + pack.json（T2.7） */
  packSaveCard: "deskpet:pack:save-card",
  packExport: "deskpet:pack:export",
  packImport: "deskpet:pack:import",
  /** 按 Live2D 网格顶点生成部位框（T2.44）：主进程问主窗要几何，再直接回草稿。 */
  packGenerateRegions: "deskpet:pack:generate-regions",
  /** main → 主窗：问一次网格外接框（T2.44）；渲染层用 hitsProbeReply 回。 */
  hitsProbe: "deskpet:hits:probe",
  hitsProbeReply: "deskpet:hits:probe-reply",
  /** main → 两个渲染层：characters/ 里多了角色包，角色菜单要刷新（T2.3-D） */
  charactersChanged: "deskpet:characters:changed",
  modelsList: "deskpet:models:list",
  modelsInstall: "deskpet:models:install",
  modelsRemove: "deskpet:models:remove",
  modelsProgress: "deskpet:models:progress",
  /** 语音识别模型现状（D7）：没下过 / 正在下 / 就绪。 */
  asrModel: "deskpet:asr:model",
  /** 让引擎开始下载语音识别模型（只起任务，进度靠再查一次 asrModel）。 */
  asrModelPrefetch: "deskpet:asr:model:prefetch",
  voiceMicStatus: "deskpet:voice:mic-status",
  voiceOpenMicSettings: "deskpet:voice:open-mic-settings",
  voiceOpenSoundSettings: "deskpet:voice:open-sound-settings",
  voiceNativeStart: "deskpet:voice:native-start",
  voiceNativeStop: "deskpet:voice:native-stop",
  voiceNativeAudio: "deskpet:voice:native-audio",
  voiceNativeError: "deskpet:voice:native-error",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
