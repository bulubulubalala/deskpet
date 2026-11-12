/**
 * 文件职责：选图与裁切：拿图、画裁切框、拖动四角/整体、确认裁切。
 *
 * 为什么单独一个文件：裁切是独立的一步（不涉及部位），拆开后裁切交互只依赖画布与状态，不会因为部位逻辑改动而受影响。
 * 依赖方向：renderer -> ./api + ./dom + ./canvas + ./paint + ./regions（裁完要生成默认身体框）。
 */

import { api } from "./api";
import { imagePoint, loadImage } from "./canvas";
import { asCanvas, context, errorText, setText, showBanner, showStep } from "./dom";
import { clampCrop, drawCrop, drawRegions } from "./paint";
import { bodyRegion, renderRegions } from "./regions";
import { editorState } from "./state";
import {
  clamp,
  cloneRect,
  containsPoint,
  cornerAt,
  HANDLE_PX,
  normalizeRect,
  resizeRect,
} from "./geometry";
import { MAX_PORTRAIT_BYTES, MIN_CROP_PX } from "./constants";

export async function pickImage(): Promise<void> {
  try {
    const response = await api.pack.pickImage();
    if (response.canceled) {
      return;
    }
    const image = await loadImage(response.data_url);
    editorState.sourceImage = image;
    editorState.sourceFileName = response.file_name;
    editorState.cropRect = null;
    editorState.croppedCanvas = null;
    editorState.croppedDataUrl = "";
    editorState.regions = [];
    editorState.activeRegion = -1;
    setText(
      "source-info",
      response.file_name +
        "（" +
        String(image.naturalWidth) +
        " × " +
        String(image.naturalHeight) +
        "）",
    );
    showBanner("");
    drawCrop();
    renderRegions();
    showStep(2);
  } catch (error) {
    showBanner("选图失败：" + errorText(error), true);
  }
}

export function listenCropDrag(): void {
  window.addEventListener("mousemove", onCropMove);
  window.addEventListener("mouseup", onCropUp);
}

export function stopCropDrag(): void {
  window.removeEventListener("mousemove", onCropMove);
  window.removeEventListener("mouseup", onCropUp);
}

export function onCropDown(event: MouseEvent): void {
  if (editorState.sourceImage === null || event.button !== 0) {
    return;
  }
  const canvas = asCanvas("crop-canvas");
  const point = imagePoint(canvas, event);
  if (point === null) {
    return;
  }
  event.preventDefault();
  const handle = Math.max(HANDLE_PX, canvas.width / 50);
  if (editorState.cropRect !== null) {
    const corner = cornerAt(editorState.cropRect, point, handle);
    if (corner !== "") {
      editorState.cropDrag = {
        mode: "resize",
        corner,
        origin: cloneRect(editorState.cropRect),
        start: point,
      };
      listenCropDrag();
      return;
    }
    if (containsPoint(editorState.cropRect, point)) {
      editorState.cropDrag = {
        mode: "move",
        corner: "",
        origin: cloneRect(editorState.cropRect),
        start: point,
      };
      listenCropDrag();
      return;
    }
  }
  editorState.cropRect = { x: point.x, y: point.y, w: 0, h: 0 };
  editorState.cropDrag = {
    mode: "new",
    corner: "",
    origin: cloneRect(editorState.cropRect),
    start: point,
  };
  listenCropDrag();
}

export function onCropMove(event: MouseEvent): void {
  if (editorState.cropDrag === null) {
    return;
  }
  const point = imagePoint(asCanvas("crop-canvas"), event);
  if (point === null) {
    return;
  }
  const dx = point.x - editorState.cropDrag.start.x;
  const dy = point.y - editorState.cropDrag.start.y;
  if (editorState.cropDrag.mode === "move") {
    editorState.cropRect = clampCrop({
      x: editorState.cropDrag.origin.x + dx,
      y: editorState.cropDrag.origin.y + dy,
      w: editorState.cropDrag.origin.w,
      h: editorState.cropDrag.origin.h,
    });
  } else if (editorState.cropDrag.mode === "resize") {
    editorState.cropRect = clampCrop(
      resizeRect(editorState.cropDrag.origin, editorState.cropDrag.corner, point),
    );
  } else {
    editorState.cropRect = clampCrop(normalizeRect(editorState.cropDrag.start, point));
  }
  drawCrop();
}

export function onCropUp(): void {
  if (editorState.cropDrag === null) {
    return;
  }
  const mode = editorState.cropDrag.mode;
  editorState.cropDrag = null;
  stopCropDrag();
  if (
    mode === "new" &&
    editorState.cropRect !== null &&
    (editorState.cropRect.w < MIN_CROP_PX || editorState.cropRect.h < MIN_CROP_PX)
  ) {
    editorState.cropRect = null;
  }
  drawCrop();
}

export function confirmCrop(): void {
  if (editorState.sourceImage === null) {
    showBanner("先选一张图片。", true);
    return;
  }
  const source = editorState.cropRect ?? {
    x: 0,
    y: 0,
    w: editorState.sourceImage.naturalWidth,
    h: editorState.sourceImage.naturalHeight,
  };
  const left = clamp(Math.round(source.x), 0, editorState.sourceImage.naturalWidth - 1);
  const top = clamp(Math.round(source.y), 0, editorState.sourceImage.naturalHeight - 1);
  const width = clamp(Math.round(source.w), 1, editorState.sourceImage.naturalWidth - left);
  const height = clamp(Math.round(source.h), 1, editorState.sourceImage.naturalHeight - top);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  context(canvas).drawImage(editorState.sourceImage, left, top, width, height, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Math.round(base64.length * 0.75);
  if (bytes > MAX_PORTRAIT_BYTES) {
    showBanner(
      "裁切结果是 " + String(Math.round(bytes / 1024 / 1024)) + " MiB，超过 8 MiB：把框画小一点。",
      true,
    );
    return;
  }
  editorState.croppedCanvas = canvas;
  editorState.croppedDataUrl = dataUrl;
  if (editorState.regions.length === 0) {
    editorState.regions = [bodyRegion()];
    editorState.activeRegion = 0;
  }
  showBanner("");
  drawRegions();
  renderRegions();
  showStep(3);
}
