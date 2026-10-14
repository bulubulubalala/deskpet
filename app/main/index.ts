/**
 * 文件职责：Electron 主进程组合根——装配配置、日志、sidecar 引擎、窗口与托盘。
 *
 * 为什么开窗口之前先起 sidecar：心跳灯要在第一帧就显示真实状态（需求 M0 判据）；
 * 起不来也不拦窗口，界面按 §6.7 明示 failed 与原因。
 * 依赖方向：main -> electron + ./config ./logger ./engine ./ipc-handlers ./health-client ./heartbeat ./sidecar-process。
 * 启动链：Electron main -> loadMainConfig -> createMainLogger -> SidecarEngine.start -> registerIpcHandlers -> 创建窗口。
 */
import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import { join } from "node:path";

import { loadMainConfig, type MainConfig } from "./config";
import { SidecarEngine } from "./engine";
import { toErrorMessage } from "./errors";
import { HealthClient } from "./health-client";
import { HeartbeatMonitor } from "./heartbeat";
import { registerIpcHandlers } from "./ipc-handlers";
import { createMainLogger, type MainLogger } from "./logger";
import { SidecarProcess } from "./sidecar-process";

const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 640;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: SidecarEngine | null = null;
let logger: MainLogger | null = null;
let unregisterIpc: (() => void) | null = null;
/** 关闭按钮默认只是隐藏到托盘；只有真正退出（托盘菜单/系统退出）才放行。 */
let quitting = false;

/** 打包后代码在 dist、资源在 resources 下；开发模式两者都在仓库根。 */
function resolveConfig(): MainConfig {
  return loadMainConfig({
    isDev: !app.isPackaged,
    appRoot: app.getAppPath(),
    resourcesRoot: process.resourcesPath,
    userDataDir: app.getPath("userData"),
    env: process.env,
  });
}

function rendererIndexPath(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

function trayIconPath(): string {
  return join(__dirname, "..", "renderer", "assets", "placeholder.png");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 480,
    title: "deskpet",
    show: false,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  // 关窗口不等于退出程序：桌宠要常驻托盘（需求 F5 主动问候依赖常驻）
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    mainWindow = null;
  });
  void window.loadFile(rendererIndexPath());
  return window;
}

function showWindow(): void {
  if (mainWindow === null) {
    mainWindow = createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): Tray {
  const icon = nativeImage.createFromPath(trayIconPath());
  const instance = new Tray(icon);
  instance.setToolTip("deskpet");
  instance.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主界面", click: showWindow },
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
function shutdown(): void {
  quitting = true;
  unregisterIpc?.();
  unregisterIpc = null;
  logger?.info("app.quit", "deskpet 主进程退出");
  logger?.close();
  tray?.destroy();
  tray = null;
}

async function bootstrap(): Promise<void> {
  const config = resolveConfig();
  const mainLogger = createMainLogger(config.mainLogFile);
  logger = mainLogger;
  mainLogger.info("app.start", "deskpet 主进程启动", {
    version: app.getVersion(),
    isDev: config.isDev,
    dataDir: config.dataDir,
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

  unregisterIpc = registerIpcHandlers({
    engine: sidecarEngine,
    logger: mainLogger,
    getWindow: () => mainWindow,
  });

  mainWindow = createWindow();
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
    void pending.stop().finally(() => {
      shutdown();
      app.exit(0);
    });
  });
}
