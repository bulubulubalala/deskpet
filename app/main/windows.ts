/**
 * 文件职责：创建桌宠主窗（无边框 / 透明 / 不进任务栏）与设置窗（720×520，单实例）。
 *
 * 为什么尺寸不写死在这里：§6.11 规定主窗尺寸 = 立绘包围盒 × 缩放，倍数一变要立刻跟着变，
 * 所以尺寸计算留在 ui-state.ts（纯函数），本模块只把结果套到 BrowserWindow 上。
 * 依赖方向：main -> electron + ./ui-state + ./ui-controller（实现 PetWindowHandle）。
 * 谁调用：app/main/index.ts（建主窗与托盘）；设置窗由托盘菜单与聊天条按钮打开；
 *           角色包编辑器（T2.3-D）由设置窗的「新建角色包」打开。
 */

import { BrowserWindow, screen } from "electron";

import type { PackOpenEditorRequest, UiStatePayload } from "./ipc";
import type { MainLogger } from "./logger";
import type { PetWindowHandle } from "./ui-controller";
import { computePetWindowSize } from "./ui-state";

export const SETTINGS_WINDOW_WIDTH = 900;
export const SETTINGS_WINDOW_HEIGHT = 640;
export const COMPANION_WINDOW_WIDTH = 780;
export const COMPANION_WINDOW_HEIGHT = 720;
export const EDITOR_WINDOW_WIDTH = 1000;
export const EDITOR_WINDOW_HEIGHT = 700;

/** 拖动时 move 事件很密集，攒 400ms 再落盘一次位置。 */
const MOVE_SAVE_DEBOUNCE_MS = 400;

export interface PetWindowDeps {
  readonly state: UiStatePayload;
  readonly preloadPath: string;
  readonly indexHtmlPath: string;
  readonly logger: MainLogger;
  /** 窗口被拖动后回传左上角坐标（已去抖），由控制器落盘。 */
  readonly onMoved: (x: number, y: number) => void;
  /**
   * 每次 move 事件同步回传左上角坐标（不去抖），供晃动检测（T2.3-C1）。
   * 为什么与 onMoved 分开：落盘要攒着写，晃动判定要逐条看方向，攒了就数不出反转。
   */
  readonly onMoving?: (x: number, y: number) => void;
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
  // 存档位置可能来自「窗口更大的时候」（换素材 / 缩小显示上限后），把左上角钳到当前
  // 显示器工作区内，避免桌宠一部分跑到屏幕外（用户反馈窗口太大后特别容易撞上）。
  const workArea = screen.getDisplayNearestPoint({
    x: deps.state.x,
    y: deps.state.y,
  }).workArea;
  const x = Math.min(
    Math.max(deps.state.x, workArea.x),
    Math.max(workArea.x, workArea.x + workArea.width - size.width),
  );
  const y = Math.min(
    Math.max(deps.state.y, workArea.y),
    Math.max(workArea.y, workArea.y + workArea.height - size.height),
  );
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
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
    const [movingX, movingY] = window.getPosition();
    deps.onMoving?.(movingX ?? 0, movingY ?? 0);
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
    hide: () => {
      window.hide();
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
      this.window.moveTop();
      return this.window;
    }
    const window = new BrowserWindow({
      width: SETTINGS_WINDOW_WIDTH,
      height: SETTINGS_WINDOW_HEIGHT,
      minWidth: 760,
      minHeight: 560,
      title: "deskpet 设置",
      backgroundColor: "#f6f0e6",
      // 主窗默认置顶；设置窗必须压在它上面，否则右侧控件会被立绘窗挡住（T2.8）
      alwaysOnTop: true,
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
      window.moveTop();
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

export interface CompanionWindowDeps {
  readonly preloadPath: string;
  readonly companionHtmlPath: string;
  readonly logger: MainLogger;
}

export class CompanionWindowController {
  private window: BrowserWindow | null = null;

  constructor(private readonly deps: CompanionWindowDeps) {}

  open(): BrowserWindow {
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      this.window.moveTop();
      return this.window;
    }
    const window = new BrowserWindow({
      width: COMPANION_WINDOW_WIDTH,
      height: COMPANION_WINDOW_HEIGHT,
      minWidth: 680,
      minHeight: 560,
      title: "deskpet 主动陪伴",
      backgroundColor: "#f6f0e6",
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.setMenuBarVisibility(false);
    window.once("ready-to-show", () => {
      window.show();
      window.moveTop();
    });
    window.on("closed", () => {
      this.window = null;
    });
    void window.loadFile(this.deps.companionHtmlPath);
    this.window = window;
    this.deps.logger.info("ui.companion_opened", "打开主动陪伴设置");
    return window;
  }
}

export interface EditorWindowDeps {
  readonly preloadPath: string;
  readonly editorHtmlPath: string;
  readonly logger: MainLogger;
}

/**
 * 角色包编辑器窗口（T2.3-D）：常规有框窗、可缩放，单实例（再点只是拎到前台）。
 *
 * 为什么单独一个窗口而不是塞进设置窗：裁切与画框要一整块画布，720×520 塞不下（方案 §5.1）。
 */
export class EditorWindowController {
  private window: BrowserWindow | null = null;
  private lastKey = "";

  constructor(private readonly deps: EditorWindowDeps) {}

  /**
   * 打开编辑器；mode=edit 时带 char_id 走「只编辑部位」模式（T2.5）。
   *
   * 窗口已存在且模式 / 角色不同：重新 loadFile 并带上新的 query，避免把旧角色的框保存到新角色。
   */
  open(request: PackOpenEditorRequest = { mode: "create" }): BrowserWindow {
    const key = request.mode + ":" + (request.char_id ?? "");
    if (this.window !== null && !this.window.isDestroyed()) {
      if (key !== this.lastKey) {
        void this.window.loadFile(this.deps.editorHtmlPath, {
          query: editorQuery(request),
        });
        this.lastKey = key;
      }
      this.window.show();
      this.window.focus();
      this.window.moveTop();
      return this.window;
    }
    const window = new BrowserWindow({
      width: EDITOR_WINDOW_WIDTH,
      height: EDITOR_WINDOW_HEIGHT,
      minWidth: 820,
      minHeight: 560,
      title: "deskpet 角色包编辑器",
      backgroundColor: "#f6f0e6",
      // 主窗默认置顶；编辑器必须压在它上面，否则画布 / 右侧部位列表点不到（T2.8）
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.setMenuBarVisibility(false);
    window.once("ready-to-show", () => {
      window.show();
      window.moveTop();
    });
    window.on("closed", () => {
      this.window = null;
      this.lastKey = "";
    });
    void window.loadFile(this.deps.editorHtmlPath, { query: editorQuery(request) });
    this.window = window;
    this.lastKey = key;
    this.deps.logger.info("ui.editor_opened", "打开角色包编辑器", {
      mode: request.mode,
      char_id: request.char_id ?? "",
    });
    return window;
  }
}

/** 只把模式与 char_id 传给编辑器；完整角色数据由 pack:load 再读，避免 query 过长 / 泄露。 */
function editorQuery(request: PackOpenEditorRequest): Record<string, string> {
  if (
    (request.mode === "edit" || request.mode === "card") &&
    request.char_id !== undefined &&
    request.char_id !== ""
  ) {
    return { mode: request.mode, char_id: request.char_id };
  }
  return { mode: "create" };
}
