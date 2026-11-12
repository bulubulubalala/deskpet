/**
 * 文件职责：触摸命中的几何与归属（T2.42 重制）——形状、优先级、命中容差、跨帧迟滞、
 * 停留时长排序。纯几何 + 纯数据，不碰 DOM，也不认识 Live2D。
 *
 * 为什么单独一层：旧逻辑（char-hit.locateRegion）只会「矩形包含 → 面积最小」，角色抬手、
 * 转身、换姿势时坐标里的框就跟不上；12 个矩形又常常重叠，手指落在交界处会来回跳。
 * 现在拆成三件事：Shape 管「哪些点算命中」，resolveHit 管「命中了算谁」，HitDwell 管
 * 「这一串摸的是谁」。Live2D 把网格顶点算成动态形状喂进来，PNG 继续用 hits.json 的静态形状。
 */
import type { CharHitRegion } from "../shared/contracts/ipc";

/** 归一化坐标点（0–1，左上原点，与 hits.json 的 rect 同一坐标系）。 */
export type Point = readonly [number, number];

/** 矩形：x/y 左上角，w/h 宽高。 */
export interface RectShape {
  readonly kind: "rect";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 椭圆：x/y 左上角，w/h 外接矩形（内切椭圆）。 */
export interface EllipseShape {
  readonly kind: "ellipse";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 任意多边形（顶点按顺序给，不要求凸）。 */
export interface PolyShape {
  readonly kind: "poly";
  readonly points: readonly Point[];
}

export type Shape = RectShape | EllipseShape | PolyShape;

/** 形状的外接矩形。 */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 迟滞比例：新候选要比当前部位小 15% 以上才换，交界处才不会来回抖。 */
export const HIT_HYSTERESIS = 0.15;
/** 命中容差上限（归一化）：再大就一个部位吃掉整只角色了。 */
export const HIT_PADDING_MAX = 0.2;
/** 数值噪声容差：面积比较、包含判定都用它兜底。 */
const EPS = 1e-9;

export function rectShape(x: number, y: number, w: number, h: number): RectShape {
  return { kind: "rect", x, y, w, h };
}

export function polyShape(points: readonly Point[]): PolyShape {
  return { kind: "poly", points };
}

/**
 * hits.json 的一项 → 形状。
 *
 * shape 缺省 / 坏掉时退回 rect（v2 老数据照旧可用）；poly 少于 3 个点也退回 rect。
 */
export function shapeOf(region: CharHitRegion): Shape {
  const declared = region.shape;
  if (declared !== undefined) {
    if (declared.kind === "poly") {
      const points: Point[] = [];
      for (const point of declared.points ?? []) {
        if (point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
          points.push([point[0], point[1]]);
        }
      }
      if (points.length >= 3) {
        return { kind: "poly", points };
      }
    } else {
      const box = declared.rect;
      if (
        box !== undefined &&
        box.every((value) => Number.isFinite(value)) &&
        box[2] > EPS &&
        box[3] > EPS
      ) {
        return { kind: declared.kind, x: box[0], y: box[1], w: box[2], h: box[3] };
      }
    }
  }
  const [x, y, w, h] = region.rect;
  return { kind: "rect", x, y, w, h };
}

/** 外接矩形（poly 现算，矩形/椭圆直接给）。 */
export function shapeBounds(shape: Shape): Bounds {
  if (shape.kind !== "poly") {
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of shape.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 面积（归一化单位²）：区分重叠优先级时用它当「谁更贴手」。 */
export function shapeArea(shape: Shape): number {
  if (shape.kind !== "poly") {
    const area = Math.abs(shape.w * shape.h);
    return shape.kind === "ellipse" ? area * (Math.PI / 4) : area;
  }
  const points = shape.points;
  if (points.length < 3) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) {
      continue;
    }
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(sum) / 2;
}

/** 外接矩形中心。 */
export function shapeCenter(shape: Shape): Point {
  const bounds = shapeBounds(shape);
  return [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2];
}

/** 点是否在形状内（边界算内）。 */
export function shapeContains(shape: Shape, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  if (shape.kind === "rect") {
    return (
      x >= shape.x - EPS &&
      x <= shape.x + shape.w + EPS &&
      y >= shape.y - EPS &&
      y <= shape.y + shape.h + EPS
    );
  }
  if (shape.kind === "ellipse") {
    if (shape.w <= EPS || shape.h <= EPS) {
      return false;
    }
    const radiusX = shape.w / 2;
    const radiusY = shape.h / 2;
    const dx = (x - (shape.x + radiusX)) / radiusX;
    const dy = (y - (shape.y + radiusY)) / radiusY;
    return dx * dx + dy * dy <= 1 + EPS;
  }
  return polyContains(shape.points, x, y);
}

/** 容差命中：指腹压偏几像素也算点到（pad 以归一化单位给，内部夹到 0–HIT_PADDING_MAX）。 */
export function shapeContainsPadded(shape: Shape, x: number, y: number, padding: number): boolean {
  if (shapeContains(shape, x, y)) {
    return true;
  }
  const pad = clampPadding(padding);
  if (pad <= 0) {
    return false;
  }
  if (shape.kind === "poly") {
    return distanceToPath(shape.points, x, y) <= pad;
  }
  return shapeContains(inflate(shape, pad), x, y);
}

/** 把一个矩形/椭圆向外撑开 pad（poly 不在此列，用点到边距离判定）。 */
export function inflate(shape: RectShape | EllipseShape, padding: number): Shape {
  const pad = clampPadding(padding);
  return {
    kind: shape.kind,
    x: shape.x - pad,
    y: shape.y - pad,
    w: shape.w + pad * 2,
    h: shape.h + pad * 2,
  };
}

export interface ResolveHitOptions {
  /** 动态形状（部位 id → 形状），必须与静态形状同一坐标系；缺省回落到 hits.json 的形状。 */
  readonly dynamic?: ReadonlyMap<string, Shape> | null;
  /** 上一帧命中的部位 id：交界处用它做迟滞。 */
  readonly previousId?: string | null;
}

interface Candidate {
  readonly region: CharHitRegion;
  readonly area: number;
  readonly distance: number;
  readonly priority: number;
  readonly order: number;
}

/**
 * 一次点击落在哪些部位里、最终算谁。
 *
 * 判据顺序：priority 大的先（手/脸这种小部位可以压在身体大块上）→ 面积小的先 →
 * 中心近的先 → 后定义的先（老规则，方便「新框盖旧框」）。命中容差在包含判定里已经生效。
 * 迟滞：上一帧的部位仍是候选、且新候选没比它小 15% 以上时，保持上一帧的那个。
 */
export function resolveHit(
  regions: readonly CharHitRegion[],
  x: number,
  y: number,
  options: ResolveHitOptions = {},
): CharHitRegion | null {
  const dynamic = options.dynamic ?? null;
  const candidates: Candidate[] = [];
  regions.forEach((region, order) => {
    const shape = dynamic?.get(region.id) ?? shapeOf(region);
    const padding = region.padding ?? 0;
    if (!shapeContainsPadded(shape, x, y, padding)) {
      return;
    }
    const center = shapeCenter(shape);
    const dx = x - center[0];
    const dy = y - center[1];
    candidates.push({
      region,
      area: shapeArea(shape),
      distance: dx * dx + dy * dy,
      priority: region.priority ?? 0,
      order,
    });
  });
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort(compareCandidates);
  const best = candidates[0];
  if (best === undefined) {
    return null;
  }
  const previousId = options.previousId ?? null;
  if (previousId !== null && previousId !== best.region.id) {
    const previous = candidates.find((item) => item.region.id === previousId);
    if (
      previous !== undefined &&
      previous.priority === best.priority &&
      best.area > previous.area * (1 - HIT_HYSTERESIS)
    ) {
      return previous.region;
    }
  }
  return best.region;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  if (Math.abs(left.area - right.area) > EPS) {
    return left.area - right.area;
  }
  if (Math.abs(left.distance - right.distance) > EPS) {
    return left.distance - right.distance;
  }
  return right.order - left.order;
}

function clampPadding(padding: number): number {
  if (!Number.isFinite(padding) || padding <= 0) {
    return 0;
  }
  return Math.min(HIT_PADDING_MAX, padding);
}

/** 射线法：奇数次穿越算在内。 */
function polyContains(points: readonly Point[], x: number, y: number): boolean {
  if (points.length < 3) {
    return false;
  }
  let inside = false;
  for (
    let index = 0, previous = points.length - 1;
    index < points.length;
    previous = index, index += 1
  ) {
    const current = points[index];
    const last = points[previous];
    if (current === undefined || last === undefined) {
      continue;
    }
    const [xi, yi] = current;
    const [xj, yj] = last;
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || EPS) + xi;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点到多边形边界的最短距离（poly 的容差判定用）。 */
function distanceToPath(points: readonly Point[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (start === undefined || end === undefined) {
      continue;
    }
    const distance = distanceToSegment(start[0], start[1], end[0], end[1], x, y);
    if (distance < best) {
      best = distance;
    }
  }
  return best;
}

function distanceToSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x: number,
  y: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPS) {
    return Math.hypot(x - ax, y - ay);
  }
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * 一串触摸里「摸得最久的是谁」。
 *
 * 为什么需要：滑动会路过 3 个部位（arm → waist → hips），旧逻辑按经过顺序取前 3 个，
 * 角色可能对「路过 40ms 的胳膊」反应比对「按住 600ms 的腰」还大。按停留时长排序后，
 * 排第一的始终是手指真正停住的地方。
 */
export class HitDwell {
  private current: string | null = null;
  private lastAt = 0;
  private readonly totals = new Map<string, number>();

  /** 采样一次当前命中（null = 落在角色外，时间仍算给上一个部位）。 */
  sample(id: string | null, at: number): void {
    if (!Number.isFinite(at)) {
      return;
    }
    if (this.current !== null) {
      const delta = Math.max(0, at - this.lastAt);
      if (delta > 0) {
        this.totals.set(this.current, (this.totals.get(this.current) ?? 0) + delta);
      }
    }
    this.current = id;
    this.lastAt = at;
  }

  /** 停留时长从多到少；只含真正摸过的部位。 */
  rank(): string[] {
    return [...this.totals.entries()]
      .filter(([, ms]) => ms > 0)
      .sort((left, right) => right[1] - left[1])
      .map(([id]) => id);
  }

  /** 某部位累计停留（毫秒），没摸过是 0。 */
  milliseconds(id: string): number {
    return this.totals.get(id) ?? 0;
  }

  /** 当前指针停在哪个部位（还没结算）。 */
  get hovering(): string | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
    this.lastAt = 0;
    this.totals.clear();
  }
}
