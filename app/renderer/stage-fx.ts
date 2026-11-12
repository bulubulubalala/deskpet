/**
 * 文件职责：立绘上的触摸反馈层——点击涟漪 + 抚摸轨迹，PNG 与 Live2D 共用一块 overlay canvas。
 *
 * 为什么是独立的一层而不是画进模型 / 给 <img> 加滤镜：轨迹和涟漪跟角色怎么渲染无关，
 * 一块 pointer-events:none 的 canvas 贴在 #stage-mount 里，两种舞台都能用，也方便随时关掉。
 * 只在有东西要画时跑 requestAnimationFrame；静止时零开销、零 DOM 变化（不引 blur / filter，
 * 那会把整窗合成层拖慢）。
 * 依赖方向：renderer 内部；画什么由 fx-model.ts 决定，本文件只管把数画出来。
 * 谁调用：app/renderer/index.ts（与 stage 同生命周期）。
 */
import {
  DEFAULT_FX_COLOR,
  normalizeFxColor,
  makeRipples,
  pruneTrail,
  pushTrailPoint,
  rippleAt,
  ripplesDone,
  trailSegments,
  type FxPoint,
  type Ripple,
} from "./fx-model";
import { RIPPLE_WIDTH_PX } from "./fx-model";

/** 画布最多按 2x 采样：4K 屏上再高只是白烧 GPU，肉眼看不出来。 */
const MAX_DPR = 2;

export class StageEffects {
  private readonly mount: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private observer: ResizeObserver | null = null;
  private ripples: Ripple[] = [];
  private trail: FxPoint[] = [];
  private trailColor = DEFAULT_FX_COLOR;
  private drawingTrail = false;
  private frame: number | null = null;
  private widthCss = 0;
  private heightCss = 0;

  private constructor(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
  ) {
    this.mount = mount;
    this.canvas = canvas;
    this.ctx = ctx;
  }

  /** 挂到舞台容器上；拿不到 2D 上下文（极老的显卡驱动）返回 null，调用方按「没有反馈层」处理。 */
  static attach(mount: HTMLElement): StageEffects | null {
    const canvas = document.createElement("canvas");
    canvas.className = "stage-fx";
    canvas.setAttribute("aria-hidden", "true");
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return null;
    }
    const effects = new StageEffects(mount, canvas, ctx);
    mount.append(canvas);
    effects.relayout();
    if (typeof ResizeObserver !== "undefined") {
      effects.observer = new ResizeObserver(() => effects.relayout());
      effects.observer.observe(mount);
    }
    return effects;
  }

  /** 立绘区域变了：重算画布像素尺寸（CSS 尺寸由样式表管）。 */
  relayout(): void {
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.widthCss = width;
    this.heightCss = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 在客户端坐标处画一圈两环涟漪；color 为空用默认暖白。 */
  ripple(clientX: number, clientY: number, color?: string | null): void {
    const point = this.localPoint(clientX, clientY);
    if (point === null) {
      return;
    }
    const now = performance.now();
    this.ripples.push(...makeRipples(point.x, point.y, now, normalizeFxColor(color)));
    this.prune(now);
    this.schedule();
  }

  /** 开始一次轨迹（摸 / 揉）；之前没画完的轨迹直接丢掉，避免两条线接在一起。 */
  beginTrail(color?: string | null): void {
    this.trail = [];
    this.trailColor = normalizeFxColor(color);
    this.drawingTrail = true;
  }

  /** 追加一个轨迹点；没在画轨迹时静默忽略（点击、按住都不画线）。 */
  pushTrail(clientX: number, clientY: number): void {
    if (!this.drawingTrail) {
      return;
    }
    const point = this.localPoint(clientX, clientY);
    if (point === null) {
      return;
    }
    this.trail = pushTrailPoint(this.trail, { x: point.x, y: point.y, t: performance.now() });
    this.schedule();
  }

  /** 松手：不再收新点，已有轨迹自己淡完。 */
  endTrail(): void {
    this.drawingTrail = false;
  }

  /** 换角色 / 关互动：立刻清干净。 */
  clear(): void {
    this.ripples = [];
    this.trail = [];
    this.drawingTrail = false;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.ctx.clearRect(0, 0, this.widthCss, this.heightCss);
  }

  destroy(): void {
    this.clear();
    this.observer?.disconnect();
    this.observer = null;
    this.canvas.remove();
  }

  private readonly step = (): void => {
    this.frame = null;
    const now = performance.now();
    this.draw(now);
    this.prune(now);
    if (this.ripples.length > 0 || this.trail.length > 0) {
      this.schedule();
    }
  };

  private schedule(): void {
    if (this.frame !== null) {
      return;
    }
    this.frame = requestAnimationFrame(this.step);
  }

  private prune(now: number): void {
    this.ripples = this.ripples.filter((ripple) => !ripplesDone([ripple], now));
    this.trail = pruneTrail(this.trail, now);
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.widthCss, this.heightCss);
    ctx.lineCap = "round";
    for (const ripple of this.ripples) {
      const frame = rippleAt(ripple, now);
      if (frame === null) {
        continue;
      }
      ctx.globalAlpha = frame.alpha;
      ctx.strokeStyle = ripple.color;
      ctx.lineWidth = RIPPLE_WIDTH_PX;
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, frame.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const segment of trailSegments(this.trail, now)) {
      ctx.globalAlpha = segment.alpha;
      ctx.strokeStyle = this.trailColor;
      ctx.lineWidth = segment.width;
      ctx.beginPath();
      ctx.moveTo(segment.from.x, segment.from.y);
      ctx.lineTo(segment.to.x, segment.to.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** 客户端坐标 → 舞台容器内坐标；容器尺寸还没量出来返回 null。 */
  private localPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.mount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
}
