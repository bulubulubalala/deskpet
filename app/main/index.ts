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
import { app, BrowserWindow, Menu, screen, Tray, nativeImage } from "electron";
import { join } from "node:path";

import { listCharacters } from "./character-list";
import { CharacterVoiceLoader } from "./character-voice";
import { ChatOrchestrator } from "./chat-orchestrator";
import { loadMainConfig, type MainConfig } from "./config";
import { SidecarEngine } from "./engine";
import { mergeEnv, readEnvFile, resolveEnvFilePath } from "./env-file";
import { toErrorMessage } from "./errors";
import { HealthClient } from "./health-client";
import { HeartbeatMonitor } from "./heartbeat";
import { IPC_CHANNELS } from "./ipc";
import { registerIpcHandlers, rendererPusher } from "./ipc-handlers";
import { createMainLogger, type MainLogger } from "./logger";
import { SidecarClient } from "./sidecar-client";
import { ShakeDetector } from "./shake-detector";
import { SidecarProcess } from "./sidecar-process";
import { UiController, type PetWindowHandle } from "./ui-controller";
import { UI_STATE_FILENAME } from "./ui-state";
import { createPetWindow, SettingsWindowController } from "./windows";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: SidecarEngine | null = null;
let logger: MainLogger | null = null;
let ui: UiController | null = null;
let unregisterIpc: (() => void) | null = null;
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
  const sidecarClient = new SidecarClient(mainLogger);
  // 窗口晃动检测（T2.3-C1）：主进程自己判、自己报，渲染层不参与
  const shakeDetector = new ShakeDetector();
  const orchestrator = new ChatOrchestrator({
    client: sidecarClient,
    voice: new CharacterVoiceLoader(config.charactersDir, mainLogger),
    logger: mainLogger,
    emitChatEvent: (envelope) => push(IPC_CHANNELS.chatEvent, envelope),
    emitVoiceState: (payload) => push(IPC_CHANNELS.voiceState, payload),
    emitAudio: (message) => push(IPC_CHANNELS.ttsAudio, message),
  });

  const settingsWindows = new SettingsWindowController({
    preloadPath: preloadPath(),
    settingsHtmlPath: settingsHtmlPath(),
    logger: mainLogger,
  });

  // 主窗句柄先留空：控制器建好之后再拿到窗口（窗口被关闭重建时也能接上）
  let petHandle: PetWindowHandle | null = null;
  const uiController = new UiController({
    stateFile: join(config.dataDir, UI_STATE_FILENAME),
    window: () => petHandle,
    broadcast: (state) => push(IPC_CHANNELS.uiStateChanged, state),
    openSettings: () => {
      settingsWindows.open();
    },
    listCharacters: () => listCharacters(config.charactersDir),
    workArea: currentWorkArea,
    cursor: () => screen.getCursorScreenPoint(),
    logger: mainLogger,
  });
  ui = uiController;
  const uiState = await uiController.load();

  unregisterIpc = registerIpcHandlers({
    engine: sidecarEngine,
    orchestrator,
    ui: uiController,
    logger: mainLogger,
    client: sidecarClient,
    // 「模型供给」（T1.14b）读写的就是启动时读的这份 .env：设置窗与引擎不会各看一套
    envFilePath: config.envFile,
    getWindow: () => mainWindow,
  });

  // 端点跟随心跳：online 时把当次 runtime（端口 + token）交给客户端，离线立刻断开，
  // 这样调用方拿到的是「引擎不可用」而不是对着旧端口干等（§6.7 A 级降级）
  unregisterRuntimeSync = sidecarEngine.onHealthChanged((view) => {
    const runtime = sidecarEngine.getRuntime();
    if (view.state === "online" && runtime !== null) {
      sidecarClient.setEndpoint(runtime);
      return;
    }
    if (view.state !== "online") {
      sidecarClient.clearEndpoint();
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
