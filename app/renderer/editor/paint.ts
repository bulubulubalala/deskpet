/**
 * 文件职责：画布绘制：裁切框遮罩、部位轮廓、视觉原点、多边形草稿、悬停命中预览。
 *
 * 为什么单独一个文件：绘制只读状态不写状态，和拖拽逻辑分开后，可以单独调整视觉（粗细、颜色、字号）而不碰交互判断。
 * 依赖方向：renderer -> ./state（只读）+ ./constants + ./geometry + ./dom + ./canvas（纯渲染，不 import ./crop 或 ./regions）。
 */

import { shapeOf } from "../hit";
import { fitCanvas } from "./canvas";
import { asCanvas, context } from "./dom";
import { editorState } from "./state";
import {
  clamp,
  clonePoint,
  HANDLE_PX,
  regionRect,
  round4,
  traceShape,
  type Point,
  type Rect,
} from "./geometry";

/** 原点夹到画布内并保留四位小数；靠近建议位置时轻微吸附，方便放回脸中心。 */
export function setLookAtOrigin(point: Point): void {
  const snap =
    Math.hypot(
      point.x - editorState.suggestedLookAtOrigin.x,
      point.y - editorState.suggestedLookAtOrigin.y,
    ) < 0.012;
  editorState.lookAtOrigin = snap
    ? clonePoint(editorState.suggestedLookAtOrigin)
    : { x: round4(clamp(point.x, 0, 1)), y: round4(clamp(point.y, 0, 1)) };
  updateOriginInfo();
}

export function updateOriginInfo(): void {
  if (editorState.originInfoNode === null) {
    return;
  }
  editorState.originInfoNode.textContent =
    "脸的视线支点 · X " +
    (editorState.lookAtOrigin.x * 100).toFixed(1) +
    "% · Y " +
    (editorState.lookAtOrigin.y * 100).toFixed(1) +
    "%";
}

export function drawCrop(): void {
  if (editorState.sourceImage === null) {
    return;
  }
  const canvas = asCanvas("crop-canvas");
  const width = editorState.sourceImage.naturalWidth;
  const height = editorState.sourceImage.naturalHeight;
  canvas.width = width;
  canvas.height = height;
  fitCanvas(canvas, width, height);
  const ctx = context(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(editorState.sourceImage, 0, 0);
  if (editorState.cropRect === null) {
    return;
  }
  const rect = editorState.cropRect;
  ctx.save();
  ctx.fillStyle = "rgba(10, 12, 16, 0.55)";
  ctx.fillRect(0, 0, width, rect.y);
  ctx.fillRect(0, rect.y + rect.h, width, Math.max(0, height - rect.y - rect.h));
  ctx.fillRect(0, rect.y, rect.x, rect.h);
  ctx.fillRect(rect.x + rect.w, rect.y, Math.max(0, width - rect.x - rect.w), rect.h);
  ctx.restore();
  const handle = Math.max(HANDLE_PX, width / 50);
  ctx.save();
  ctx.strokeStyle = "#ffb347";
  ctx.lineWidth = Math.max(2, width / 300);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = "#ffb347";
  const corners: readonly Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ];
  for (const corner of corners) {
    ctx.fillRect(corner.x - handle / 2, corner.y - handle / 2, handle, handle);
  }
  ctx.restore();
}

export function clampCrop(rect: Rect): Rect {
  if (editorState.sourceImage === null) {
    return rect;
  }
  const width = editorState.sourceImage.naturalWidth;
  const height = editorState.sourceImage.naturalHeight;
  const x = clamp(rect.x, 0, width);
  const y = clamp(rect.y, 0, height);
  return { x, y, w: clamp(rect.w, 0, width - x), h: clamp(rect.h, 0, height - y) };
}

/** 画视觉原点：圆环 + 十字 + 标签；选中原点模式时再加虚线辅助线。 */
export function drawLookAtOrigin(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const x = editorState.lookAtOrigin.x * width;
  const y = editorState.lookAtOrigin.y * height;
  const radius = Math.max(10, width / 55);
  const color = editorState.originMode ? "#2f7d55" : "#238b8b";
  ctx.save();
  if (editorState.originMode) {
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "rgba(47, 125, 85, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.lineWidth = editorState.originMode ? 3 : 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = "rgba(255, 253, 249, 0.78)";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - radius * 1.9, y);
  ctx.lineTo(x + radius * 1.9, y);
  ctx.moveTo(x, y - radius * 1.9);
  ctx.lineTo(x, y + radius * 1.9);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2, radius * 0.2), 0, Math.PI * 2);
  ctx.fill();
  ctx.font = String(Math.max(12, Math.round(width / 42))) + "px Microsoft YaHei, sans-serif";
  ctx.fillText("视线", x + radius + 6, y + radius * 0.35);
  ctx.restore();
}

