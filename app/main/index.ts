/**
 * 文件职责：Electron 主进程组合根——装配配置、日志、sidecar 引擎、界面状态、窗口与托盘。
 *
 * 为什么开窗口之前先起 sidecar：心跳灯要在第一帧就显示真实状态（需求 M0 判据）；
 * 起不来也不拦窗口，界面按 §6.7 明示 failed 与原因。
 * 界面形态（T1.12a）：主窗是无边框透明窗，只有立绘与聊天条；状态面板搬进设置窗（F11 / §6.11）。
 * 依赖方向：main -> electron + ./config ./logger ./engine ./ipc-handlers ./health-client
 *           ./heartbeat ./sidecar-process ./ui-controller ./windows ./character-list。
 * 启动链：loadMainConfig -> createMainLogger -> UiController.load -> 引擎/编排 -> registerIpcHandlers
 *         -> createPetWindow -> 托盘 -> engine.start。
 */
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ActivityLog } from "./activity-log";
import {
  companionHtmlPath,
  editorHtmlPath,
  modelCatalogPath,
  preloadPath,
  rendererIndexPath,
  settingsHtmlPath,
} from "./app-paths";
import { registerCharacterAssetProtocol, registerCharacterAssetScheme } from "./asset-protocol";
import { listCharacters } from "./character-list";
import { ChatTurns } from "./chat-turns";
import { createCompanionSync } from "./companion-sync";
import { loadMainConfig, PORTABLE_MARKER, type MainConfig } from "./config";
import { CrashGuard, isHarmlessChildProcess, type CrashNotice } from "./crash-guard";
import { CursorTracker } from "./cursor-tracker";
import { ensureDefaultCharacters } from "./default-characters";
import { buildDiagnosticsReport, tailLines } from "./diagnostics";
import { SidecarEngine, type HealthView } from "./engine";
import { exportDataAndReveal } from "./export-data";
import { ENV_FILE_NAME, mergeEnv, resolveEnvFilePath } from "./env-file";
import { toErrorMessage } from "./errors";
import { HealthClient } from "./health-client";
import { HeartbeatMonitor } from "./heartbeat";
import {
  IPC_CHANNELS,
  type CharactersChangedMessage,
  type SettingsPaneId,
  type UiStatePayload,
  type VoiceStreamEvent,
} from "../shared/contracts/ipc";
import { registerIpcHandlers, rendererPusher } from "./ipc-handlers";
import { createMainLogger, type MainLogger } from "./logger";
import { configureMediaPermissions, microphoneAccessStatus } from "./media-permissions";
import { MicBusyMonitor } from "./mic-occupancy";
import { ModelManager } from "./model-manager";
import { NotificationStateMonitor } from "./notification-state";
import { NativeMicCapture } from "./native-mic";
import { loadCharacterPack } from "./pack-editor";
import { CharacterPackWatcher } from "./pack-watcher";
import { PresenceReporter } from "./presence-reporter";
import { inQuietHours } from "./quiet-hours";
import { SidecarClient } from "./sidecar-client";
import { capturePrimaryScreen } from "./screen-capture";
import type { ScreenObservation } from "./screen-watcher";
import { ShakeDetector } from "./shake-detector";
import { SidecarProcess } from "./sidecar-process";
import {
  SETTINGS_FILE_NAME,
  SettingsStore,
  type SecretBox,
  type SettingsLogLevel,
} from "./settings-store";
import { UiController, type PetWindowHandle } from "./ui-controller";
import { VoiceSocketClient } from "./voice-socket";
import { TurnCoordinator } from "./turn-coordinator";
import { UpdateChecker } from "./update-check";
import { createTray } from "./tray-menu";
import { DEV_MODE_FILENAME } from "./dev-mode";
import { UI_STATE_FILENAME } from "./ui-state";
import {
  CompanionWindowController,
  createPetWindow,
  EditorWindowController,
  SettingsWindowController,
} from "./windows";

registerCharacterAssetScheme();

