/**
 * 文件职责：PNG 形象舞台——把角色包立绘（data URL）画进舞台，并处理触摸命中与动作动画（T2.4）。
 *
 * 这是把原来写死在 index.ts 里的 <img id="character"> 行为原样搬进一个适配器：
 * 立绘 absolute 铺满立绘区（object-fit: contain，T2.3-C2 为部位点击改成 contain）、
 * 尺寸就绪后通知 host 重算窗口、命中换算复用 char-hit.ts 的纯几何。
 * 依赖方向：renderer 内部；char-hit（纯几何）+ ./stage-appearance（纯逻辑）+ ./stage（类型）。
 */
import type { CharHitRegion, TouchRegion } from "../main/ipc";
import { contentBox, locateRegion, toNormalizedPoint } from "./char-hit";
import { resolveEffect, type StagePlan } from "./stage-appearance";
import type { StageAdapter, StageHost, StageSize } from "./stage";

/** 动作动画的时长（毫秒）：与 style.css 的 act-* keyframes 对齐。 */
const ACT_DURATION_MS = 560;
/** 触摸脉冲时长（毫秒）：与 .character.touch-pulse 对齐。 */
const PULSE_DURATION_MS = 320;
/** 没有立绘时的内置占位图。 */
const PLACEHOLDER_SRC = "assets/placeholder.png";

export class PngStage implements StageAdapter {
  readonly kind = "png";

  private constructor(
    private readonly regions: readonly CharHitRegion[],
    private readonly plan: StagePlan,
    private readonly image: HTMLImageElement,
  ) {}

  /** 建 <img>、读立绘与部位、挂到 mount 上；加载完成时通知 host 重算尺寸。 */
  static async create(
    host: StageHost,
    mount: HTMLElement,
    charId: string,
    plan: StagePlan,
  ): Promise<PngStage> {
    const image = document.createElement("img");
    image.className = "character";
    image.alt = "角色立绘";
    image.draggable = false;
    const regions = await host.hits(charId);
    const stage = new PngStage(regions, plan, image);
    image.addEventListener("load", () => host.onSizeChanged());
    mount.append(image);
    const portrait = await host.portrait(charId);
    // live2d 包缺 model 时的回退（D10）由 png_fallback 指定；主进程的立绘通道已解到 portrait，
    // 这里先用它兜底，png_fallback 的精确解析随 M3 的 Live2D 实现一起补。
    image.src = portrait ?? PLACEHOLDER_SRC;
    return stage;
  }

  metrics(): StageSize | null {
    if (this.image.naturalWidth <= 0 || this.image.naturalHeight <= 0) {
      return null;
    }
    return { width: this.image.naturalWidth, height: this.image.naturalHeight };
  }

  containsPoint(clientX: number, clientY: number): boolean {
    return this.normalizedPoint(clientX, clientY) !== null;
  }

  hasRegions(): boolean {
    return this.regions.length > 0;
  }

  regionAt(clientX: number, clientY: number): TouchRegion | null {
    const point = this.normalizedPoint(clientX, clientY);
    if (point === null) {
      return null;
    }
    const region = locateRegion(this.regions, point.x, point.y);
    return region === null ? null : { id: region.id, name: region.name };
  }

  pulse(): void {
    this.restart("touch-pulse", PULSE_DURATION_MS);
  }

  setExpression(tag: string | null, intensity = 0.5): void {
    // 本次只做动作动画，不切表情图：把情绪记到元素上（M3 切图 / 调试时能直接看到），
    // 不产生任何视觉变化。
    if (tag === null) {
      this.image.removeAttribute("data-expression");
      return;
    }
    this.image.dataset["expression"] = tag;
    this.image.dataset["expressionIntensity"] = String(intensity);
  }

  playAct(act: string | null): void {
    const effect = resolveEffect(this.plan, act);
    if (effect === null) {
      return;
    }
    this.restart("act-" + effect, ACT_DURATION_MS);
  }

  destroy(): void {
    this.image.remove();
  }

  /** 点击坐标 → 素材归一化坐标；点在立绘画面矩形之外返回 null。 */
  private normalizedPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const box = contentBox(
      this.image.getBoundingClientRect(),
      this.image.naturalWidth,
      this.image.naturalHeight,
    );
    if (box === null) {
      return null;
    }
    return toNormalizedPoint(box, clientX, clientY);
  }

  /**
   * 重放一个一次性 CSS 动画类：先移除、强制回流、再加回，短时间连点也要能重新触发。
   * 时长到点自动移除，避免类一直挂着（下次 playAct 时再叠）。
   */
  private restart(className: string, durationMs: number): void {
    this.image.classList.remove(className);
    void this.image.offsetWidth;
    this.image.classList.add(className);
    window.setTimeout(() => this.image.classList.remove(className), durationMs);
  }
}
