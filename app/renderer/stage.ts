/**
 * 文件职责：形象舞台的抽象层——渲染层不再直接碰 <img>，一律经 StageAdapter 画立绘（T2.4）。
 *
 * 为什么要有这层：F1/D10 要求 PNG 与 Live2D 可换；把「怎么画」收进适配器，M3 接 Live2D
 * 时只加一个实现，index.ts 的聊天 / 拖动 / 触摸逻辑一行不用改。
 * 依赖方向：renderer 内部；适配器从本模块拿类型，本模块的工厂负责按 appearance 选实现。
 * 谁调用：app/renderer/index.ts（换角色时 createStage，之后只调接口）。
 */
import type {
  CharacterAppearance,
  CharacterHitsResponse,
  TouchRegion,
} from "../shared/contracts/ipc";
import { normalizeAppearance } from "./stage-appearance";
import { Live2dStage } from "./stage-live2d";
import { PngStage } from "./stage-png";

/** 立绘包围盒（原始像素）；主进程据此算窗口尺寸（§6.11）。 */
export interface StageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 舞台与外界的注入接口：素材怎么读、尺寸变了通知谁。
 *
 * 为什么注入而不是直接调 window.deskpet：舞台本身是纯渲染逻辑，测试 / 复用时不绑死 IPC；
 * 具体实现见 index.ts 里的 host。
 */
export interface StageHost {
  /** 读角色包立绘 → data URL；null 表示这个包没有立绘，用内置占位图。 */
  portrait(charId: string): Promise<string | null>;
  /** 读部位定义（0–1 归一化框）与视觉原点。 */
  hits(charId: string): Promise<CharacterHitsResponse>;
  /** 读形象配置（决定用哪个实现、怎么播动作）。 */
  appearance(charId: string): Promise<CharacterAppearance | null>;
  /** 立绘尺寸就绪 / 变化——调用方据此重算窗口尺寸。 */
  onSizeChanged(): void;
}

/** 一个可替换的形象舞台实现。 */
export interface StageAdapter {
  readonly kind: "png" | "live2d";
  /** 立绘原始像素尺寸；还没加载出来返回 null（窗口尺寸保持上一次的值）。 */
  metrics(): StageSize | null;
  /** 点是否落在立绘矩形内（拖动与触摸的分界，T2.3-C2c）。 */
  containsPoint(clientX: number, clientY: number): boolean;
  /** 命中哪个部位；没画部位 / 点在框外返回 null。 */
  regionAt(clientX: number, clientY: number): TouchRegion | null;
  /** 角色包有没有可用的部位框；互动模式据此提醒。 */
  hasRegions(): boolean;
  /** 触摸的无声反馈（脉冲 / 回弹）。 */
  pulse(): void;
  /** 渲染帧率上限（T2.43）：Live2D 用它限速；PNG 是静态图，空操作。 */
  setMaxFps(fps: number): void;
  /** 部位的主题色（涟漪 / 轨迹用它）；没有这个部位返回 null（T2.41）。 */
  regionColor(regionId: string): string | null;
  /**
   * 按网格 id 算外接框（T2.44，供编辑器「按模型网格生成部位」用）：
   * 返回的 rect 是 0–1 命中坐标（已按 hit_box 归一）。PNG 舞台没有网格，返回 null。
   */
  drawableBounds(ids: readonly string[]): Record<string, [number, number, number, number]> | null;
  /** 骨骼级微调：在当帧数值上叠加增量（Live2D 参数；PNG 空操作）。 */
  nudgeBone(id: string, value: number, ms?: number): void;
  /** 松手 / 出窗后把视线缓回正前方；delayMs 是「还在看」的保持时间。 */
  relaxLook(delayMs?: number): void;
  /** 视线跟随（T2.27）：客户端坐标，可落在窗口外；PNG 实现为空操作。 */
  lookAt(clientX: number, clientY: number): void;
  /** 表情：PNG 实现暂只记录（本次只做动作动画），Live2D 实现真切表情。 */
  setExpression(tag: string | null, intensity?: number): void;
  /** 播一个动作（由台词事件的 act / 纯动作事件 a 驱动）。 */
  playAct(act: string | null): void;
  /** 拆掉自己建的 DOM；换角色前先调它。 */
  destroy(): void;
}

/**
 * 按 appearance.json 选实现并建好舞台。
 *
 * 回退规则（D10）：live2d / hybrid 且 Live2D 实现可用 → Live2D；否则一律 PNG
 * （live2d 包若给了 png_fallback，PNG 实现会优先用它，见 PngStage）。
 */
export async function createStage(
  host: StageHost,
  mount: HTMLElement,
  charId: string,
): Promise<StageAdapter> {
  const plan = normalizeAppearance(await host.appearance(charId));
  if (plan.kind === "live2d" && Live2dStage.isAvailable()) {
    try {
      return await Live2dStage.create(host, mount, charId, plan);
    } catch (error) {
      // 模型坏 / Core 版本不匹配 / 纹理缺失都退回 PNG，保证对话与拖动不受影响。
      console.warn("Live2D 加载失败，回退 PNG：" + String(error));
    }
  }
  return PngStage.create(host, mount, charId, plan);
}