let mainWindow: BrowserWindow | null = null;
/** 全桌面鼠标追踪（T2.27）：只在 Live2D 舞台存在时由渲染层打开。 */
let cursorTracker: CursorTracker | null = null;
let tray: Tray | null = null;
let engine: SidecarEngine | null = null;
let logger: MainLogger | null = null;
let ui: UiController | null = null;
let unregisterIpc: (() => void) | null = null;
/** 语音全双工长连接（P2）；端点跟随心跳，退出时关闭。 */
let voiceSocket: VoiceSocketClient | null = null;
/** Chromium 麦克风失败时的 Windows 原生采集 helper（按需启动）。 */
let nativeMic: NativeMicCapture | null = null;
/** 在场快照与主动决策；最小化硬门槛也在这里守一道 */
let presenceReporter: PresenceReporter | null = null;
/** characters/ 热重载监听（F6） */
let packWatcher: CharacterPackWatcher | null = null;
let micBusyMonitor: MicBusyMonitor | null = null;
let dndMonitor: NotificationStateMonitor | null = null;
/** 心跳 → sidecar HTTP 端点的同步退订（sidecar 每次重启都会换端口与 token）。 */
let unregisterRuntimeSync: (() => void) | null = null;
/** 屏幕观察的定时器：退出时停掉，否则 node 事件循环会多撑 5 秒（观察间隔）。 */
let stopCompanionSync: (() => void) | null = null;
/** 关闭按钮默认只是隐藏到托盘；只有真正退出（托盘菜单/系统退出）才放行。 */
let quitting = false;

/**
 * 设置仓库（D4）：data/settings.json 是运行时配置的唯一真相源。
 * 只在这里装一次；之后每次重算配置（含「重启后台引擎」）都读它，不再各自解析 .env。
 */
let settings: SettingsStore | null = null;
/** 建 logger 之前发生的设置事件先攒着，日志实例一就绪就补写（否则「导入了旧 .env」这条会丢）。 */
const earlySettingsLogs: Array<{ level: SettingsLogLevel; event: string; message: string }> = [];

/**
 * 崩溃兜底（见 app/main/crash-guard.ts）：进程级异常、渲染进程崩溃都先汇到这里，
 * 再决定「只记日志 / 弹托盘气泡 / 自动重载界面」。放在模块顶层是因为 bootstrap 之前就可能抛。
 */
const crashGuard = new CrashGuard();

/**
 * 密钥加密后端：Electron 自带的 safeStorage（Windows 下就是 DPAPI，绑定当前用户）。
 * 为什么不用 sidecar/adapters/dpapi.py：主进程启动时就得把密钥交给 sidecar 子进程，
 * Python 侧解密帮不上忙、还会绕成循环；接口留成 SecretBox，单测里换假实现即可。
 */
function createSecretBox(): SecretBox | null {
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {
    available = false;
  }
  if (!available) {
    return null;
  }
  return {
    available: true,
    seal: (plain: string): string => safeStorage.encryptString(plain).toString("base64"),
    open: (sealed: string): string => safeStorage.decryptString(Buffer.from(sealed, "base64")),
  };
}

/** 设置仓库的日志出口：logger 还没建好时先攒着（启动最早期也要留下「迁移/损坏」这类事件）。 */
function logSettings(level: SettingsLogLevel, event: string, message: string): void {
  const sink = logger;
  if (sink === null) {
    earlySettingsLogs.push({ level, event, message });
    return;
  }
  if (level === "warn") {
    sink.warn(event, message);
  } else {
    sink.info(event, message);
  }
}

/** 刚才那次 resolveConfig 一定装好了设置仓库；取不到说明装配顺序被改坏了，直接抛。 */
function requireSettings(): SettingsStore {
  if (settings === null) {
    throw new Error("设置仓库尚未装载（resolveConfig 未被调用）");
  }
  return settings;
}

/** logger 一就绪就把早到的设置事件按原顺序补写，避免「导入了旧 .env」这条只在控制台出现。 */
function flushEarlySettingsLogs(sink: MainLogger): void {
  for (const entry of earlySettingsLogs.splice(0)) {
    if (entry.level === "warn") {
      sink.warn(entry.event, entry.message);
    } else {
      sink.info(entry.event, entry.message);
    }
  }
}

/**
 * 推导配置：data/settings.json（唯一真相源）做底，真实进程环境变量覆盖它。
 *
 * 为什么先算一遍「只有进程环境变量」的配置：settings.json 就在数据目录里，
 * 而数据目录本身可能被 DESKPET_DATA_DIR 改；所以数据目录只认进程环境变量，
 * 设置文件里的 DESKPET_DATA_DIR 一律忽略（否则会变成「按设置找不到设置文件」的循环）。
 */
