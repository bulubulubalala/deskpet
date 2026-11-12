/**
 * 文件职责：画布坐标换算与图片装载：鼠标位置 ↔ 素材像素 / 归一化坐标。
 *
 * 为什么单独一个文件：裁切和部位两块都要做同一套换算，重复实现过一次就会出现「裁切框对得上、部位框整体偏移」的怪事。
 * 依赖方向：renderer -> ./char-hit（纯几何）+ ./constants（画布上限）。
 */

import { contentBox, toNormalizedPoint } from "../char-hit";
import { CANVAS_MAX_HEIGHT, CANVAS_MAX_WIDTH } from "./constants";
import type { Point } from "./geometry";

/** 画布上的鼠标位置 -> 素材像素坐标（用 contain 的实际画面矩形换算，与命中测试同一套）。 */
export function imagePoint(canvas: HTMLCanvasElement, event: MouseEvent): Point | null {
  const box = contentBox(canvas.getBoundingClientRect(), canvas.width, canvas.height);
  if (box === null) {
    return null;
  }
  const point = toNormalizedPoint(box, event.clientX, event.clientY);
  if (point === null) {
    return null;
  }
  return { x: point.x * canvas.width, y: point.y * canvas.height };
}

/** 画布上的鼠标位置 -> 0–1 归一化坐标（画部位框用）。 */
export function normalizedPoint(canvas: HTMLCanvasElement, event: MouseEvent): Point | null {
  const box = contentBox(canvas.getBoundingClientRect(), canvas.width, canvas.height);
  if (box === null) {
    return null;
  }
  return toNormalizedPoint(box, event.clientX, event.clientY);
}

export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  const scale = Math.min(CANVAS_MAX_WIDTH / width, CANVAS_MAX_HEIGHT / height, 1);
  canvas.style.width = String(Math.max(1, Math.round(width * scale))) + "px";
  canvas.style.height = String(Math.max(1, Math.round(height * scale))) + "px";
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error("图片解码失败，换一张试试。"));
    };
    image.src = dataUrl;
  });
}
