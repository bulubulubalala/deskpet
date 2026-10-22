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
  /** 把主窗收进托盘（不退出程序）；聊天条按钮与托盘菜单共用（T2.3-C2c）。 */
  hide(): void;

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
  /**
   * 系统光标当前的屏幕坐标（DIP）；拖动时窗口位置 = 光标 − 抓点偏置（T2.2 用户反馈第五轮）。
   * 为什么由调用方给：只有 Electron 的 screen.getCursorScreenPoint() 知道，控制器不 import electron。
   */
  readonly cursor: () => { x: number; y: number } | null;
  readonly logger: MainLogger;
  readonly onStateChanged?: (state: UiStatePayload) => void;
}

/** 显示器工作区矩形（Electron screen.getDisplayNearestPoint().workArea 的子集）。 */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 拖动时跟随系统光标的轮询间隔（毫秒）。
 *
 * 为什么是轮询而不是等渲染层的 mousemove：窗口自己也在动，渲染层算的位移增量会趋近 0
 * （拖动不跟手、拖快就不动的根因）；直接读光标屏幕坐标并保持抓点偏置，窗口永远贴着光标。
 * 12ms ≈ 80Hz，比 60Hz 屏幕刷新略快，肉眼就是跟手的（T2.2 用户反馈第五轮）。
 */
export const DRAG_POLL_MS = 12;

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
  /** 拖动中：抓点相对窗口左上角的偏置（null = 没在拖）。 */
  private dragOffset: { x: number; y: number } | null = null;
  /** 拖动时的跟随定时器；endDrag 必须清掉，否则窗口会一直粘着光标。 */
  private dragTimer: NodeJS.Timeout | null = null;
  /** 上一次真正设过的窗口位置：同一位置不重复 setPosition，省掉无谓的窗口消息。 */
  private dragPosition: { x: number; y: number } | null = null;

  constructor(private readonly deps: UiControllerDeps) {}

  /** 启动时读一次存档；窗口建好后由调用方 applyToWindow() 套用（窗口先显示上一回的位置）。 */
  async load(): Promise<UiStatePayload> {
    this.state = await readUiState(this.deps.stateFile);
    this.deps.logger.info("ui.state_loaded", "读取界面状态存档", { ...this.state });
    this.deps.onStateChanged?.(this.getState());
    return this.getState();
  }

  getState(): UiStatePayload {
    return { ...this.state };
  }

  /**
   * 收进托盘：只 hide 窗口，不退出程序。
   *
   * 为什么不做成退出：F5 的主动问候与记忆压缩都靠进程常驻，关窗口只是看不见（T2.3-C2c）。
   */
  minimize(): void {
    const window = this.deps.window();
    if (window === null) {
      return;
    }
    window.hide();
    this.deps.logger.info("ui.minimize", "主窗已最小化到托盘");
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
    this.deps.onStateChanged?.(next);
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
   * 开始拖动（渲染层 mousedown 报来，T2.2 用户反馈第五轮）。
   *
   * 抓点偏置 = 光标屏幕坐标 − 窗口左上角；之后每 DRAG_POLL_MS 把窗口摆到「光标 − 偏置」。
   * 位置不依赖窗口自身的移动量，所以光标多快都不会「追丢」。
   */
  beginDrag(): void {
    if (this.dragOffset !== null) {
      return;
    }
    const window = this.deps.window();
    const cursor = this.deps.cursor();
    if (window === null || cursor === null) {
      return;
    }
    const bounds = window.getBounds();
    this.dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    this.dragPosition = { x: bounds.x, y: bounds.y };
    this.dragTimer = setInterval(() => {
      this.stepDrag();
    }, DRAG_POLL_MS);
    // 拖动期间必须收得到 mouseup：穿透开着时窗口会忽略鼠标事件，松手永远等不到
    this.applyToWindow();
    this.deps.logger.debug("ui.drag_start", "开始拖动主窗", { ...this.dragOffset });
  }

  /** 跟随一次系统光标（同一个定时器里跑；测试可直接调）。 */
  stepDrag(): void {
    const offset = this.dragOffset;
    const window = this.deps.window();
    const cursor = this.deps.cursor();
    if (offset === null || window === null || cursor === null) {
      return;
    }
    const x = Math.round(cursor.x - offset.x);
    const y = Math.round(cursor.y - offset.y);
    if (this.dragPosition !== null && this.dragPosition.x === x && this.dragPosition.y === y) {
      return;
    }
    this.dragPosition = { x, y };
    window.setPosition(x, y);
    this.noteMoved(x, y);
  }

  /** 结束拖动：清定时器并恢复穿透判定（渲染层 mouseup / blur 报来）。 */
  endDrag(): void {
    if (this.dragOffset === null) {
      return;
    }
    if (this.dragTimer !== null) {
      clearInterval(this.dragTimer);
      this.dragTimer = null;
    }
    // 松手前再对一次光标：拖动靠 12ms 轮询采样，快速甩动时最后一步可能还没采到，
    // 不补这一次窗口就会停在半路（T2.2 用户反馈第五轮真机实测：甩动只跟到一半）。
    this.stepDrag();
    this.dragOffset = null;
    this.dragPosition = null;
    this.applyToWindow();
    this.deps.logger.debug("ui.drag_end", "结束拖动主窗", { x: this.state.x, y: this.state.y });
  }

  /** 是否正在拖动（退出清理与测试用）。 */
  isDragging(): boolean {
    return this.dragOffset !== null;
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
    // 拖动期间一律不穿透：否则 mouseup 会被穿透吃掉，窗口会一直粘着光标（T2.2 用户反馈第五轮）
    return this.state.click_through && !this.pointerInside && this.dragOffset === null;
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