async function resolveConfig(): Promise<MainConfig> {
  const isDev = !app.isPackaged;
  const appRoot = app.getAppPath();
  const userDataDir = app.getPath("userData");
  // 便携模式：exe 同级放 portable.txt 就成立（dev 态看仓库根，方便打包前先试）。
  // 只有它是显式存在才生效——安装到 Program Files 时目录不可写，默认必须走 userData。
  const portableRoot = isDev ? appRoot : dirname(process.execPath);
  const portable = existsSync(join(portableRoot, PORTABLE_MARKER));
  // 旧 .env 的实际位置：只在首次启动迁移时读一次，之后 settings.json 说了算。
  const envFile = portable
    ? join(portableRoot, ENV_FILE_NAME)
    : resolveEnvFilePath({ isDev, appRoot, userDataDir, env: process.env });
  const probe = loadMainConfig({
    isDev,
    appRoot,
    resourcesRoot: process.resourcesPath,
    userDataDir,
    env: process.env,
    envFile,
    execPath: process.execPath,
    portable,
  });
  const store =
    settings ??
    (await SettingsStore.open({
      file: join(probe.dataDir, SETTINGS_FILE_NAME),
      box: createSecretBox(),
      legacyEnvFile: envFile,
      onLog: logSettings,
    }));
  settings = store;
  const stored = store.toEnv();
  delete stored["DESKPET_DATA_DIR"];
  return loadMainConfig({
    isDev,
    appRoot,
    resourcesRoot: process.resourcesPath,
    userDataDir,
    env: mergeEnv(stored, process.env),
    envFile,
    execPath: process.execPath,
    portable,
  });
}

/**
 * 当前显示器的工作区（不含任务栏）：托盘「位置重置到屏幕中央」按它居中（T2.2）。
 * 窗口还没建时返回 null，控制器那边就当没这件事。
 */
function currentWorkArea(): { x: number; y: number; width: number; height: number } | null {
  if (mainWindow === null) {
    return null;
  }
  const [x, y] = mainWindow.getPosition();
  return screen.getDisplayNearestPoint({ x: x ?? 0, y: y ?? 0 }).workArea;
}

function showWindow(): void {
  if (mainWindow === null) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function openSettings(pane?: SettingsPaneId): void {
  // 设置窗由 bootstrap 装配的控制器持有单实例；这里只负责把请求转过去
  ui?.openSettings(pane);
}

/**
 * 托盘气泡是唯一不依赖窗口的通知通道——窗口正好崩了的时候它还能说话。
 * 非 Windows 或托盘还没建好时不硬造一个通知，只留日志（宁可少提示，也不要静默吞掉）。
 */
function notifyUser(title: string, body: string): void {
  if (process.platform === "win32" && tray !== null && !tray.isDestroyed()) {
    try {
      tray.displayBalloon({ title, content: body });
      return;
    } catch (error: unknown) {
      logger?.warn("app.notify_failed", "托盘气泡没能弹出", { error: toErrorMessage(error) });
    }
  }
  logger?.warn("app.notify_skipped", "没有可用的通知通道，提示只进日志：" + body);
}

/** 每条崩溃都写日志（不受冷却影响）；同一事件的提示按冷却节流，避免崩溃风暴刷屏。 */
function reportCrash(notice: CrashNotice): void {
  logger?.error(notice.event, notice.message, { scope: notice.scope, detail: notice.detail });
  if (crashGuard.shouldNotify(notice.event)) {
    notifyUser("deskpet 遇到问题", notice.message);
  }
}

// 装在最外层：读 .env、装配配置、起 sidecar 都可能抛，而那时既没有窗口也没有日志实例。
// 默认行为是直接杀进程（用户只看到窗口凭空消失），这里改成「记账 + 提示 + 继续跑」。
process.on("uncaughtException", (error: unknown) => {
  reportCrash(crashGuard.recordMainCrash("uncaughtException", error));
});
process.on("unhandledRejection", (reason: unknown) => {
  reportCrash(crashGuard.recordMainCrash("unhandledRejection", reason));
});

/** shell.openPath 失败时返回非空字符串而不是抛异常，不检查返回值就等于静默失败。 */
async function openPathInExplorer(dir: string): Promise<void> {
  const failure = await shell.openPath(dir);
  if (failure !== "") {
    logger?.warn("app.open_path_failed", "打开目录失败：" + dir, { reason: failure });
  }
}

/**
 * 把「版本 / 系统 / 配置状态 / 最近日志」拼成一段可直接粘贴的文本。
 *
 * 为什么放在主进程：出问题时界面可能已经白屏或崩了，托盘菜单是这个状态下唯一还能点的地方。
 * 脱敏在 diagnostics.ts 里统一做；这里只负责取数，不拼格式（格式有单测）。
 */
async function copyDiagnostics(config: MainConfig, mainLogger: MainLogger): Promise<void> {
  let rawLog = "";
  try {
    rawLog = await readFile(config.mainLogFile, "utf8");
  } catch (error) {
    mainLogger.warn("app.diagnostics_log_unreadable", "读不到主进程日志，诊断报告将不含日志", {
      error: toErrorMessage(error),
    });
  }
  const health = engine === null ? null : engine.getHealth();
  const crashState = crashGuard.snapshot();
  const report = buildDiagnosticsReport({
    version: app.getVersion(),
    isDev: config.isDev,
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron ?? "",
      node: process.versions.node,
      chrome: process.versions.chrome ?? "",
    },
    dataDir: config.dataDir,
    logsDir: config.logsDir,
    llmConfigured: (config.childEnv["DESKPET_LLM_BASE_URL"] ?? "") !== "",
    asrModelDir: config.childEnv["DESKPET_ASR_MODEL_DIR"] ?? "",
    sidecarPort: health?.sidecar_port ?? config.preferredPort,
    engineState:
      health === null
        ? "未知（引擎未启动）"
        : health.state + (health.last_error === null ? "" : "：" + health.last_error),
    crashes: {
      mainCrashCount: crashState.mainCrashCount,
      rendererRestarts: crashState.rendererRestarts,
    },
    recentLogLines: tailLines(rawLog),
  });
  await clipboard.writeText(report);
  notifyUser("诊断信息已复制", "直接粘贴给对方即可；密钥已自动隐去。");
  mainLogger.info("app.diagnostics_copied", "诊断信息已复制到剪贴板", { chars: report.length });
}

