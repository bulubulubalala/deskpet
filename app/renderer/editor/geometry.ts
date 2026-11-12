/**
 * 文件职责：角色包编辑器里的纯几何——矩形/多边形的换算、缩放、命中判定与描边。
 *
 * 为什么单独一个文件：这些函数只有数学，不碰 DOM 也不碰模块状态；编辑器最难查的 bug 就是
 * 「画出来的框和主窗点到的地方差一点」，把它集中在一处才能对着主窗那套坐标换算写单测。
 * 依赖方向：editor.ts -> 本文件 -> ./hit 的类型；本文件不读 DOM、不读全局变量。
 */
import type { CharHitShape, PackRegionDraft } from "../../shared/contracts/ipc";
import type { Shape } from "../hit";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 点住四角多少像素内算「改大小」。 */
export const HANDLE_PX = 14;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

export function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

/** 复制一份部位草稿（rect 是元组，必须新建数组，不能与快照共享引用）。 */
export function cloneRegions(list: readonly PackRegionDraft[]): PackRegionDraft[] {
  return list.map((region) => ({
    ...region,
    rect: [region.rect[0], region.rect[1], region.rect[2], region.rect[3]],
  }));
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

export function cornerAt(rect: Rect, point: Point, handle: number): string {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const nearLeft = Math.abs(point.x - rect.x) <= handle;
  const nearRight = Math.abs(point.x - right) <= handle;
  const nearTop = Math.abs(point.y - rect.y) <= handle;
  const nearBottom = Math.abs(point.y - bottom) <= handle;
  if (nearLeft && nearTop) return "nw";
  if (nearRight && nearTop) return "ne";
  if (nearLeft && nearBottom) return "sw";
  if (nearRight && nearBottom) return "se";
  return "";
}

export function resizeRect(origin: Rect, corner: string, point: Point): Rect {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;
  if (corner.startsWith("n")) {
    top = point.y;
  }
  if (corner.startsWith("s")) {
    bottom = point.y;
  }
  if (corner.endsWith("w")) {
    left = point.x;
  }
  if (corner.endsWith("e")) {
    right = point.x;
  }
  return normalizeRect({ x: left, y: top }, { x: right, y: bottom });
}

/** 部位草稿的 rect 元组 → 可变 Rect（绘制 / 拖拽都用这个形状）。 */
export function regionRect(region: PackRegionDraft): Rect {
  const [x = 0, y = 0, w = 0, h = 0] = region.rect;
  return { x, y, w, h };
}

/** Shape（判定用的判别联合）→ CharHitShape（落盘的扁平结构）。 */
export function toHitShape(shape: Shape): CharHitShape {
  return shape.kind === "poly"
    ? { kind: "poly", points: shape.points }
    : { kind: shape.kind, rect: [shape.x, shape.y, shape.w, shape.h] };
}

/** 形状跟着外接框一起变：矩形 / 椭圆换 rect，多边形按比例缩放每个顶点。 */
export function reshape(shape: Shape, from: Rect, to: Rect): Shape {
  if (shape.kind === "poly") {
    const sx = from.w > 0 ? to.w / from.w : 1;
    const sy = from.h > 0 ? to.h / from.h : 1;
    const points = shape.points.map(
      ([px, py]) =>
        [
          round4(clamp(to.x + (px - from.x) * sx, 0, 1)),
          round4(clamp(to.y + (py - from.y) * sy, 0, 1)),
        ] as const,
    );
    return { kind: "poly", points };
  }
  return shape.kind === "ellipse"
    ? { kind: "ellipse", x: to.x, y: to.y, w: to.w, h: to.h }
    : { kind: "rect", x: to.x, y: to.y, w: to.w, h: to.h };
}

/** 把形状描到画布上：矩形 / 椭圆 / 多边形走同一处，命中预览与列表也复用它。 */
export function traceShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  width: number,
  height: number,
): void {
  ctx.beginPath();
  if (shape.kind === "poly") {
    shape.points.forEach(([px, py], index) => {
      const x = px * width;
      const y = py * height;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.closePath();
    return;
  }
  const x = shape.x * width;
  const y = shape.y * height;
  const w = shape.w * width;
  const h = shape.h * height;
  if (shape.kind === "ellipse") {
    ctx.ellipse(
      x + w / 2,
      y + h / 2,
      Math.max(w / 2, 0.5),
      Math.max(h / 2, 0.5),
      0,
      0,
      Math.PI * 2,
    );
    return;
  }
  ctx.rect(x, y, w, h);
}

/** 归一化坐标下判断是否抓住四角（把矩形与点换回画布像素，复用裁切步骤的手柄判定）。 */
export function regionCornerAt(canvas: HTMLCanvasElement, rect: Rect, point: Point): string {
  const width = canvas.width;
  const height = canvas.height;
  return cornerAt(
    { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height },
    { x: point.x * width, y: point.y * height },
    HANDLE_PX,
  );
}

/** 归一化坐标下按角缩放（同样在像素空间算，避免宽高比例把容差拉歪）。 */
export function resizeRegionRect(
  canvas: HTMLCanvasElement,
  origin: Rect,
  corner: string,
  point: Point,
): Rect {
  const width = canvas.width;
  const height = canvas.height;
  const resized = resizeRect(
    { x: origin.x * width, y: origin.y * height, w: origin.w * width, h: origin.h * height },
    corner,
    { x: point.x * width, y: point.y * height },
  );
  return {
    x: resized.x / width,
    y: resized.y / height,
    w: resized.w / width,
    h: resized.h / height,
  };
}