export function drawRegions(): void {
  if (editorState.croppedCanvas === null) {
    return;
  }
  const canvas = asCanvas("region-canvas");
  const width = editorState.croppedCanvas.width;
  const height = editorState.croppedCanvas.height;
  canvas.width = width;
  canvas.height = height;
  fitCanvas(canvas, width, height);
  const ctx = context(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(editorState.croppedCanvas, 0, 0);
  editorState.regions.forEach((region, index) => {
    const [x = 0, y = 0] = region.rect;
    const active = index === editorState.activeRegion;
    const shape = shapeOf(region);
    ctx.save();
    ctx.globalAlpha = active ? 0.42 : 0.24;
    ctx.fillStyle = region.color;
    traceShape(ctx, shape, width, height);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = region.color;
    ctx.lineWidth = Math.max(2, width / 280) * (active ? 2 : 1);
    traceShape(ctx, shape, width, height);
    ctx.stroke();
    ctx.fillStyle = region.color;
    ctx.font = String(Math.max(12, Math.round(width / 32))) + "px Microsoft YaHei, sans-serif";
    ctx.fillText(region.name, x * width + 4, y * height + Math.max(14, width / 32));
    ctx.restore();
  });
  // 选中框的四角画小方块：提示「这里可以拖着改大小」
  const active = editorState.regions[editorState.activeRegion];
  if (active !== undefined) {
    const { x, y, w, h } = regionRect(active);
    const size = Math.max(8, width / 80);
    const corners: readonly (readonly [number, number])[] = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ];
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = active.color;
    ctx.lineWidth = 2;
    for (const [cx, cy] of corners) {
      const left = cx * width - size / 2;
      const top = cy * height - size / 2;
      ctx.fillRect(left, top, size, size);
      ctx.strokeRect(left, top, size, size);
    }
    ctx.restore();
  }
  drawPolyDraft(ctx, width, height);
  drawLookAtOrigin(ctx, width, height);
  drawHoverPreview(ctx, width, height);
  if (editorState.regionPending === null) {
    return;
  }
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    editorState.regionPending.x * width,
    editorState.regionPending.y * height,
    editorState.regionPending.w * width,
    editorState.regionPending.h * height,
  );
  ctx.restore();
}

/** 多边形草稿：已点顶点连成折线，最后一个点跟着鼠标走（双击 / Enter 结束）。 */
export function drawPolyDraft(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  if (editorState.polyPoints.length === 0) {
    return;
  }
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  editorState.polyPoints.forEach((point, index) => {
    const x = point.x * width;
    const y = point.y * height;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  if (editorState.hoverPoint !== null) {
    ctx.lineTo(editorState.hoverPoint.x * width, editorState.hoverPoint.y * height);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  for (const point of editorState.polyPoints) {
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 命中预览：鼠标停在哪个部位上，就用白虚线描一遍并写出「命中：名字」。 */
export function drawHoverPreview(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  if (
    editorState.hoverIndex < 0 ||
    editorState.regionDrag !== null ||
    editorState.originDrag ||
    editorState.regionStart !== null
  ) {
    return;
  }
  const region = editorState.regions[editorState.hoverIndex];
  if (region === undefined) {
    return;
  }
  const [x = 0, y = 0] = region.rect;
  ctx.save();
  ctx.setLineDash([8, 5]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  traceShape(ctx, shapeOf(region), width, height);
  ctx.stroke();
  ctx.setLineDash([]);
  const label = "命中：" + region.name;
  const fontSize = Math.max(12, Math.round(width / 34));
  ctx.font = String(fontSize) + "px Microsoft YaHei, sans-serif";
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(20, 20, 20, 0.72)";
  ctx.fillRect(x * width, y * height - fontSize - 8, textWidth + 14, fontSize + 8);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, x * width + 7, y * height - 8);
  ctx.restore();
}
