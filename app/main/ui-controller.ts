/**
 * 文件职责：界面状态的运行时控制器——套用到桌宠主窗、落盘 data/ui.json、广播给各个窗口。
 *
 * 为什么先过一层控制器：控制器只依赖最小的 PetWindowHandle 接口，于是「缩放改没改尺寸」
 * 「点穿透开关有没有生效」「拖动后有没有记住位置」都能用假窗口在 vitest 里测，不必起 Electron。
 * 依赖方向：main -> ./ipc（契约类型）+ ./ui-state（纯函数与存档）+ ./errors；不 import electron。
 * 谁调用：app/main/index.ts 装配（窗口适配器由 app/main/windows.ts 提供）。
 */

import { toErrorMessage } from "./errors";
import type { CharacterSummary, UiMetricsMessage, UiStatePatch, UiStatePayload } from "./ipc";
import type { MainLogger } from "./logger";
import {
  applyUiStatePatch,
  CHAT_BAR_HEIGHT,
  clampChatbarHeight,
  clampStage,
  computePetWindowSize,
  DEFAULT_UI_STATE,
  readUiState,
  writeUiState,
} from "./ui-state";

/** 主窗需要被控制器驱动的最小能力；由 app/main/windows.ts 用 BrowserWindow 实现。 */
export interface PetWindowHandle {
  /** 改内容尺寸（§6.11：尺寸 = 立绘包围盒 × 缩放）。 */
  setContentSize(width: number, height: number): void;
  /** 开关透明区鼠标穿透；开启时鼠标移动事件仍会转发到页面（§6.11）。 */
  setClickThrough(enabled: boolean): void;
  setAlwaysOnTop(enabled: boolean): void;
  /** 相对当前位置移动（渲染层 JS 拖动，T2.2）。 */
  moveBy(dx: number, dy: number): void;
  /** 读窗口外框；居中算位置用的是外框宽高，不是内容尺寸。 */
  getBounds(): { x: number; y: number; width: number; height: number };
  setPosition(x: number, y: number): void;
}

export interface UiControllerDeps {
  readonly stateFile: string;
  readonly window: () => PetWindowHandle | null;
  /** 把最新状态推给主窗与设置窗（main → renderer）。 */
  readonly broadcast: (state: UiStatePayload) => void;
  readonly openSettings: () => void;
  readonly listCharacters: () => Promise<readonly CharacterSummary[]>;
  /**
   * 当前显示器的工作区（不含任务栏）；托盘菜单「位置重置到屏幕中央」用它（T2.2）。
   * 为什么由调用方给：合理由 Electron 的 screen 模块算，控制器不 import electron（可单测）。
   */
  readonly workArea: () => WorkArea | null;
  readonly logger: MainLogger;
}

/** 显示器工作区矩形（Electron screen.getDisplayNearestPoint().workArea 的子集）。 */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 单次拖动事件的最大位移：坏值或指针瞬移不至于把窗口甩出屏幕。 */
export const DRAG_STEP_MAX = 400;

/** 位移增量取整并夹到 ±DRAG_STEP_MAX（NaN / 非数由调用方挡掉）。 */
function clampDragStep(value: number): number {
  return Math.max(Math.min(Math.round(value), DRAG_STEP_MAX), -DRAG_STEP_MAX);
}

