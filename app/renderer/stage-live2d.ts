/**
 * 文件职责：Live2D 形象舞台——加载角色包 model3、渲染、表情/动作与部位命中。
 *
 * 依赖：PixiJS 8 + @naari3/pixi-live2d-display（MIT）+ 官方 Cubism Core 5。
 * Core 由 index.html 先加载到全局；缺失或模型加载失败时由 createStage 回退 PNG。
 */
import "pixi.js/unsafe-eval";
import { Application } from "pixi.js";
import { Live2DModel } from "@naari3/pixi-live2d-display/cubism5";

import { UI_FPS_DEFAULT } from "../shared/defaults";
import type { CharHitRegion, TouchRegion } from "../shared/contracts/ipc";
import { resolveHit, shapeOf, type Shape } from "./hit";
import { DEFAULT_LOOK_AT_ORIGIN, focusFromLookAt, smoothFocus, type LookAtPoint } from "./look-at";
import type { StagePlan } from "./stage-appearance";
import { clampToAuthored } from "./stage-live2d/hit-mapping";
import {
  clampUnit,
  meshBoxOf,
  type DrawableGeometrySource,
  type MeshBox,
} from "./stage-live2d/mesh";
import {
  clampDelta,
  modelUrl,
  parameterIndexMap,
  parameterSnapshot,
  type CubismParameterApi,
  type ModelPoint,
} from "./stage-live2d/model-api";
import type { StageAdapter, StageHost, StageSize } from "./stage";

const PULSE_DURATION_MS = 320;
const FALLBACK_HIT_BOX: readonly [number, number, number, number] = [0, 0, 1, 1];
/** 动态命中形状的最短重算间隔（毫秒）：指针 60Hz 移动，顶点数组每次都要复制。 */
const DYNAMIC_SHAPE_MIN_MS = 40;

/** 空闲时最多降到多少帧：桌宠常驻桌面，满帧空转太费电（用户选的档位比这更低时以用户为准）。 */
const IDLE_MAX_FPS = 30;
/** 交互结束后保持满帧的窗口：让动作尾巴播完再降帧。 */
const ACTIVE_WINDOW_MS = 2000;

export class Live2dStage implements StageAdapter {
  readonly kind = "live2d" as const;

  private readonly app: Application;
  private readonly model: Live2DModel;
  private readonly mount: HTMLElement;
  private readonly regions: readonly CharHitRegion[];
  private readonly hitBox: readonly [number, number, number, number];
  /** 视线支点（模型画布归一化坐标）：0,0 左上，1,1 右下（T2.28）。 */
  private readonly lookAtOrigin: readonly [number, number];
  private readonly resizeObserver: ResizeObserver;
  private readonly originalWidth: number;
  private readonly originalHeight: number;
  private renderScale = 1;
  private renderLeft = 0;
  private renderTop = 0;
  private pulseTimer: number | null = null;
  /** 最近一次鼠标的画布归一化位置；窗口 resize 后重放，视线不会跳回正前方（T2.28）。 */
  private lastLook: LookAtPoint | null = null;
  /** 目标 / 当前视线值；current 每帧缓动靠近 target，避免追得太急（T2.30）。 */
  private targetFocus: LookAtPoint = { x: 0, y: 0 };
  private currentFocus: LookAtPoint = { x: 0, y: 0 };
  /** 骨骼微调：参数 id → 正在进行的增量（毫秒级正弦凸起，播完自动删，T2.41）。 */
  private readonly bones = new Map<string, { value: number; startAt: number; ms: number }>();
  /** 视线回正的延时器（光标出窗后先「注意」一会儿）。 */
  private relaxTimer: ReturnType<typeof setTimeout> | null = null;
  /** 满帧窗口的截止时刻（performance.now 时间轴）；过了就降到 IDLE_MAX_FPS。 */
  private activeUntil = 0;
  /** 当前生效的帧率上限；-1 表示还没设过，首帧由 governFps 落一个值。 */
  private appliedFps = -1;
  /** 用户在设置里选的帧率上限（T2.43）；默认档位与引入设置之前的手感一致。 */
  private maxFps: number = UI_FPS_DEFAULT;
  /** 参数名 → index 的缓存（第一次用到时扫一遍模型参数表）。 */
  private parameterIndices: Map<string, number> | null = null;
  /** 动态命中形状（部位 id → 外接框）：由网格顶点现算，跟着动作走（T2.42）。 */
  private readonly dynamicShapes = new Map<string, Shape>();
  private dynamicShapesAt = 0;
  /** 上一帧命中的部位：交界处做迟滞。 */
  private lastRegionId: string | null = null;

