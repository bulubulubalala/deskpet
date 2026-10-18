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

/** 命中哪个部位：按定义顺序取最后一个命中的（后定义的框叠在上面）。 */
export function locateRegion(
  regions: readonly CharHitRegion[],
  x: number,
  y: number,
): CharHitRegion | null {
  let found: CharHitRegion | null = null;
  for (const region of regions) {
    const [rx = 0, ry = 0, rw = 0, rh = 0] = region.rect;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
      found = region;
    }
  }
  return found;
}
