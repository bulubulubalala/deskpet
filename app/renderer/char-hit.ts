/**
 * 文件职责：立绘部位的纯几何（T2.3-C2，C2c 收窄），不碰 DOM，方便单测。
 *
 * 为什么单独一个文件：把「元素矩形 + 素材自然尺寸 → 点击落在哪个部位」这段换算钉死在单测里，
 * 真机点不准时先怀疑坐标，而不是怀疑窗口。手势分档已挪到 touch.ts（T2.3-C2c）。
 * 依赖方向：renderer 内部模块；只 import type（不 import main 的实现）。
 */
import type { CharHitRegion } from "../main/ipc";

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** object-fit: contain 下图片实际画在元素里的矩形（把点击坐标换算成素材归一化坐标）。 */
export function contentBox(
  rect: ElementRect,
  naturalWidth: number,
  naturalHeight: number,
): ElementRect | null {
  if (naturalWidth <= 0 || naturalHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

export function toNormalizedPoint(
  box: ElementRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}

/**
 * 命中哪个部位（T2.3-C2；T2.9 改重叠规则）。
 *
 * 几个框重叠时，按以下优先级选一个，保证结果稳定、可解释：
 * 1. **面积最小的框**优先（更具体的部位，例如耳朵盖住头）；
 * 2. 面积相同（容差内）时，**中心离点击最近**的优先；
 * 3. 仍相同则取**定义顺序靠后**的（后画的框，便于用户覆盖）。
 *
 * 为什么不是简单的「后定义覆盖」：编辑器里先画大头、再补耳朵时，后画的耳朵能赢；
 * 但如果后画了一个大框，简单后定义会把小部位整块吞掉，点耳朵反而命中头。
 */
export function locateRegion(
  regions: readonly CharHitRegion[],
  x: number,
  y: number,
): CharHitRegion | null {
  const EPS = 1e-9;
  let found: CharHitRegion | null = null;
  let foundArea = Number.POSITIVE_INFINITY;
  let foundDistance = Number.POSITIVE_INFINITY;
  for (const region of regions) {
    const [rx = 0, ry = 0, rw = 0, rh = 0] = region.rect;
    if (x < rx || x > rx + rw || y < ry || y > ry + rh) {
      continue;
    }
    const area = Math.max(0, rw) * Math.max(0, rh);
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    const distance = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    const sameArea = Math.abs(area - foundArea) <= EPS;
    const nearer = distance < foundDistance - EPS;
    const sameSpot = sameArea && Math.abs(distance - foundDistance) <= EPS;
    if (area < foundArea - EPS || (sameArea && (nearer || sameSpot))) {
      found = region;
      foundArea = area;
      foundDistance = distance;
    }
  }
  return found;
}
