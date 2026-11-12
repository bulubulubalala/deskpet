/**
 * 文件职责：视觉原点（视线支点）的解析与建议值（T2.28）。
 *
 * 为什么放在 main 的纯逻辑里：原点既要从 hits.json 读，也要从 PSD2Live 的 faceRig 推导，
 * 编辑器还要拿到「建议放到脸部中心」的结果；这些都不该散在 IPC handler 或渲染层。
 * 依赖方向：main 内部纯函数，不 import electron / fs。
 */

export const DEFAULT_LOOK_AT_ORIGIN: readonly [number, number] = [0.5, 0.35];

export interface OriginRegion {
  readonly id: string;
  readonly name: string;
  readonly rect: readonly [number, number, number, number];
}

/** 从 model.psd2live.json 提取出的脸部中心（已归一化到 0–1）。 */
export interface FaceRigOrigin {
  readonly x: number;
  readonly y: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** hits.json 的 look_at_origin：两个有限数字且落在 0–1，否则视为没配。 */
export function normalizeLookAtOrigin(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const rawX: unknown = value[0];
  const rawY: unknown = value[1];
  if (typeof rawX !== "number" || typeof rawY !== "number") {
    return null;
  }
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
    return null;
  }
  return [clamp01(rawX), clamp01(rawY)];
}

/**
 * 从 PSD2Live 的 psd2live.json 读 faceRig.centerX / centerY。
 *
 * 当前角色模型由 PSD2Live 生成，faceRig 是自动绑定时算出的脸部中心；比起「头部框中心」
 * 更接近真正的眼睛/鼻梁位置。缺字段或数值不合法时返回 null，让调用方走区域兜底。
 */
export function faceRigOriginOf(raw: Record<string, unknown> | null): FaceRigOrigin | null {
  const canvas = raw?.["canvas"];
  const face = raw?.["faceRig"];
  if (!isRecord(canvas) || !isRecord(face)) {
    return null;
  }
  const width = canvas["width"];
  const height = canvas["height"];
  const centerX = face["centerX"];
  const centerY = face["centerY"];
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof centerX !== "number" ||
    typeof centerY !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(centerX) ||
    !Number.isFinite(centerY) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x: round4(clamp01(centerX / width)), y: round4(clamp01(centerY / height)) };
}

/**
 * 建议视觉原点，优先级：
 * 1. PSD2Live faceRig（脸部自动绑定中心）
 * 2. 名字 / id 看起来是「脸」的部位框中心
 * 3. 名字 / id 看起来是「头」的部位框中心
 * 4. 默认 [0.5, 0.35]
 */
export function suggestLookAtOrigin(
  regions: readonly OriginRegion[],
  faceRig: FaceRigOrigin | null,
): [number, number] {
  if (faceRig !== null) {
    return [round4(clamp01(faceRig.x)), round4(clamp01(faceRig.y))];
  }
  const face = findRegion(regions, isFaceRegion);
  const head = findRegion(regions, isHeadRegion);
  const region = face ?? head;
  if (region !== null) {
    const [x = 0, y = 0, w = 0, h = 0] = region.rect;
    return [round4(clamp01(x + w / 2)), round4(clamp01(y + h / 2))];
  }
  return [DEFAULT_LOOK_AT_ORIGIN[0], DEFAULT_LOOK_AT_ORIGIN[1]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRegion(
  regions: readonly OriginRegion[],
  predicate: (region: OriginRegion) => boolean,
): OriginRegion | null {
  for (const region of regions) {
    if (predicate(region)) {
      return region;
    }
  }
  return null;
}

function isFaceRegion(region: OriginRegion): boolean {
  const name = region.name.trim().toLowerCase();
  const id = region.id.trim().toLowerCase();
  return id === "face" || name.includes("脸") || name.includes("面");
}

function isHeadRegion(region: OriginRegion): boolean {
  const name = region.name.trim().toLowerCase();
  const id = region.id.trim().toLowerCase();
  return id === "head" || name.includes("头");
}