/**
 * 把一次窗口晃动记到 sidecar（T2.3-C1）。
 *
 * 统计是增强项：记不上只留一条日志，既不弹提示也不打断拖动（§6.7 的降级口径）。
 */
async function reportWindowShake(
  client: SidecarClient,
  mainLogger: MainLogger,
  charId: string,
): Promise<void> {
  try {
    await client.recordUsage({ fact: "window_shake", char_id: charId });
  } catch (error) {
    mainLogger.warn("ui.window_shake_failed", "窗口晃动没能记账（不影响界面）", {
      error: toErrorMessage(error),
    });
  }
}

/** 退出前收尾：注销 IPC、停心跳、结束 sidecar 进程树（不留孤儿占端口）。 */
function shutdown(): void {
  quitting = true;
  cursorTracker?.dispose();
  cursorTracker = null;
  unregisterIpc?.();
  unregisterIpc = null;
  unregisterRuntimeSync?.();
  unregisterRuntimeSync = null;
  stopCompanionSync?.();
  stopCompanionSync = null;
  voiceSocket?.close();
  voiceSocket = null;
  void nativeMic?.stop();
  nativeMic = null;
  logger?.info("app.quit", "deskpet 主进程退出");
  logger?.close();
  tray?.destroy();
  tray = null;
}

