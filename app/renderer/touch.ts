/**
 * 文件职责：触摸手势引擎（T2.3-C2c，方案 §4）——把指针轨迹分档成 tap / stroke / hold / knead / pat。
 *
 * 为什么单独一个纯逻辑模块：手势判定全是几何与时间，跟 DOM、Electron、网络无关；
 * 单测可以直接喂一条时间轴（何时按下、往哪儿移、何时松开），不必拉起窗口。
 * 谁调用：app/renderer/index.ts 的互动模式（它负责量坐标、找部位、发 IPC）。
 */

import type { TouchGesture, TouchMessage, TouchRegion } from "../main/ipc";

/** 按下到抬起的位移不超过这个值（px）算「点」，不算「摸」。 */
export const TOUCH_TAP_MOVE_PX = 6;
/** 一动不动按住这么久算「按住」（600ms 是「按住不放」与「点一下」的分界）。 */
export const TOUCH_HOLD_MS = 600;
/** 连拍：相邻两次点击的间隔不超过这个值（ms）才和上一串算在一起。 */
export const TOUCH_PAT_GAP_MS = 300;
/** 连拍至少这么多下才从 tap 升格为 pat。 */
export const TOUCH_PAT_MIN_TAPS = 3;
/** 揉：方向反转次数下限（来回搓）。 */
export const TOUCH_KNEAD_MIN_FLIPS = 3;
/** 揉：单步位移上限（px）——超过就是在摸，不是在揉。 */
export const TOUCH_KNEAD_STEP_PX = 40;
/** 揉：总位移上限（px）——揉是原地小动作。 */
export const TOUCH_KNEAD_TOTAL_PX = 120;
/** 摸：一次拖动累计位移下限（px）。 */
export const TOUCH_STROKE_MIN_PX = 40;
/** 一串触摸静默这么久（ms）就结算成一条消息（方案 §4.2 的会话聚合）。 */
export const TOUCH_SESSION_GAP_MS = 1500;
/** 一条消息最多带几个部位（与 sidecar ChatInteraction.regions 的 max_length=3 对齐）。 */
export const TOUCH_REGIONS_MAX = 3;
/** 力度上限（与 sidecar ChatInteraction.count 的 le=999 对齐）。 */
export const TOUCH_COUNT_MAX = 999;

/** 一次「按下到松开」的轨迹统计：距离、最大单步、方向反转次数、持续时间。 */
interface StrokeState {
  startAt: number;
  x: number;
  y: number;
  distance: number;
  maxStep: number;
  direction: number;
  flips: number;
}

/** 一串触摸（会话）：一个手势 + 若干下 + 摸过的部位。 */
interface SessionState {
  gesture: TouchGesture | null;
  taps: number;
  regions: TouchRegion[];
  startAt: number;
  lastAt: number;
}

/** 把部位加进会话：按 id 去重、最多 TOUCH_REGIONS_MAX 个（多了模型也记不住）。 */
function pushRegion(regions: TouchRegion[], region: TouchRegion | null): void {
  if (region === null || region.id === "") {
    return;
  }
  if (regions.some((item) => item.id === region.id)) {
    return;
  }
  if (regions.length >= TOUCH_REGIONS_MAX) {
    return;
  }
  regions.push(region);
}

/** 一次按下到松开的落点分类（不含「连拍」——那是串级别的事）。 */
export function classifyStroke(shape: {
  distance: number;
  maxStep: number;
  flips: number;
  durationMs: number;
}): TouchGesture {
  if (
    shape.flips >= TOUCH_KNEAD_MIN_FLIPS &&
    shape.distance < TOUCH_KNEAD_TOTAL_PX &&
    shape.maxStep < TOUCH_KNEAD_STEP_PX
  ) {
    return "knead";
  }
  if (shape.distance >= TOUCH_STROKE_MIN_PX) {
    return "stroke";
  }
  if (shape.durationMs >= TOUCH_HOLD_MS) {
    return "hold";
  }
  return "tap";
}

/**
 * 触摸跟踪器：喂指针事件、取聚合好的 TouchMessage。
 *
 * 用法：down/move/up 报事件，渲染层每 250ms 调一次 closeIfIdle(Date.now())；
 * 返回非 null 就说明这一串静默够久了，可以发 IPC 了。
 */
export class TouchTracker {
  private session: SessionState | null = null;
  private stroke: StrokeState | null = null;
  private pending: TouchMessage[] = [];

