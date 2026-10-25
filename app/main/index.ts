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
  globalShortcut,
  Menu,
  powerMonitor,
  screen,
  session,
  Tray,
  nativeImage,
} from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { ActivityLog } from "./activity-log";
import { listCharacters } from "./character-list";
import { CharacterVoiceLoader } from "./character-voice";
import { ChatOrchestrator } from "./chat-orchestrator";
import { loadMainConfig, type MainConfig } from "./config";
import { SidecarEngine } from "./engine";
import { mergeEnv, readEnvFile, resolveEnvFilePath } from "./env-file";
import { toErrorMessage } from "./errors";
import { HealthClient } from "./health-client";
import { HeartbeatMonitor } from "./heartbeat";
import {
  IPC_CHANNELS,
  type CharactersChangedMessage,
  type CompanionSettings,
  type UiStatePayload,
} from "./ipc";
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
import { SidecarClient } from "./sidecar-client";
import { capturePrimaryScreen } from "./screen-capture";
import { ScreenWatcher, type CapturedFrame, type ScreenObservation } from "./screen-watcher";
import { ShakeDetector } from "./shake-detector";
import { SidecarProcess } from "./sidecar-process";
import { UiController, type PetWindowHandle } from "./ui-controller";
import { VoiceSocketClient } from "./voice-socket";
import { TurnCoordinator } from "./turn-coordinator";
import { DEV_MODE_FILENAME } from "./dev-mode";
import { UI_STATE_FILENAME } from "./ui-state";
import {
  CompanionWindowController,
  createPetWindow,
  EditorWindowController,
  SettingsWindowController,
} from "./windows";

let mainWindow: BrowserWindow | null = null;
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
/** 关闭按钮默认只是隐藏到托盘；只有真正退出（托盘菜单/系统退出）才放行。 */
let quitting = false;

/**
 * 打包后代码在 dist、资源在 resources 下；开发模式两者都在仓库根。
 * .env 只在这里读一次：解析出的值做底、真实环境变量覆盖它（T1.3，见 app/main/env-file.ts）。
 */
async function resolveConfig(): Promise<MainConfig> {
  const isDev = !app.isPackaged;
  const appRoot = app.getAppPath();
  const userDataDir = app.getPath("userData");
  const envFile = resolveEnvFilePath({ isDev, appRoot, userDataDir, env: process.env });
  const fileEnv = await readEnvFile(envFile);
  return loadMainConfig({
    isDev,
    appRoot,
    resourcesRoot: process.resourcesPath,
    userDataDir,
    env: mergeEnv(fileEnv, process.env),
    envFile,
  });
}

function rendererIndexPath(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

function settingsHtmlPath(): string {
  return join(__dirname, "..", "renderer", "settings.html");
}

function companionHtmlPath(): string {
  return join(__dirname, "..", "renderer", "companion.html");
}

function editorHtmlPath(): string {
  return join(__dirname, "..", "renderer", "editor.html");
}

function modelCatalogPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "config", "model-catalog.json")
    : join(app.getAppPath(), "config", "model-catalog.json");
}

function preloadPath(): string {
  return join(__dirname, "..", "preload", "index.js");
}

function trayIconPath(): string {
  return join(__dirname, "..", "renderer", "assets", "placeholder.png");
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

function inQuietHours(companion: CompanionSettings): boolean {
  const start = companion.quiet_hours_start;
  const end = companion.quiet_hours_end;
  if (start < 0 || end < 0) {
    return false;
  }
  const hour = new Date().getHours();
  if (start === end) {
    return true;
  }
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function showWindow(): void {
  if (mainWindow === null) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function openSettings(): void {
  // 设置窗由 bootstrap 装配的控制器持有单实例；这里只负责把请求转过去
  ui?.openSettings();
}

function createTray(): Tray {
  const image = nativeImage.createFromPath(trayIconPath());
  if (image.isEmpty()) {
    logger?.warn("tray.icon_missing", "托盘图标加载失败：" + trayIconPath());
  }
  // 通知区图标显式缩到 16×16：素材是 128×128 的占位图，交给系统缩会糊（T2.2）
  const instance = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }));
  instance.setToolTip("deskpet（右键：显示 / 位置重置 / 设置 / 退出）");
  instance.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主界面", click: showWindow },
      { label: "最小化窗口", click: () => ui?.minimize() },
      {
        label: "位置重置到屏幕中央",
        click: () => {
          ui?.resetPosition();
          showWindow();
        },
      },
      { label: "打开设置", click: openSettings },
      { label: "重启后台引擎", click: () => void engine?.restartSidecar("托盘菜单") },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  instance.on("click", showWindow);
  return instance;
}

