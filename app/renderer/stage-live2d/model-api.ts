/**
 * 文件职责：Live2D 舞台用到的「模型外部接口」小工具——资源 URL、帧间隔夹取、Cubism 参数读写。
 *
 * 为什么单独一层：这三件事都依赖库的私有结构（coreModel、CubismId 三层句柄、自定义 scheme），
 * 与被拆出来的舞台逻辑无关，却最容易因为库升级而失效。放在一起，真机排查（`window.__deskpetParams()`）
 * 与运行时逻辑看同一份实现；同时它们是纯函数，能在 node 里用假对象单测。
 * 依赖方向：不 import pixi / DOM（只 import 类型），也不碰舞台状态。
 */

/** 角色素材的自定义协议：与主进程 character-asset-path.ts 的 URL 形状保持一致。 */
export const CHARACTER_ASSET_SCHEME = "deskpet-asset";

/** 模型画布坐标（0–1 之外的交给调用方判断）。 */
export interface ModelPoint {
  readonly x: number;
  readonly y: number;
}

/** 把 appearance.model 的相对路径拼成渲染层能加载的 URL；内部路径逐段编码。 */
export function modelUrl(charId: string, relative: string): string {
  const path = relative
    .split("/")
    .filter((part) => part !== "")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${CHARACTER_ASSET_SCHEME}://character/${encodeURIComponent(charId)}/${path}`;
}

/** 夹住 ticker 的帧间隔：切后台回来时不会一帧跳很远（>100ms 的缺口按 100 算）。 */
export function clampDelta(deltaMS: number): number {
  if (!Number.isFinite(deltaMS) || deltaMS <= 0) {
    return 16.7;
  }
  return Math.min(deltaMS, 100);
}

/**
 * Cubism 参数 API 的最小结构。
 *
 * 为什么自己 declare：库随包的 .d.ts 没导出 CubismModel / CubismFramework，
 * InternalModel.coreModel 只标成 object，直接调会被 TS 拦下。
 */
export interface CubismParameterApi {
  getParameterCount(): number;
  getParameterId(parameterIndex: number): unknown;
  getParameterMinimumValue(parameterIndex: number): number;
  getParameterMaximumValue(parameterIndex: number): number;
  getParameterValueByIndex(parameterIndex: number): number;
  addParameterValueByIndex(parameterIndex: number, value: number, weight?: number): void;
}

/** 能拿到 coreModel 的最小模型结构：只为参数快照服务，不需要整个 Live2DModel。 */
export interface ParameterProbeModel {
  readonly internalModel?: { readonly coreModel?: unknown } | undefined;
}

/** 从 Cubism 的 id 句柄里抠出参数名（句柄是 CubismId → csmString → string 三层）。 */
export function parameterName(handle: unknown): string {
  let current: unknown = handle;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === "string") {
      return current;
    }
    if (current === null || typeof current !== "object") {
      return "";
    }
    const record = current as { getString?: () => unknown; s?: unknown };
    current = typeof record.getString === "function" ? record.getString() : record.s;
  }
  return typeof current === "string" ? current : "";
}

/** 参数快照（调试用）：真机排查「歪头没反应」时先看参数在不在、范围多少。 */
export function parameterSnapshot(
  model: ParameterProbeModel,
): { id: string; min: number; max: number; value: number }[] | null {
  const core = model.internalModel?.coreModel as CubismParameterApi | undefined;
  if (core === undefined || core === null || typeof core.getParameterCount !== "function") {
    return null;
  }
  const count = core.getParameterCount();
  const snapshot: { id: string; min: number; max: number; value: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    snapshot.push({
      id: parameterName(core.getParameterId(index)),
      min: core.getParameterMinimumValue(index),
      max: core.getParameterMaximumValue(index),
      value: core.getParameterValueByIndex(index),
    });
  }
  return snapshot;
}

/**
 * 参数名 → 下标表；模型换了要重建（调用方负责缓存）。
 *
 * names 省略时收全表（同名字段取第一个），传 names 时只收这几个，省一次全量遍历。
 */
export function parameterIndexMap(
  core: CubismParameterApi,
  names?: readonly string[],
): Map<string, number> {
  const index = new Map<string, number>();
  const count = core.getParameterCount();
  for (let i = 0; i < count; i += 1) {
    const name = parameterName(core.getParameterId(i));
    if (name === "" || index.has(name)) {
      continue;
    }
    if (names === undefined || names.includes(name)) {
      index.set(name, i);
    }
  }
  return index;
}