  /** 指针按下：开始一次轨迹；与上一串间隔太久就先结算上一串。 */
  down(x: number, y: number, at: number, region: TouchRegion | null): void {
    this.flushStale(at);
    this.stroke = {
      startAt: at,
      x,
      y,
      distance: 0,
      maxStep: 0,
      direction: 0,
      flips: 0,
    };
    if (this.session === null) {
      this.session = { gesture: null, taps: 0, regions: [], startAt: at, lastAt: at };
    }
    this.session.lastAt = at;
    pushRegion(this.session.regions, region);
  }

  /** 指针移动：累计距离、记录最大单步与方向反转（方向按 x+y 的符号粗判，够用且便宜）。 */
  move(x: number, y: number, at: number, region: TouchRegion | null): void {
    const stroke = this.stroke;
    if (stroke === null) {
      return;
    }
    const dx = x - stroke.x;
    const dy = y - stroke.y;
    const step = Math.hypot(dx, dy);
    if (step === 0) {
      return;
    }
    stroke.distance += step;
    stroke.maxStep = Math.max(stroke.maxStep, step);
    const direction = Math.sign(dx + dy);
    if (direction !== 0) {
      if (stroke.direction !== 0 && direction !== stroke.direction) {
        stroke.flips += 1;
      }
      stroke.direction = direction;
    }
    stroke.x = x;
    stroke.y = y;
    if (this.session !== null) {
      this.session.lastAt = at;
      pushRegion(this.session.regions, region);
    }
  }

  /** 指针松开：给这次轨迹定档，并并进当前这串（手势变了就另起一串）。 */
  up(x: number, y: number, at: number, region: TouchRegion | null): void {
    const stroke = this.stroke;
    if (stroke === null) {
      return;
    }
    this.move(x, y, at, region);
    const gesture = classifyStroke({
      distance: stroke.distance,
      maxStep: stroke.maxStep,
      flips: stroke.flips,
      durationMs: at - stroke.startAt,
    });
    this.stroke = null;
    if (this.session === null) {
      this.session = { gesture, taps: 0, regions: [], startAt: stroke.startAt, lastAt: at };
    }
    const session = this.session;
    session.lastAt = at;
    pushRegion(session.regions, region);
    if (session.gesture !== null && session.gesture !== gesture) {
      this.enqueue(session);
      this.session = {
        gesture,
        taps: 0,
        regions: [],
        startAt: stroke.startAt,
        lastAt: at,
      };
      pushRegion(this.session.regions, region);
    }
    if (gesture === "tap") {
      this.session.taps += 1;
    }
    if (this.session.gesture === null) {
      this.session.gesture = gesture;
    }
  }

  /** 静默够久就结算；返回 null 表示还没到点（渲染层继续等下一次轮询）。 */
  closeIfIdle(now: number): TouchMessage | null {
    const session = this.session;
    if (session !== null && now - session.lastAt >= TOUCH_SESSION_GAP_MS) {
      this.enqueue(session);
      this.session = null;
    }
    return this.pending.shift() ?? null;
  }

  /** 换角色 / 关互动模式时清干净，免得把上一只的触摸算到新角色头上。 */
  reset(): void {
    this.session = null;
    this.stroke = null;
    this.pending = [];
  }

  /** 与上一串间隔超过静默阈值：先把上一串结算掉，再开新的。 */
  private flushStale(at: number): void {
    const session = this.session;
    if (session !== null && at - session.lastAt >= TOUCH_SESSION_GAP_MS) {
      this.enqueue(session);
      this.session = null;
    }
  }

  /** 结算一串：连拍 ≥ 3 下升格为 pat，力度就是下数；其余手势力度恒为 1。 */
  private enqueue(session: SessionState): void {
    const gesture = session.gesture;
    if (gesture === null) {
      return;
    }
    const isPat = gesture === "tap" && session.taps >= TOUCH_PAT_MIN_TAPS;
    const finalGesture: TouchGesture = isPat ? "pat" : gesture;
    const count = isPat ? session.taps : gesture === "tap" ? Math.max(1, session.taps) : 1;
    this.pending.push({
      gesture: finalGesture,
      regions: session.regions.slice(0, TOUCH_REGIONS_MAX),
      count: Math.min(count, TOUCH_COUNT_MAX),
      duration_ms: Math.max(0, Math.round(session.lastAt - session.startAt)),
    });
  }
}

/** 连拍判定用的间隔上限：两次点击挨得够近才连成一串 pat。 */
export function isPatGap(gapMs: number): boolean {
  return gapMs >= 0 && gapMs <= TOUCH_PAT_GAP_MS;
}

/** 一条消息是否在手势白名单里（设置窗「手势」菜单单项启禁，方案 §5.1）。 */
export function isGestureEnabled(enabled: readonly TouchGesture[], gesture: TouchGesture): boolean {
  return enabled.includes(gesture);
}
