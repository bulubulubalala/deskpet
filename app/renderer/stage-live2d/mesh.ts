/**
 * 文件职责：把 Live2D 网格顶点折算成归一化外接框（T2.42 / T2.44）。
 *
 * 为什么单独一层：算「这组网格现在在画布哪儿」这件事有两处要用——动态命中框（跟着动作走）
 * 与角色包编辑器的「按网格生成部位」。原来的两段代码各自抄了一遍顶点扫描，坐标换算式子
 * 一模一样却分别维护。这里只做纯数学：给一个能取顶点的对象，还你一个 0–1 坐标的矩形。
 * 依赖方向：不 import pixi / DOM，只有几何；谁喂数据谁负责，因此可以在 node 里直接单测。
 */

/** Live2D 内部模型里我们真正用到的能力（库的 .d.ts 没有导出 InternalModel）。 */
export interface DrawableGeometrySource {
  getDrawableVertices(drawableIndexOrId: number | string): ArrayLike<number>;
}

/** 命中框：模型画布像素坐标里的可视区域（hits.json 的 hit_box）。 */
export type HitFrame = readonly [number, number, number, number];

/** 归一化矩形；**可能超出 0–1**，夹取交给调用方决定（命中要夹作者框，生成部位要夹画布）。 */
export interface MeshBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 夹到 0–1；NaN 当 0（网格顶点理论上不会是 NaN，但别让它变成 NaN 的矩形）。 */
export function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * 取若干网格的并集外接框。
 *
 * 坐标：`getDrawableVertices` 给的是模型画布像素（y 向下），先除以 originalWidth/Height 归一化，
 * 再按 hitBox 平移缩放，得到与 hits.json 的 rect 同一坐标系。
 * 顶点为空、网格 id 在 moc3 里不存在（库会抛）、宽高不合法时返回 null，调用方退回静态形状。
 */
export function meshBoxOf(
  source: DrawableGeometrySource | undefined,
  drawables: readonly string[],
  layout: { width: number; height: number; hitBox: HitFrame },
): MeshBox | null {
  if (source === undefined || typeof source.getDrawableVertices !== "function") {
    return null;
  }
  const { width, height, hitBox } = layout;
  const [bx, by, bw, bh] = hitBox;
  if (width <= 0 || height <= 0 || bw <= 0 || bh <= 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const drawable of drawables) {
    let vertices: ArrayLike<number>;
    try {
      vertices = source.getDrawableVertices(drawable);
    } catch {
      continue;
    }
    for (let index = 0; index + 1 < vertices.length; index += 2) {
      const x = (vertices[index] ?? 0) / width;
      const y = (vertices[index + 1] ?? 0) / height;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxY) || maxX <= minX || maxY <= minY) {
    return null;
  }
  return {
    x: (minX - bx) / bw,
    y: (minY - by) / bh,
    w: (maxX - minX) / bw,
    h: (maxY - minY) / bh,
  };
}