async function bootstrap(): Promise<void> {
  const config = await resolveConfig();
  registerCharacterAssetProtocol(config.charactersDir);
  const mainLogger = createMainLogger(config.mainLogFile);
  await ensureDefaultCharacters(config.charactersDir, config.defaultCharactersDir, mainLogger);
  logger = mainLogger;
  flushEarlySettingsLogs(mainLogger);
  mainLogger.info("app.start", "deskpet 主进程启动", {
    version: app.getVersion(),
    isDev: config.isDev,
    dataDir: config.dataDir,
    // 只记路径与「LLM 端点是否配好」，绝不记 key 本身（§7.1 敏感信息禁入日志）
    settingsFile: settings?.path ?? "",
    legacyEnvFile: config.envFile,
    llmConfigured: (config.childEnv["DESKPET_LLM_BASE_URL"] ?? "") !== "",
    asrModelDir: config.childEnv["DESKPET_ASR_MODEL_DIR"] ?? "",
  });

  configureMediaPermissions(session.defaultSession, mainLogger);
  mainLogger.info("media.status", "麦克风系统权限状态", {
    microphone: microphoneAccessStatus(),
  });

  // 每次拉起 sidecar 都重新解析配置：设置窗改完 data/settings.json（密钥 / 模型 / 端口）后，
  // 「重启后台引擎」必须真的读到新值，而不是沿用启动时那份快照（T2.41 真机 401）。
  const sidecar = new SidecarProcess({
    config,
    logger: mainLogger,
    readEnv: async () => (await resolveConfig()).childEnv,
  });
  const monitor = new HeartbeatMonitor({
    maxFailures: config.maxHealthFailures,
    maxRestarts: config.maxAutoRestarts,
  });
  const health = new HealthClient({
    host: config.host,
    port: config.preferredPort,
    token: "",
    timeoutMs: config.healthTimeoutMs,
  });
  const sidecarEngine = new SidecarEngine({
    config,
    logger: mainLogger,
    sidecar,
    health,
    monitor,
  });
  engine = sidecarEngine;

  // 会话编排（T1.6b）：HTTP 客户端 + 角色包音色 + 事件/音频推送，全部注入便于单测
  const push = rendererPusher(() => mainWindow);
  const nativeMicCapture = new NativeMicCapture({
    config,
    logger: mainLogger,
    onAudio: (pcm) => push(IPC_CHANNELS.voiceNativeAudio, pcm),
    onError: (message) => push(IPC_CHANNELS.voiceNativeError, message),
  });
  nativeMic = nativeMicCapture;
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  };
  const sidecarClient = new SidecarClient(mainLogger);
  const modelManager = new ModelManager({
    dataDir: config.dataDir,
    bundledRoot: config.bundledRoot,
    catalogFile: modelCatalogPath(),
    logger: mainLogger,
    emit: (progress) => broadcast(IPC_CHANNELS.modelsProgress, progress),
  });
  // 语音全双工（P2）：一条 WS 同时承载音频上行、文字帧与事件/音频下行。
  //
  // 三个回调先走可替换的转发函数：TurnCoordinator 与 ChatTurns 要等 voiceClient 建好才能建，
  // 而它们又必须收到 WS 事件。闭包解掉这个构造顺序环，不需要非空断言。
  let onVoiceStreamEvent: (event: VoiceStreamEvent) => void = () => {};
  let onVoiceStateFrame: (state: string) => void = () => {};
  let onVoiceClosed: () => void = () => {};
  const voiceClient = new VoiceSocketClient(mainLogger, {
    onEvent: (event) => {
      onVoiceStreamEvent(event);
    },
    onState: (state) => {
      onVoiceStateFrame(state);
    },
    onAudio: (meta, audio) =>
      push(IPC_CHANNELS.ttsAudio, {
        session_id: "",
        request_id: meta.request_id,
        text: meta.text,
        format: meta.format,
        audio,
        gen_ms: meta.gen_ms,
        audio_ms: meta.audio_ms,
        rtf: meta.rtf,
      }),
    onClosed: () => {
      onVoiceClosed();
    },
  });
  voiceSocket = voiceClient;
  // 语音 / 文字 / 触摸的单一话筒（T2.6）：状态只由 sidecar 报，这里只记「当前这一轮」
  const turnCoordinator = new TurnCoordinator({
    cancel: () => {
      voiceClient.cancel();
    },
    emit: (payload) => push(IPC_CHANNELS.voiceState, payload),
  });
  // 文字轮（D1 第二期）：同一连接发文字帧，sidecar 的事件翻成界面一直用的 chatEvent
  const chatTurns = new ChatTurns({
    socket: {
      isOpen: () => voiceClient.isOpen(),
      sendText: (frame) => voiceClient.sendText(frame),
    },
    turn: turnCoordinator,
    logger: mainLogger,
    emitChatEvent: (envelope) => push(IPC_CHANNELS.chatEvent, envelope),
  });
  onVoiceStreamEvent = (event) => {
    // 文字轮认领 llm.* / error；语音轮（含 ASR）照旧走 voiceEvent
    if (!chatTurns.handleEvent(event)) {
      push(IPC_CHANNELS.voiceEvent, event);
    }
  };
  onVoiceStateFrame = (state) => {
    turnCoordinator.onState(state);
  };
  onVoiceClosed = () => {
    chatTurns.onSocketClosed();
    turnCoordinator.onSocketClosed();
  };
  // 取消（用户按打断 / 换轮 / 热键）发生时，文字轮不再认领后续事件
  turnCoordinator.onCancel(() => {
    chatTurns.abandon();
  });
  // 窗口晃动检测（T2.3-C1）：主进程自己判、自己报，渲染层不参与
  const shakeDetector = new ShakeDetector();

  const activity = new ActivityLog();
  // 屏幕观察与「观察结果进记忆」的节流都在这里，bootstrap 只提供依赖与开关回调
  const companionSync = createCompanionSync({
    activity,
    client: sidecarClient,
    readState: () => ui?.getState(),
    presence: () => presenceReporter,
    logger: mainLogger,
    capture: capturePrimaryScreen,
    now: Date.now,
  });
  const syncCompanion = (state: UiStatePayload): void => {
    companionSync.sync(state);
  };
  stopCompanionSync = () => {
    companionSync.stop();
  };

  const settingsWindows = new SettingsWindowController({
    preloadPath: preloadPath(),
    settingsHtmlPath: settingsHtmlPath(),
    logger: mainLogger,
  });
  // 角色包编辑器（T2.3-D）：独立窗口，设置窗的「新建角色包」按钮打开它
  const companionWindows = new CompanionWindowController({
    preloadPath: preloadPath(),
    companionHtmlPath: companionHtmlPath(),
    logger: mainLogger,
  });
  const editorWindows = new EditorWindowController({
    preloadPath: preloadPath(),
    editorHtmlPath: editorHtmlPath(),
    logger: mainLogger,
  });

  // 主窗句柄先留空：控制器建好之后再拿到窗口（窗口被关闭重建时也能接上）
  let petHandle: PetWindowHandle | null = null;
  const uiController = new UiController({
    stateFile: join(config.dataDir, UI_STATE_FILENAME),
    window: () => petHandle,
    broadcast: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.uiStateChanged, state);
        }
      }
    },
    openSettings: (pane) => {
      settingsWindows.open(pane);
    },
    listCharacters: () => listCharacters(config.charactersDir),
    workArea: currentWorkArea,
    cursor: () => screen.getCursorScreenPoint(),
    logger: mainLogger,
    onStateChanged: syncCompanion,
  });
  ui = uiController;
  // 分辨率 / DPI / 显示器变化后重新按工作区限制窗口；窗口位置也会被收回工作区。
  const onDisplayMetricsChanged = (): void => {
    uiController.applyToWindow();
  };
  screen.on("display-metrics-changed", onDisplayMetricsChanged);
  screen.on("display-added", onDisplayMetricsChanged);
  screen.on("display-removed", onDisplayMetricsChanged);
  const uiState = await uiController.load();
  syncCompanion(uiState);
  // 语音输出开关存在 ui.json 里：启动时先同步给文字轮（语音轮在 begin 帧里带）
  chatTurns.setTtsEnabled(uiState.tts_enabled);

  // 检查更新：只在用户点按钮时联网；当前版本取应用自身（构建期注入 package.json 的 version）
  const updateChecker = new UpdateChecker({
    currentVersion: app.getVersion(),
    logger: mainLogger,
  });

  unregisterIpc = registerIpcHandlers({
    engine: sidecarEngine,
    chatTurns,
    turn: turnCoordinator,
    ui: uiController,
    logger: mainLogger,
    client: sidecarClient,
    activity,
    models: modelManager,
    voiceSocket: voiceClient,
    nativeMic: nativeMicCapture,
    // 角色包素材（立绘 / hits.json）由主进程读，渲染层只拿 data URL 与归一化框（T2.3-C2）
    charactersDir: config.charactersDir,
    // 设置窗读写的就是启动时装载的这一个设置仓库：界面与引擎不会各看一套（D4）
    settings: requireSettings(),
    // 备份在 data/backups 里，界面提供一个「打开数据目录」的入口
    dataDir: config.dataDir,
    // 开发者模式开关单独存一份（T2.3-B1）：跟 ui.json 同目录，不进 .env 也不进角色包
    devFile: join(config.dataDir, DEV_MODE_FILENAME),
    openCompanion: () => {
      companionWindows.open();
    },
    openPackEditor: (request) => {
      editorWindows.open(request);
    },
    getWindow: () => mainWindow,
    // 追踪器在窗口建好后才有；渲染层发开关时闭包已经能拿到实例（T2.27）
    setCursorTracking: (enabled) => {
      cursorTracker?.setEnabled(enabled);
    },
    updates: updateChecker,
  });

  // 端点跟随心跳：online 时把当次 runtime（端口 + token）交给客户端，离线立刻断开，
  // 这样调用方拿到的是「引擎不可用」而不是对着旧端口干等（§6.7 A 级降级）
  let lastEngineState: HealthView["state"] | null = null;
  unregisterRuntimeSync = sidecarEngine.onHealthChanged((view) => {
    // 失败不可自愈，但窗口缩在托盘时用户看不见横幅：这时才用气泡兜一次（同状态只提醒一次）
    if (
      view.state === "failed" &&
      lastEngineState !== "failed" &&
      (mainWindow === null || mainWindow.isDestroyed() || !mainWindow.isVisible())
    ) {
      notifyUser(
        "后台引擎启动失败",
        view.last_error === null
          ? "已停止自动重启。托盘菜单「复制诊断信息」可把原因发给开发者。"
          : view.last_error.slice(0, 200),
      );
    }
    lastEngineState = view.state;
    const runtime = sidecarEngine.getRuntime();
    if (view.state === "online" && runtime !== null) {
      sidecarClient.setEndpoint(runtime);
      voiceClient.setEndpoint(runtime);
      return;
    }
    if (view.state !== "online") {
      sidecarClient.clearEndpoint();
      voiceClient.clearEndpoint();
    }
  });

  const pet = createPetWindow({
    state: uiState,
    preloadPath: preloadPath(),
    indexHtmlPath: rendererIndexPath(),
    logger: mainLogger,
    onMoved: (x, y) => uiController.noteMoved(x, y),
    onMoving: (x, y) => {
      if (!shakeDetector.push(x, y, Date.now())) {
        return;
      }
      const charId = uiController.getState().char_id ?? "";
      mainLogger.debug("ui.window_shake", "检测到窗口晃动", { char_id: charId });
      void reportWindowShake(sidecarClient, mainLogger, charId);
    },
  });
  petHandle = pet.handle;
  mainWindow = pet.window;
  // preload 抛错的表现是白屏，重载也救不回来：只提示 + 记日志，让用户去看 data/logs
  pet.window.webContents.on("preload-error", (_event, preloadFile, error) => {
    reportCrash(crashGuard.recordPreloadError(preloadFile, error));
  });
  cursorTracker = new CursorTracker({
    cursor: () => screen.getCursorScreenPoint(),
    contentBounds: () => (pet.window.isDestroyed() ? null : pet.window.getContentBounds()),
    canTrack: () =>
      !pet.window.isDestroyed() && pet.window.isVisible() && !pet.window.isMinimized(),
    send: (message) => {
      if (!pet.window.isDestroyed()) {
        pet.window.webContents.send(IPC_CHANNELS.uiCursor, message);
      }
    },
  });
  // 上一回的位置与缩放已经写进窗口构造参数，这里只补置顶与穿透这类运行时开关
  uiController.applyToWindow();

  // 关窗口不等于退出程序：桌宠要常驻托盘（需求 F5 主动问候依赖常驻）
  pet.window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      pet.window.hide();
    }
  });
  pet.window.on("closed", () => {
    // 窗口没了还留着拖动定时器的话，它会对着空句柄空转（T2.2 用户反馈第五轮）
    uiController.endDrag();
    cursorTracker?.dispose();
    cursorTracker = null;
    mainWindow = null;
    // 窗口正常销毁说明这一轮已经结束，下次崩溃重新计预算
    crashGuard.resetRendererBudget();
  });

  packWatcher = new CharacterPackWatcher({
    charactersDir: config.charactersDir,
    logger: mainLogger,
    onChanged: (charId) => {
      void loadCharacterPack(config.charactersDir, charId)
        .then((loaded) => {
          if (!loaded.ok) {
            mainLogger.warn("pack.reload_failed", "角色包变更校验失败，保留旧界面", {
              char_id: charId,
              error: loaded.error,
            });
            return;
          }
          const message: CharactersChangedMessage = { char_id: charId };
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
              window.webContents.send(IPC_CHANNELS.charactersChanged, message);
            }
          }
        })
        .catch((error: unknown) => {
          mainLogger.warn("pack.reload_failed", "角色包变更读取失败：" + String(error));
        });
    },
  });
  packWatcher.start();

  micBusyMonitor = new MicBusyMonitor({ logger: mainLogger });
  micBusyMonitor.start();
  dndMonitor = new NotificationStateMonitor({ logger: mainLogger });
  dndMonitor.start();

  const presenceSessionId = randomUUID();
  presenceReporter = new PresenceReporter({
    snapshot: () => {
      const state = uiController.getState();
      const window = mainWindow;
      const charId = state.char_id ?? "";
      if (window === null || charId === "") {
        return null;
      }
      return {
        char_id: charId,
        session_id: chatTurns.session || presenceSessionId,
        window_visible: window.isVisible(),
        window_minimized: window.isMinimized(),
        window_focused: window.isFocused(),
        idle_seconds: powerMonitor.getSystemIdleTime(),
        input_mode: turnCoordinator.getMode(),
        turn_active: turnCoordinator.getPhase() !== "idle",
        quiet_hours: inQuietHours(state.companion) || (dndMonitor?.current ?? false),
        screen_changed: false,
        screen_text: "",
        mic_busy: micBusyMonitor?.current ?? false,
      };
    },
    decide: (request) => sidecarClient.presence(request),
    onProactive: async (request, decision) => {
      const window = mainWindow;
      if (
        window === null ||
        !window.isVisible() ||
        window.isMinimized() ||
        turnCoordinator.getPhase() !== "idle"
      ) {
        return;
      }
      await chatTurns.send({
        session_id: request.session_id || chatTurns.session || presenceSessionId,
        char_id: request.char_id,
        text: "",
        proactive: true,
        proactive_kind: decision.kind,
        screen_text: request.screen_text,
        app_context: activity.recent(),
      });
    },
    logger: mainLogger,
  });
  presenceReporter.start();

  const manualScreenshot = async (): Promise<void> => {
    const state = uiController.getState();
    const charId = state.char_id ?? "";
    if (charId === "") {
      mainLogger.debug("screen.hotkey_no_character", "截屏热键：还没有可用角色");
      return;
    }
    showWindow();
    if (turnCoordinator.isBusy()) {
      await turnCoordinator.cancelAll();
    }
    let observation: ScreenObservation | null = null;
    try {
      const frame = await capturePrimaryScreen();
      if (frame !== null) {
        observation = await companionSync.observe(frame);
      }
    } catch (error: unknown) {
      mainLogger.warn("screen.hotkey_failed", "截屏热键失败：" + toErrorMessage(error));
      return;
    }
    const screenText = observation?.summary.trim() ?? "";
    try {
      await chatTurns.send({
        session_id: chatTurns.session || presenceSessionId,
        char_id: charId,
        text:
          screenText === ""
            ? "（用户刚按了截屏热键，但屏幕上没有可读内容。你可以问他想让你看哪里。）"
            : "（用户刚按了截屏热键，想让你看看屏幕。）",
        screen_text: screenText,
        app_context: activity.recent(),
      });
    } catch (error: unknown) {
      mainLogger.debug("screen.hotkey_send_failed", "截屏热键发起对话失败：" + String(error));
    }
  };
  if (!globalShortcut.register("Control+Alt+S", () => void manualScreenshot())) {
    mainLogger.warn("screen.hotkey_register_failed", "截屏热键 Control+Alt+S 注册失败");
  }

  tray = createTray(
    { dataDir: config.dataDir, logsDir: config.logsDir },
    {
      showWindow,
      minimizeWindow: () => ui?.minimize(),
      resetPosition: () => ui?.resetPosition(),
      openSettings: () => openSettings(),
      openPath: (dir) => void openPathInExplorer(dir),
      copyDiagnostics: () => void copyDiagnostics(config, mainLogger),
      exportData: () => void exportDataAndReveal(sidecarClient, mainLogger, { notify: notifyUser }),
      restartEngine: () => void engine?.restartSidecar("托盘菜单"),
      // 「正在退出」先置上，否则关窗会被拦成隐藏，进程退不掉
      quit: () => {
        quitting = true;
        app.quit();
      },
    },
    mainLogger,
  );
  await sidecarEngine.start();
}

