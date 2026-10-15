/**
 * 文件职责：界面状态的运行时控制器——套用到桌宠主窗、落盘 data/ui.json、广播给各个窗口。
 *
 * 为什么先过一层控制器：控制器只依赖最小的 PetWindowHandle 接口，于是「缩放改没改尺寸」
 * 「点穿透开关有没有生效」「拖动后有没有记住位置」都能用假窗口在 vitest 里测，不必起 Electron。
 * 依赖方向：main -> ./ipc（契约类型）+ ./ui-state（纯函数与存档）+ ./errors；不 import electron。
 * 谁调用：app/main/index.ts 装配（窗口适配器由 app/main/windows.ts 提供）。
 */

import { toErrorMessage } from "./errors";
import type { CharacterSummary, UiStatePatch, UiStatePayload } from "./ipc";
import type { MainLogger } from "./logger";
import {
  applyUiStatePatch,
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
}

export interface UiControllerDeps {
  readonly stateFile: string;
  readonly window: () => PetWindowHandle | null;
  /** 把最新状态推给主窗与设置窗（main → renderer）。 */
  readonly broadcast: (state: UiStatePayload) => void;
  readonly openSettings: () => void;
  readonly listCharacters: () => Promise<readonly CharacterSummary[]>;
  readonly logger: MainLogger;
}

export class UiController {
  private state: UiStatePayload = { ...DEFAULT_UI_STATE };
  /** 指针是否落在立绘 / 聊天条范围内；与「允许穿透」共同决定窗口是否忽略鼠标。 */
  private pointerInside = false;
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
    const size = computePetWindowSize(this.state.scale);
    window.setContentSize(size.width, size.height);
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
