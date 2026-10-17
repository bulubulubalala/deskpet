/**
 * 文件职责：创建桌宠主窗（无边框 / 透明 / 不进任务栏）与设置窗（720×520，单实例）。
 *
 * 为什么尺寸不写死在这里：§6.11 规定主窗尺寸 = 立绘包围盒 × 缩放，倍数一变要立刻跟着变，
 * 所以尺寸计算留在 ui-state.ts（纯函数），本模块只把结果套到 BrowserWindow 上。
 * 依赖方向：main -> electron + ./ui-state + ./ui-controller（实现 PetWindowHandle）。
 * 谁调用：app/main/index.ts（建主窗与托盘）；设置窗由托盘菜单与聊天条按钮打开。
 */

import { BrowserWindow } from "electron";

import type { UiStatePayload } from "./ipc";
import type { MainLogger } from "./logger";
import type { PetWindowHandle } from "./ui-controller";
import { computePetWindowSize } from "./ui-state";

export const SETTINGS_WINDOW_WIDTH = 720;
export const SETTINGS_WINDOW_HEIGHT = 520;

/** 拖动时 move 事件很密集，攒 400ms 再落盘一次位置。 */
const MOVE_SAVE_DEBOUNCE_MS = 400;

export interface PetWindowDeps {
  readonly state: UiStatePayload;
  readonly preloadPath: string;
  readonly indexHtmlPath: string;
  readonly logger: MainLogger;
  /** 窗口被拖动后回传左上角坐标（已去抖），由控制器落盘。 */
  readonly onMoved: (x: number, y: number) => void;
}

export interface PetWindow {
  readonly window: BrowserWindow;
  readonly handle: PetWindowHandle;
}

export function createPetWindow(deps: PetWindowDeps): PetWindow {
  // 建窗时就用上一回量到的包围盒：否则先按占位图 128×128 建、applyToWindow 再改，能看见一次跳变
  const size = computePetWindowSize(deps.state.scale, {
    width: deps.state.stage_width,
    height: deps.state.stage_height,
  });
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: deps.state.x,
    y: deps.state.y,
    title: "deskpet",
    show: false,
    // F11 / §6.11：桌面只有人和聊天条，不要系统标题栏、不要任务栏图标
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: deps.state.always_on_top,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let moveTimer: NodeJS.Timeout | null = null;
  const clearMoveTimer = (): void => {
    if (moveTimer !== null) {
      clearTimeout(moveTimer);
      moveTimer = null;
    }
  };
  window.on("move", () => {
    clearMoveTimer();
    moveTimer = setTimeout(() => {
      moveTimer = null;
      const [x, y] = window.getPosition();
      deps.onMoved(x ?? 0, y ?? 0);
    }, MOVE_SAVE_DEBOUNCE_MS);
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", clearMoveTimer);

  const handle: PetWindowHandle = {
    setContentSize: (width, height) => {
      window.setContentSize(width, height);
    },
    setClickThrough: (enabled) => {
      // forward: true 让「正在穿透」的窗口仍把鼠标移动事件转给页面，
      // 否则指针一旦离开命中区就再也收不到 mousemove，永远切不回来（§6.11）
      window.setIgnoreMouseEvents(enabled, { forward: true });
    },
    setAlwaysOnTop: (enabled) => {
      window.setAlwaysOnTop(enabled);
    },
    moveBy: (dx, dy) => {
      const [x, y] = window.getPosition();
      window.setPosition(Math.round((x ?? 0) + dx), Math.round((y ?? 0) + dy));
    },
    getBounds: () => window.getBounds(),
    setPosition: (x, y) => {
      window.setPosition(x, y);
    },
  };

  void window.loadFile(deps.indexHtmlPath);
  return { window, handle };
}

export interface SettingsWindowDeps {
  readonly preloadPath: string;
  readonly settingsHtmlPath: string;
  readonly logger: MainLogger;
}

/** 设置窗单实例：再次打开只是把它拎到前台（§6.11）。 */
export class SettingsWindowController {
  private window: BrowserWindow | null = null;

  constructor(private readonly deps: SettingsWindowDeps) {}

  open(): BrowserWindow {
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return this.window;
    }
    const window = new BrowserWindow({
      width: SETTINGS_WINDOW_WIDTH,
      height: SETTINGS_WINDOW_HEIGHT,
      minWidth: 560,
      minHeight: 420,
      title: "deskpet 设置",
      backgroundColor: "#14161c",
      show: false,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // 设置窗是常规有框窗口，但不给菜单栏（F11 的禁用项只针对主窗形态）
    window.setMenuBarVisibility(false);
    window.once("ready-to-show", () => {
      window.show();
    });
    window.on("closed", () => {
      this.window = null;
    });
    void window.loadFile(this.deps.settingsHtmlPath);
    this.window = window;
    this.deps.logger.info("ui.settings_opened", "打开设置窗");
    return window;
  }
}