  private constructor(
    mount: HTMLElement,
    app: Application,
    model: Live2DModel,
    regions: readonly CharHitRegion[],
    hitBox: readonly [number, number, number, number],
    originalWidth: number,
    originalHeight: number,
    lookAtOrigin: readonly [number, number],
  ) {
    this.mount = mount;
    this.app = app;
    this.model = model;
    this.regions = regions;
    this.hitBox = hitBox;
    this.originalWidth = originalWidth;
    this.originalHeight = originalHeight;
    this.lookAtOrigin = lookAtOrigin;
    this.model.anchor.set(0.5, 0.5);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(mount);
    this.fit();
    this.app.ticker.add(this.tickFocus);
    this.appliedFps = Math.min(this.maxFps, IDLE_MAX_FPS);
    this.app.ticker.maxFPS = this.appliedFps;
    // 最后一步参数写入点：动作 / 表情 / 眨眼 / 呼吸 / 物理 / 焦点都算完之后再叠加骨骼增量
    this.model.internalModel?.on("beforeModelUpdate", this.applyBones);
  }

  static isAvailable(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof (window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore !== "undefined"
    );
  }

  static async create(
    host: StageHost,
    mount: HTMLElement,
    charId: string,
    plan: StagePlan,
  ): Promise<Live2dStage> {
    if (plan.model === null || plan.model.trim() === "") {
      throw new Error("Live2D 角色缺少 appearance.model");
    }
    const app = new Application();
    await app.init({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      powerPreference: "high-performance",
    });
    try {
      const url = modelUrl(charId, plan.model);
      const model = await Live2DModel.from(url, {
        ticker: app.ticker,
        autoHitTest: false,
        autoFocus: false,
      });
      const internalModel = model.internalModel;
      if (internalModel === undefined) {
        throw new Error("Live2D 模型没有 internalModel");
      }
      // 贴图是 4096 的整张图集，实际只画到几百像素（约 10× 缩小）：只开双线性会把 1–2px 的
      // 描边和发丝高光抽成一串串散点（脸颊、头发上可见）。开 mipmap 让 GPU 按缩小的层级采样。
      for (const texture of model.textures) {
        texture.source.autoGenerateMipmaps = true;
        texture.source.scaleMode = "linear";
        texture.source.mipmapFilter = "linear";
      }
      model.setRenderer(app.renderer);
      app.stage.addChild(model);
      const canvas = app.canvas;
      canvas.className = "live2d-canvas";
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.pointerEvents = "none";
      mount.append(canvas);
      const hits = await host.hits(charId);
      const stage = new Live2dStage(
        mount,
        app,
        model,
        hits.regions,
        plan.hitBox ?? FALLBACK_HIT_BOX,
        internalModel.originalWidth,
        internalModel.originalHeight,
        hits.look_at_origin ?? DEFAULT_LOOK_AT_ORIGIN,
      );
      stage.setPlan(plan);
      // 参数快照：真机调参时在 DevTools 里敲 window.__deskpetParams()（不影响正常路径）
      (window as Window & { __deskpetParams?: () => unknown }).__deskpetParams = () =>
        parameterSnapshot(model);
      // 命中框快照：真机核对「框到底落在哪儿」（不影响正常路径）
      (window as Window & { __deskpetHits?: () => unknown }).__deskpetHits = () =>
        stage.hitSnapshot();
      // 帧率快照：真机核对「设置档位有没有落到 ticker 上」（不影响正常路径）
      (window as Window & { __deskpetFps?: () => unknown }).__deskpetFps = () =>
        stage.fpsSnapshot();
      host.onSizeChanged();
      void model.motion("Idle").catch(() => undefined);
      return stage;
    } catch (error) {
      app.destroy(true);
      throw error;
    }
  }

  metrics(): StageSize | null {
    return this.originalWidth > 0 && this.originalHeight > 0
      ? { width: this.originalWidth, height: this.originalHeight }
      : null;
  }

  containsPoint(clientX: number, clientY: number): boolean {
    return this.modelPoint(clientX, clientY) !== null;
  }

  hasRegions(): boolean {
    return this.regions.length > 0;
  }

  regionAt(clientX: number, clientY: number): TouchRegion | null {
    const point = this.modelPoint(clientX, clientY);
    if (point === null) {
      return null;
    }
    const [bx, by, bw, bh] = this.hitBox;
    if (bw <= 0 || bh <= 0) {
      return null;
    }
    const region = resolveHit(this.regions, (point.x - bx) / bw, (point.y - by) / bh, {
      dynamic: this.dynamicShapeMap(Date.now()),
      previousId: this.lastRegionId,
    });
    this.lastRegionId = region === null ? null : region.id;
    return region === null ? null : { id: region.id, name: region.name };
  }