// 单实例锁：第二次启动不再开一个 sidecar 抢端口，只把已有窗口唤到前台
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      logger?.error("app.bootstrap_failed", "启动流程失败：" + toErrorMessage(error));
      quitting = true;
      app.quit();
    });

  // 冒烟测试钩子：设了 DESKPET_SMOKE_QUIT_MS 就到点走与托盘「退出」完全相同的路径，
  // 这样打包冒烟与 CI 能在无人值守下验证「退出后不留孤儿 sidecar / runtime.json」（T0.7 / T0.12）。
  const smokeQuitMs = Number.parseInt(process.env["DESKPET_SMOKE_QUIT_MS"] ?? "", 10);
  if (Number.isFinite(smokeQuitMs) && smokeQuitMs > 0) {
    setTimeout(() => {
      // 日志写在回调里：这段代码在 bootstrap 之前就跑到了，那时 logger 还没建好
      logger?.info("app.smoke_quit", "冒烟测试到点，走正常退出流程", { afterMs: smokeQuitMs });
      quitting = true;
      app.quit();
    }, smokeQuitMs);
  }

  app.on("activate", showWindow);
  // 渲染进程崩溃：窗口会僵在最后一帧，默认没有任何提示。按预算自动重载，超出预算就停下来告诉用户怎么办。
  app.on("render-process-gone", (_event, contents, details) => {
    const result = crashGuard.recordRendererGone(details);
    reportCrash(result.notice);
    if (result.action !== "reload" || quitting) {
      return;
    }
    try {
      contents.reload();
    } catch (error: unknown) {
      reportCrash(crashGuard.recordPreloadError("renderer", error));
    }
  });
  // 子进程（GPU / Utility / 插件）退出：只记账。GPU 崩溃 Electron 会自恢复，不打扰用户。
  app.on("child-process-gone", (_event, details) => {
    const notice = crashGuard.recordChildGone(details.type, details.reason);
    logger?.error(notice.event, notice.message, { detail: notice.detail });
    if (!isHarmlessChildProcess(details.type) && crashGuard.shouldNotify(notice.event)) {
      notifyUser("deskpet 遇到问题", notice.message);
    }
  });
  // 托盘常驻：窗口全关也不退出，行为在三个平台上一致
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", (event) => {
    presenceReporter?.stop();
    presenceReporter = null;
    packWatcher?.stop();
    packWatcher = null;
    micBusyMonitor?.stop();
    micBusyMonitor = null;
    dndMonitor?.stop();
    dndMonitor = null;
    globalShortcut.unregister("Control+Alt+S");
    const pending = engine;
    if (pending === null) {
      shutdown();
      return;
    }
    // 需要一个异步窗口把 sidecar 收干净，否则进程先退出会留下孤儿 sidecar 占端口
    event.preventDefault();
    engine = null;
    const uiPending = ui;
    ui = null;
    // 先把界面状态写盘（拖动是防抖写），再收 sidecar，最后才真的退出
    void (async (): Promise<void> => {
      await uiPending?.flush();
      await pending.stop();
    })().finally(() => {
      shutdown();
      app.exit(0);
    });
  });
}
