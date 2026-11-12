/**
 * 文件职责：全桌面鼠标追踪——按固定频率读系统光标，换算成主窗内容区坐标后推给渲染层（T2.27）。
 *
 * 为什么不靠渲染层的 mousemove：桌宠窗口只占桌面一小块，鼠标在窗口外时页面收不到事件；
 * Live2D 视线要跟随整个桌面，只能在主进程读 `screen.getCursorScreenPoint()`。
 * 依赖方向：main 内部纯逻辑；光标 / 窗口 / 发送都从 deps 注入，单测不需要 Electron。
 */
import type { UiCursorMessage } from "../shared/contracts/ipc";

/** 30Hz：Live2D focus 内部有插值，再快没有意义，反而多打 IPC。 */
export const CURSOR_POLL_MS = 33;

export interface CursorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorTrackerDeps {
  /** 系统光标的屏幕坐标（DIP）；拿不到返回 null。 */
  cursor(): { x: number; y: number } | null;
  /** 主窗内容区在屏幕上的位置与尺寸；窗口已销毁 / 拿不到返回 null。 */
  contentBounds(): CursorRect | null;
  /** 窗口是否可见且未最小化：隐藏 / 最小化时暂停发送。 */
  canTrack(): boolean;
  send(message: UiCursorMessage): void;
  intervalMs?: number;
}

export class CursorTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  /** 上一次已发送的相对坐标：不动就不重复发。 */
  private last: UiCursorMessage | null = null;

  constructor(private readonly deps: CursorTrackerDeps) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 渲染层切到 Live2D 时开，切 PNG / 销毁舞台时关。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    this.last = null;
    if (!enabled) {
      this.clearTimer();
      return;
    }
    this.timer = setInterval(() => {
      this.step();
    }, this.deps.intervalMs ?? CURSOR_POLL_MS);
    // 首帧立即推一次，避免用户不动鼠标时模型一直看着正前方。
    this.step();
  }

  /** 供单测直接驱动；生产由定时器调用。 */
  step(): void {
    if (!this.enabled) {
      return;
    }
    if (!this.deps.canTrack()) {
      // 窗口重新出现时强制补一帧，而不是沿用隐藏前的旧坐标。
      this.last = null;
      return;
    }
    const cursor = this.deps.cursor();
    const bounds = this.deps.contentBounds();
    if (cursor === null || bounds === null) {
      this.last = null;
      return;
    }
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    if (this.last !== null && this.last.x === x && this.last.y === y) {
      return;
    }
    this.last = { x, y };
    this.deps.send({ x, y });
  }

  dispose(): void {
    this.enabled = false;
    this.last = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