  pulse(): void {
    this.noteActivity();
    const canvas = this.app.canvas;
    canvas.classList.remove("live2d-pulse");
    void canvas.offsetWidth;
    canvas.classList.add("live2d-pulse");
    if (this.pulseTimer !== null) {
      window.clearTimeout(this.pulseTimer);
    }
    this.pulseTimer = window.setTimeout(() => {
      canvas.classList.remove("live2d-pulse");
      this.pulseTimer = null;
    }, PULSE_DURATION_MS);
  }

  /**
   * 视线跟随（T2.27 / T2.28）：主进程给的是主窗内容区坐标，可能落在窗口外。
   *
   * 先把客户端坐标换算成模型画布 0–1 坐标，再以 lookAtOrigin（默认脸部）为支点；
   * 不再用 `model.focus()`，因为它固定以画布中心为原点、而且总是满幅转头。
   */
  lookAt(clientX: number, clientY: number): void {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return;
    }
    const width = this.originalWidth * this.renderScale;
    const height = this.originalHeight * this.renderScale;
    if (width <= 0 || height <= 0) {
      return;
    }
    this.noteActivity();
    const rect = this.mount.getBoundingClientRect();
    this.lastLook = {
      x: (clientX - rect.left - this.renderLeft) / width,
      y: (clientY - rect.top - this.renderTop) / height,
    };
    this.applyFocus();
  }

  /** 每帧把 currentFocus 缓动到 targetFocus，再交给 Live2D 的 focusController。 */
  private readonly tickFocus = (ticker: { deltaMS: number }): void => {
    this.governFps();
    const next = smoothFocus(this.currentFocus, this.targetFocus, clampDelta(ticker.deltaMS));
    if (
      Math.abs(this.targetFocus.x - next.x) < 0.0005 &&
      Math.abs(this.targetFocus.y - next.y) < 0.0005
    ) {
      this.currentFocus = { ...this.targetFocus };
    } else {
      this.currentFocus = next;
    }
    this.model.internalModel?.focusController.focus(this.currentFocus.x, this.currentFocus.y);
  };

  /**
   * 设置帧率上限（T2.43）：设置窗改完由 index.ts 推下来，下一次 tick 生效。
   *
   * 用整帧上限而不是「降到 min(maxFps, 30)」：交互期间必须跑满用户选的档位，
   * 空闲期间再降一档省电——两段行为都由这一个值推出来，不另存一份状态。
   */
  /** 当前帧率上限与正在生效的值（真机排查用；见 window.__deskpetFps）。 */
  fpsSnapshot(): { max: number; applied: number } {
    return { max: this.maxFps, applied: this.appliedFps };
  }

  setMaxFps(fps: number): void {
    if (!Number.isFinite(fps) || fps <= 0) {
      return;
    }
    this.maxFps = Math.round(fps);
    this.governFps();
  }

  /**
   * 空闲降帧、交互满帧（T2.43）。
   *
   * 为什么要做：桌宠是常驻窗口，Live2D 每帧都要做蒙皮 + 物理 + 合成，实测可见状态下
   * 60fps 空转会吃掉约 0.8 个核。空闲降到 30fps 体感几乎不变（呼吸与眨眼都是慢动作）。
   * 用户把档位设成 15 时，空闲与交互都按 15 走（不再往下降）。
   */
  private governFps(): void {
    const wanted =
      performance.now() < this.activeUntil ? this.maxFps : Math.min(this.maxFps, IDLE_MAX_FPS);
    if (wanted !== this.appliedFps) {
      this.appliedFps = wanted;
      this.app.ticker.maxFPS = wanted;
    }
  }

  /** 记一次交互：接下来 ACTIVE_WINDOW_MS 内保持满帧。 */
  private noteActivity(): void {
    this.activeUntil = performance.now() + ACTIVE_WINDOW_MS;
  }

  setExpression(tag: string | null): void {
    this.noteActivity();
    const name = tag === null ? null : (this.planExpression(tag) ?? null);
    if (name === null) {
      this.model.internalModel?.motionManager.expressionManager?.resetExpression();
      return;
    }
    void this.model.expression(name).catch(() => undefined);
  }

  playAct(act: string | null): void {
    if (act === null || act === "") {
      return;
    }
    this.noteActivity();
    const group = this.planMotion(act);
    if (group === null) {
      return;
    }
    void this.model.motion(group, 0).catch(() => undefined);
  }

  /** 部位主题色（hits.json 的 color）；没有这个部位返回 null。 */
  regionColor(regionId: string): string | null {
    return this.regions.find((region) => region.id === regionId)?.color ?? null;
  }

  /**
   * 骨骼级微调：在当帧数值上「加」一个按正弦凸起衰减的增量。
   *
   * 为什么是加不是设：呼吸与焦点每帧都在写 AngleX/Y/Z 与 BodyAngleX，直接设会被覆盖；
   * 加法能叠在它们上面。眼睛类参数（1 = 睁）传负值就是闭眼。
   */
  nudgeBone(id: string, value: number, ms = 400): void {
    if (id === "" || !Number.isFinite(value) || value === 0) {
      return;
    }
    this.noteActivity();
    this.bones.set(id, { value, startAt: performance.now(), ms: Math.max(1, ms) });
  }

  /** 光标出窗后先保持一会儿「注意」，delayMs 到点再把视线缓回正前方（T2.41）。 */
  relaxLook(delayMs = 0): void {
    this.noteActivity();
    if (this.relaxTimer !== null) {
      clearTimeout(this.relaxTimer);
      this.relaxTimer = null;
    }
    const relax = (): void => {
      this.relaxTimer = null;
      this.lastLook = null;
      this.targetFocus = { x: 0, y: 0 };
    };
    if (delayMs <= 0) {
      relax();
      return;
    }
    this.relaxTimer = setTimeout(relax, delayMs);
  }

  /**
   * 参数名 → index。
   *
   * 库的 addParameterValueById 要 CubismId 句柄（得经 CubismFramework 造），
   * 而 CubismFramework 没写进 .d.ts；所以这里反查 index 再加值，绕开这个依赖。
   */
  private parameterIndexOf(core: CubismParameterApi, id: string): number {
    if (this.parameterIndices === null) {
      this.parameterIndices = parameterIndexMap(core);
    }
    return this.parameterIndices.get(id) ?? -1;
  }

  /** 每帧最后一个写入点：把还活着的骨骼增量叠加到 Cubism 参数上。 */
  private readonly applyBones = (): void => {
    if (this.bones.size === 0) {
      return;
    }
    const core = this.model.internalModel?.coreModel as CubismParameterApi | undefined;
    if (core === undefined) {
      this.bones.clear();
      return;
    }
    const now = performance.now();
    for (const [id, nudge] of this.bones) {
      const progress = (now - nudge.startAt) / nudge.ms;
      if (progress >= 1) {
        this.bones.delete(id);
        continue;
      }
      const index = this.parameterIndexOf(core, id);
      if (index < 0) {
        // 这个角色的模型没有该参数：删掉，省得每帧空转
        this.bones.delete(id);
        continue;
      }
      // sin 凸起：0 → 1 → 0，起手和收尾都平滑，不会「啪」一下弹过去
      core.addParameterValueByIndex(index, nudge.value * Math.sin(Math.PI * Math.max(0, progress)));
    }
  };

  destroy(): void {
    this.resizeObserver.disconnect();
    this.app.ticker.remove(this.tickFocus);
    this.model.internalModel?.off("beforeModelUpdate", this.applyBones);
    if (this.relaxTimer !== null) {
      clearTimeout(this.relaxTimer);
      this.relaxTimer = null;
    }
    this.bones.clear();
    this.parameterIndices = null;
    if (this.pulseTimer !== null) {
      window.clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.model.destroy();
    this.app.destroy(true);
  }

  private planExpression(tag: string): string | null {
    return this.expressions.get(tag) ?? null;
  }

  private planMotion(act: string): string | null {
    return this.motions.get(act) ?? null;
  }

  private readonly expressions = new Map<string, string>();
  private readonly motions = new Map<string, string>();

  /** 由 create 填充；放在字段声明后避免构造参数过长。 */
  setPlan(plan: StagePlan): void {
    this.expressions.clear();
    this.motions.clear();
    for (const [key, value] of Object.entries(plan.expressions)) {
      this.expressions.set(key, value);
    }
    for (const [key, value] of Object.entries(plan.motions)) {
      this.motions.set(key, value);
    }
    for (const [key, target] of Object.entries(plan.acts)) {
      if (target.live2d !== null && target.live2d !== "") {
        this.motions.set(key, target.live2d);
      }
    }
  }

  private fit(): void {
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }
    this.app.renderer.resize(width, height);
    const scale = Math.min(width / this.originalWidth, height / this.originalHeight);
    this.renderScale = scale;
    this.renderLeft = (width - this.originalWidth * scale) / 2;
    this.renderTop = (height - this.originalHeight * scale) / 2;
    this.model.scale.set(scale);
    this.model.position.set(width / 2, height / 2);
    this.applyFocus();
  }

  /** 把最近一次画布归一化坐标换算成目标 focus；实际缓动在 tickFocus 里做。 */
  private applyFocus(): void {
    if (this.lastLook === null) {
      return;
    }
    this.targetFocus = focusFromLookAt(this.lastLook, this.lookAtOrigin);
  }

  /**
   * 动态命中形状：把部位绑定的网格顶点取出来算外接框（T2.42）。
   *
   * 坐标：getDrawableVertices 给的是模型画布像素（y 向下），除以 originalWidth/Height
   * 得到 0–1，再按 hitBox 归一化，与 hits.json 的 rect 同一坐标系。
   * 每 DYNAMIC_SHAPE_MIN_MS 最多重算一次；某个网格 id 在 moc3 里不存在时跳过并退回静态形状。
   */
  private dynamicShapeMap(now: number): ReadonlyMap<string, Shape> | null {
    const internal = this.model.internalModel as unknown as DrawableGeometrySource | undefined;
    if (internal === undefined || typeof internal.getDrawableVertices !== "function") {
      return null;
    }
    if (now - this.dynamicShapesAt < DYNAMIC_SHAPE_MIN_MS) {
      return this.dynamicShapes.size === 0 ? null : this.dynamicShapes;
    }
    this.dynamicShapesAt = now;
    this.dynamicShapes.clear();
    const layout = { width: this.originalWidth, height: this.originalHeight, hitBox: this.hitBox };
    for (const region of this.regions) {
      const drawables = region.drawables;
      if (drawables === undefined || drawables.length === 0) {
        continue;
      }
      const box = meshBoxOf(internal, drawables, layout);
      if (box === null) {
        continue;
      }
      const shape = clampToAuthored(region, box);
      if (shape !== null) {
        this.dynamicShapes.set(region.id, shape);
      }
    }
    return this.dynamicShapes.size === 0 ? null : this.dynamicShapes;
  }

  /** 调试用：每个部位当前的命中形状（动态形状优先，退回 hits.json 的静态形状）。 */
  hitSnapshot(): { id: string; shape: Shape }[] {
    const dynamic = this.dynamicShapeMap(Date.now());
    return this.regions.map((region) => ({
      id: region.id,
      shape: dynamic?.get(region.id) ?? shapeOf(region),
    }));
  }

  /**
   * 按网格 id 算外接框（T2.44，给角色包编辑器「按模型网格生成部位」用）。
   *
   * 与 dynamicShapeMap 的区别：这里**不做作者框夹取**，因为目的就是拿到网格真实范围去生成
   * 一个以前不存在的框；只把结果夹进 0–1，保证生成出来的 rect 落在画布内。
   */
  drawableBounds(ids: readonly string[]): Record<string, [number, number, number, number]> | null {
    const internal = this.model.internalModel as unknown as DrawableGeometrySource | undefined;
    const layout = { width: this.originalWidth, height: this.originalHeight, hitBox: this.hitBox };
    const bounds: Record<string, [number, number, number, number]> = {};
    for (const id of ids) {
      const box = meshBoxOf(internal, [id], layout);
      if (box === null) {
        continue;
      }
      const clamped = clampBox(box);
      if (clamped === null) {
        continue;
      }
      bounds[id] = clamped;
    }
    return Object.keys(bounds).length === 0 ? null : bounds;
  }

  /** 客户端坐标 → 原始模型画布 0–1 坐标；点不在模型画布内返回 null。 */
  private modelPoint(clientX: number, clientY: number): ModelPoint | null {
    const rect = this.mount.getBoundingClientRect();
    const width = this.originalWidth * this.renderScale;
    const height = this.originalHeight * this.renderScale;
    if (width <= 0 || height <= 0) {
      return null;
    }
    const x = (clientX - rect.left - this.renderLeft) / width;
    const y = (clientY - rect.top - this.renderTop) / height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }
}

/** 夹进 0–1 并转成 hits.json 的 [x, y, w, h]；夹完没有面积就返回 null。 */
function clampBox(box: MeshBox): [number, number, number, number] | null {
  const x0 = clampUnit(box.x);
  const y0 = clampUnit(box.y);
  const x1 = clampUnit(box.x + box.w);
  const y1 = clampUnit(box.y + box.h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) {
    return null;
  }
  return [x0, y0, x1 - x0, y1 - y0];
}