/** 退出前收尾：注销 IPC、停心跳、结束 sidecar 进程树（不留孤儿占端口）。 */
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

function shutdown(): void {
  quitting = true;
  unregisterIpc?.();
  unregisterIpc = null;
  unregisterRuntimeSync?.();
  unregisterRuntimeSync = null;
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
  const mainLogger = createMainLogger(config.mainLogFile);
  logger = mainLogger;
  mainLogger.info("app.start", "deskpet 主进程启动", {
    version: app.getVersion(),
    isDev: config.isDev,
    dataDir: config.dataDir,
    // 只记路径与「LLM 端点是否配好」，绝不记 key 本身（§7.1 敏感信息禁入日志）
    envFile: config.envFile,
    llmConfigured: (config.childEnv["DESKPET_LLM_BASE_URL"] ?? "") !== "",
    asrModelDir: config.childEnv["DESKPET_ASR_MODEL_DIR"] ?? "",
  });

  configureMediaPermissions(session.defaultSession, mainLogger);
  mainLogger.info("media.status", "麦克风系统权限状态", {
    microphone: microphoneAccessStatus(),
  });

  const sidecar = new SidecarProcess({ config, logger: mainLogger });
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
    catalogFile: modelCatalogPath(),
    logger: mainLogger,
    emit: (progress) => broadcast(IPC_CHANNELS.modelsProgress, progress),
  });
  // 语音 / 文字 / 触摸的单一话筒（T2.6）：HTTP 与 WS 的状态先汇入它，再推给渲染层
  const turnCoordinator = new TurnCoordinator({
    cancelHttp: async () => {
      await orchestrator.cancel({ session_id: orchestrator.session });
    },
    cancelVoice: () => {
      voiceClient.cancel();
    },
    emit: (payload) => push(IPC_CHANNELS.voiceState, payload),
  });
  // 语音全双工（P2）：一条 WS 同时承载音频上行与事件/音频下行
  const voiceClient = new VoiceSocketClient(mainLogger, {
    onEvent: (event) => push(IPC_CHANNELS.voiceEvent, event),
    onState: (state) => turnCoordinator.onWsState(state),
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
  });
  voiceSocket = voiceClient;
  // 窗口晃动检测（T2.3-C1）：主进程自己判、自己报，渲染层不参与
  const shakeDetector = new ShakeDetector();
  const orchestrator = new ChatOrchestrator({
    client: sidecarClient,
    voice: new CharacterVoiceLoader(config.charactersDir, mainLogger),
    logger: mainLogger,
    emitChatEvent: (envelope) => push(IPC_CHANNELS.chatEvent, envelope),
    emitVoiceState: (payload) => turnCoordinator.onHttpState(payload),
    emitAudio: (message) => push(IPC_CHANNELS.ttsAudio, message),
  });

  const activity = new ActivityLog();
  let screenWatcher: ScreenWatcher | null = null;
  let lastCompanion: CompanionSettings | null = null;
  let lastMemoryAt = 0;
  let lastMemorySummary = "";
  let ocrUnavailableUntil = 0;

  const observeScreenFrame = async (frame: CapturedFrame): Promise<ScreenObservation> => {
    const companion = ui?.getState().companion;
    if (companion?.ocr_enabled && Date.now() >= ocrUnavailableUntil) {
      try {
        const ocr = await sidecarClient.ocrScreen(frame.jpeg, frame.appTitle);
        return {
          summary: ocr.text,
          interesting: ocr.text.trim() !== "",
          confidence: ocr.confidence,
          visionModel: ocr.engine,
          capturedAt: new Date().toISOString(),
        };
      } catch (error: unknown) {
        ocrUnavailableUntil = Date.now() + 5 * 60_000;
        mainLogger.warn("screen.ocr_failed", "本地 OCR 不可用，先退回视觉摘要", {
          error: toErrorMessage(error),
        });
      }
    }
    return await sidecarClient.captureScreen(
      frame.jpeg,
      frame.appTitle,
      new Date().toISOString(),
      ui?.getState().companion.vision_model ?? "",
    );
  };

  const syncCompanion = (state: UiStatePayload): void => {
    const companion = state.companion;
    const previous = lastCompanion;
    if (previous === null || previous.enabled !== companion.enabled) {
      if (previous !== null) {
        activity.clear();
        activity.record(
          companion.enabled ? "用户重新开启了主动陪伴。" : "用户关闭了主动陪伴，希望暂时不被打扰。",
        );
      }
    } else if (!companion.enabled) {
      const labels: readonly (readonly [keyof CompanionSettings, string])[] = [
        ["screen_enabled", "屏幕观察"],
        ["proactive_enabled", "主动开口"],
        ["observe_memory", "观察记忆"],
        ["app_activity_enabled", "应用动态"],
      ];
      for (const [key, label] of labels) {
        if (previous[key] !== companion[key]) {
          activity.record(
            "用户" + (companion[key] === true ? "重新允许了" : "关闭了") + label + "。",
          );
        }
      }
    }
    lastCompanion = companion;
    const shouldWatch = companion.screen_enabled && companion.vision_consented;
    if (!shouldWatch) {
      screenWatcher?.stop();
      return;
    }
    if (screenWatcher === null) {
      screenWatcher = new ScreenWatcher({
        capture: capturePrimaryScreen,
        observe: observeScreenFrame,
        enabled: () => {
          const current = ui?.getState().companion;
          return current !== undefined && current.screen_enabled && current.vision_consented;
        },
        intervalMs: () => (ui?.getState().companion.screen_interval_s ?? 5) * 1000,
        onObservation: (observation) => {
          const current = ui?.getState();
          if (current === undefined || !current.companion.screen_enabled) {
            return;
          }
          const charId = current.char_id ?? "";
          if (
            current.companion.observe_memory &&
            charId !== "" &&
            observation.summary !== lastMemorySummary &&
            Date.now() - lastMemoryAt > 60_000
          ) {
            lastMemoryAt = Date.now();
            lastMemorySummary = observation.summary;
            void sidecarClient
              .writeScreenMemory(charId, observation.summary)
              .catch((error: unknown) => {
                mainLogger.debug(
                  "screen.memory_failed",
                  "屏幕观察没能写入记忆：" + toErrorMessage(error),
                );
              });
          }
          if (observation.summary.trim() !== "") {
            presenceReporter?.setScreenObservation(observation.summary);
            void presenceReporter?.report();
          }
        },
        onError: (error) => {
          mainLogger.warn(
            "screen.observe_failed",
            "屏幕识图失败，下一轮继续尝试：" + toErrorMessage(error),
          );
        },
        logger: mainLogger,
      });
    }
    screenWatcher.start();
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
    openSettings: () => {
      settingsWindows.open();
    },
    listCharacters: () => listCharacters(config.charactersDir),
    workArea: currentWorkArea,
    cursor: () => screen.getCursorScreenPoint(),
    logger: mainLogger,
    onStateChanged: syncCompanion,
  });
  ui = uiController;
  const uiState = await uiController.load();
  syncCompanion(uiState);
  // 语音输出开关存在 ui.json 里：启动时先同步给合成链
  orchestrator.setTtsEnabled(uiState.tts_enabled);

  unregisterIpc = registerIpcHandlers({
    engine: sidecarEngine,
    orchestrator,
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
    // 「模型供给」（T1.14b）读写的就是启动时读的这份 .env：设置窗与引擎不会各看一套
    envFilePath: config.envFile,
    // 开发者模式开关单独存一份（T2.3-B1）：跟 ui.json 同目录，不进 .env 也不进角色包
    devFile: join(config.dataDir, DEV_MODE_FILENAME),
    openCompanion: () => {
      companionWindows.open();
    },
    openPackEditor: (request) => {
      editorWindows.open(request);
    },
    getWindow: () => mainWindow,
  });

  // 端点跟随心跳：online 时把当次 runtime（端口 + token）交给客户端，离线立刻断开，
  // 这样调用方拿到的是「引擎不可用」而不是对着旧端口干等（§6.7 A 级降级）
  unregisterRuntimeSync = sidecarEngine.onHealthChanged((view) => {
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
    mainWindow = null;
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
        session_id: orchestrator.session || presenceSessionId,
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
      await orchestrator.send({
        session_id: request.session_id || orchestrator.session || presenceSessionId,
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
      turnCoordinator.finishCancel();
    }
    let observation: ScreenObservation | null = null;
    try {
      const frame = await capturePrimaryScreen();
      if (frame !== null) {
        observation = await observeScreenFrame(frame);
      }
    } catch (error: unknown) {
      mainLogger.warn("screen.hotkey_failed", "截屏热键失败：" + toErrorMessage(error));
      return;
    }
    const screenText = observation?.summary.trim() ?? "";
    try {
      await orchestrator.send({
        session_id: orchestrator.session || presenceSessionId,
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

  tray = createTray();
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