export class UiController {
  private state: UiStatePayload = { ...DEFAULT_UI_STATE };
  /** 指针是否落在立绘 / 聊天条范围内；与「允许穿透」共同决定窗口是否忽略鼠标。 */
  private pointerInside = false;
  /** 聊天条实测高度：输入框自动换行会把它顶高（T2.2），不落盘、只影响本次窗口尺寸。 */
  private chatbarHeight = CHAT_BAR_HEIGHT;
  /** 上一次真正套到窗口的尺寸：同一尺寸不重复 setContentSize，否则每次换行窗口都抖一下。 */
  private appliedSize: { width: number; height: number } | null = null;
  /** 落盘串行化：连续拖动不会让两个 .tmp 互相覆盖。 */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UiControllerDeps) {}

  /** 启动时读一次存档；窗口建好后由调用方 applyToWindow() 套用（窗口先显示上一回的位置）。 */
  async load(): Promise<UiStatePayload> {
    this.state = await readUiState(this.deps.stateFile);
    this.deps.logger.info("ui.state_loaded", "读取界面状态存档", { ...this.state });
    return this.getState();
  }

  getState(): UiStatePayload {
    return { ...this.state };
  }

  /** 把当前状态套到窗口上：尺寸 / 置顶 / 穿透。窗口还没建时什么都不做。 */
  applyToWindow(): void {
    const window = this.deps.window();
    if (window === null) {
      return;
    }
    const size = computePetWindowSize(
      this.state.scale,
      { width: this.state.stage_width, height: this.state.stage_height },
      this.chatbarHeight,
    );
    if (
      this.appliedSize === null ||
      this.appliedSize.width !== size.width ||
      this.appliedSize.height !== size.height
    ) {
      this.appliedSize = size;
      window.setContentSize(size.width, size.height);
    }
    window.setAlwaysOnTop(this.state.always_on_top);
    window.setClickThrough(this.effectiveClickThrough());
  }

  /** 应用界面的增量改动：套到窗口 → 落盘 → 广播，返回新状态。 */
  async setState(patch: UiStatePatch): Promise<UiStatePayload> {
    this.state = applyUiStatePatch(this.state, patch);
    this.applyToWindow();
    await this.persist();
    const next = this.getState();
    this.deps.broadcast(next);
    this.deps.logger.info("ui.state_changed", "界面状态已更新", {
      scale: next.scale,
      click_through: next.click_through,
      always_on_top: next.always_on_top,
      char_id: next.char_id,
    });
    return next;
  }

  /** 主窗被拖动后回写位置；只落盘、不广播（坐标对界面显示没有意义）。 */
  noteMoved(x: number, y: number): void {
    if (this.state.x === x && this.state.y === y) {
      return;
    }
    this.state = { ...this.state, x, y };
    void this.persist();
  }

  /**
   * 渲染层 JS 拖动发来的位移增量（T2.2 真机反馈）。
   *
   * 为什么不用 -webkit-app-region：那是 Chromium 自带的窗口拖动，合成鼠标事件验证不到，
   * 而且只能盖在画出来的像素上；改成渲染层算增量、主进程 setPosition，拖动区可以自己定义。
   */
  dragBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return;
    }
    const stepX = clampDragStep(dx);
    const stepY = clampDragStep(dy);
    if (stepX === 0 && stepY === 0) {
      return;
    }
    this.deps.window()?.moveBy(stepX, stepY);
  }

  /**
   * 托盘菜单「位置重置到屏幕中央」（T2.2 真机需求）：按当前显示器工作区居中。
   *
   * 为什么用窗口外框而不是内容尺寸：屏幕坐标对的是外框；无边框窗两者通常一致，
   * 但按外框算在有无边框两种情况下都对。窗口还没建 / 拿不到工作区时返回 false。
   */
  resetPosition(): boolean {
    const window = this.deps.window();
    const area = this.deps.workArea();
    if (window === null || area === null) {
      return false;
    }
    const bounds = window.getBounds();
    const x = Math.round(area.x + (area.width - bounds.width) / 2);
    const y = Math.round(area.y + (area.height - bounds.height) / 2);
    window.setPosition(x, y);
    this.noteMoved(x, y);
    this.deps.logger.info("ui.position_reset", "主窗位置已重置到屏幕中央", { x, y });
    return true;
  }

  /**
   * 渲染层量出来的素材包围盒与聊天条高度（T2.2）。
   *
   * 为什么分开更新：包围盒是素材的属性（换角色 / 换素材才变），要落盘留给下次启动；
   * 聊天条高度是输入框长高的结果（每换一行都可能变），只影响这一次窗口尺寸，不落盘也不广播。
   */
  noteMetrics(metrics: UiMetricsMessage): void {
    const width = clampStage(metrics.stage_width, this.state.stage_width);
    const height = clampStage(metrics.stage_height, this.state.stage_height);
    const chatbar = clampChatbarHeight(metrics.chatbar_height);
    const stageChanged = width !== this.state.stage_width || height !== this.state.stage_height;
    if (stageChanged) {
      this.state = { ...this.state, stage_width: width, stage_height: height };
      void this.persist();
    }
    if (!stageChanged && chatbar === this.chatbarHeight) {
      return;
    }
    this.chatbarHeight = chatbar;
    this.applyToWindow();
    this.deps.logger.debug("ui.metrics", "按素材尺寸调整窗口", {
      stage_width: width,
      stage_height: height,
      chatbar_height: chatbar,
    });
  }

  /** 指针进出可交互区：只有「允许穿透」开着时才切，关掉穿透的窗口就是普通窗口。 */
  setPointerInside(inside: boolean): void {
    if (this.pointerInside === inside) {
      return;
    }
    this.pointerInside = inside;
    this.deps.window()?.setClickThrough(this.effectiveClickThrough());
  }

  /** 打开设置窗（托盘菜单与聊天条按钮共用这条路径）。 */
  openSettings(): void {
    this.deps.openSettings();
  }

  /** 供 IPC 的 charList 用。 */
  async characters(): Promise<readonly CharacterSummary[]> {
    const list = await this.deps.listCharacters();
    this.deps.logger.debug("ui.characters_listed", "列出可选角色", { count: list.length });
    return list;
  }

  /** 等落盘队列排空（退出前与测试用）：拖动是防抖异步写，flush 让调用方能确定已经写进去了。 */
  async flush(): Promise<void> {
    await this.saveChain;
  }

  private effectiveClickThrough(): boolean {
    return this.state.click_through && !this.pointerInside;
  }

  /** 落盘失败只记日志：界面状态不值得打断用户（CODE_STYLE §6.3 的兜底）。 */
  private persist(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      try {
        await writeUiState(this.deps.stateFile, this.state);
      } catch (error: unknown) {
        this.deps.logger.warn("ui.state_save_failed", "保存界面状态失败：" + toErrorMessage(error));
      }
    });
    return this.saveChain;
  }
}
