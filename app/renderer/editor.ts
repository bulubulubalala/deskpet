/**
 * 文件职责：角色包编辑器的渲染层（T2.3-D）——选图 / 裁切 / 画部位 / 填卡片四步向导。
 *
 * 为什么坐标换算复用 ./char-hit：主窗点击立绘用的是同一套「object-fit: contain 的实际画面
 * 矩形 + 归一化坐标」，编辑器里画出来的框必须与那边一致，否则保存的 hits.json 到了主窗会整体偏移。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）+ ./char-hit（纯几何）；禁止 import main 的实现。
 */
import type { PackLoadResponse, PackRegionDraft, PackSaveRequest } from "../main/ipc";
import type { DeskpetApi } from "../preload/api";
import { contentBox, locateRegion, toNormalizedPoint } from "./char-hit";

declare global {
  interface Window {
    readonly deskpet: DeskpetApi;
  }
}

const api = window.deskpet;

/** 画布显示上限：图片按这个尺寸等比缩放，坐标换算仍用 canvas 的像素尺寸。 */
const CANVAS_MAX_WIDTH = 620;
const CANVAS_MAX_HEIGHT = 430;
/** 点住四角多少像素内算「改大小」。 */
const HANDLE_PX = 14;
/** 框小于这个像素边长就当没画（防止误点产生一个看不见的框）。 */
const MIN_CROP_PX = 16;
/** 部位框最小边长（归一化）：太小的框在立绘上几乎点不到。 */
const MIN_REGION_SIDE = 0.02;
/** 与 app/main/pack-editor.ts 的 MAX_PORTRAIT_BYTES 一致：写不进去的图别让用户白画。 */
const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024;
/** 与 app/main/pack-editor.ts 的 PACK_ID_PATTERN 一致（渲染层本地先挡一遍，省一次往返）。 */
const PACK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BODY_REGION_NAME = "身体";
/** 部位框默认颜色（与 app/main/pack-editor.ts 的 DEFAULT_REGION_COLOR 一致）。 */
const DEFAULT_REGION_COLOR = "#ffb347";

const REGION_COLORS: readonly string[] = [
  "#ff6b6b",
  "#ffb347",
  "#ffe66d",
  "#6bcB77",
  "#4ecdc4",
  "#54a0ff",
  "#a29bfe",
  "#ff9ff3",
];

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DragState {
  readonly mode: "new" | "move" | "resize";
  readonly corner: string;
  readonly origin: Rect;
  readonly start: Point;
}

let sourceImage: HTMLImageElement | null = null;
let sourceFileName = "";
let cropRect: Rect | null = null;
let croppedCanvas: HTMLCanvasElement | null = null;
let croppedDataUrl = "";
let regions: PackRegionDraft[] = [];
let activeRegion = -1;
let drag: DragState | null = null;
let regionStart: Point | null = null;
let regionPending: Rect | null = null;
/** 编辑模式（T2.5）：只改当前角色的 hits.json，不碰立绘 / 卡片。 */
let editMode = false;
/** 角色卡模式（T2.7）：只改 card.json / pack.json 的人设与显示名。 */
let cardMode = false;
/** 打开编辑器时的部位快照：「撤销本次改动」/ 保存成功后回滚到这里（T2.8）。 */
let originalRegions: PackRegionDraft[] = [];
let editCharId = "";
let editDisplayName = "";
/** 已有框的拖移 / 缩放现场；null 表示当前是在画新框或空闲。 */
let regionDrag: {
  readonly kind: "move" | "resize";
  readonly index: number;
  readonly corner: string;
  readonly start: Point;
  readonly origin: Rect;
} | null = null;

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error("界面元素缺失：" + id);
  }
  return element;
}

function asInput(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("不是输入框：" + id);
  }
  return element;
}

function asTextarea(id: string): HTMLTextAreaElement {
  const element = byId(id);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("不是多行输入框：" + id);
  }
  return element;
}

function asCanvas(id: string): HTMLCanvasElement {
  const element = byId(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error("不是画布：" + id);
  }
  return element;
}

function asButton(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("不是按钮：" + id);
  }
  return element;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const value = canvas.getContext("2d");
  if (value === null) {
    throw new Error("拿不到 2D 画布上下文");
  }
  return value;
}

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showBanner(message: string, bad = false): void {
  const banner = byId("editor-banner");
  banner.textContent = message;
  banner.className = bad ? "banner bad" : "banner";
  banner.hidden = message === "";
}

function showStep(next: 1 | 2 | 3 | 4): void {
  const all: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];
  for (const value of all) {
    byId("step-" + String(value)).hidden = value !== next;
    byId("step-tab-" + String(value)).className = value === next ? "step active" : "step";
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/** 复制一份部位草稿（rect 是元组，必须新建数组，不能与快照共享引用）。 */
function cloneRegions(list: readonly PackRegionDraft[]): PackRegionDraft[] {
  return list.map((region) => ({
    ...region,
    rect: [region.rect[0], region.rect[1], region.rect[2], region.rect[3]],
  }));
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

function cornerAt(rect: Rect, point: Point, handle: number): string {
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

/** 画布上的鼠标位置 -> 素材像素坐标（用 contain 的实际画面矩形换算，与命中测试同一套）。 */
function imagePoint(canvas: HTMLCanvasElement, event: MouseEvent): Point | null {
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
function normalizedPoint(canvas: HTMLCanvasElement, event: MouseEvent): Point | null {
  const box = contentBox(canvas.getBoundingClientRect(), canvas.width, canvas.height);
  if (box === null) {
    return null;
  }
  return toNormalizedPoint(box, event.clientX, event.clientY);
}

function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  const scale = Math.min(CANVAS_MAX_WIDTH / width, CANVAS_MAX_HEIGHT / height, 1);
  canvas.style.width = String(Math.max(1, Math.round(width * scale))) + "px";
  canvas.style.height = String(Math.max(1, Math.round(height * scale))) + "px";
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
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

async function pickImage(): Promise<void> {
  try {
    const response = await api.pack.pickImage();
    if (response.canceled) {
      return;
    }
    const image = await loadImage(response.data_url);
    sourceImage = image;
    sourceFileName = response.file_name;
    cropRect = null;
    croppedCanvas = null;
    croppedDataUrl = "";
    regions = [];
    activeRegion = -1;
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

function drawCrop(): void {
  if (sourceImage === null) {
    return;
  }
  const canvas = asCanvas("crop-canvas");
  const width = sourceImage.naturalWidth;
  const height = sourceImage.naturalHeight;
  canvas.width = width;
  canvas.height = height;
  fitCanvas(canvas, width, height);
  const ctx = context(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(sourceImage, 0, 0);
  if (cropRect === null) {
    return;
  }
  const rect = cropRect;
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

function clampCrop(rect: Rect): Rect {
  if (sourceImage === null) {
    return rect;
  }
  const width = sourceImage.naturalWidth;
  const height = sourceImage.naturalHeight;
  const x = clamp(rect.x, 0, width);
  const y = clamp(rect.y, 0, height);
  return { x, y, w: clamp(rect.w, 0, width - x), h: clamp(rect.h, 0, height - y) };
}

function resizeRect(origin: Rect, corner: string, point: Point): Rect {
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

function listenCropDrag(): void {
  window.addEventListener("mousemove", onCropMove);
  window.addEventListener("mouseup", onCropUp);
}

function stopCropDrag(): void {
  window.removeEventListener("mousemove", onCropMove);
  window.removeEventListener("mouseup", onCropUp);
}

function onCropDown(event: MouseEvent): void {
  if (sourceImage === null || event.button !== 0) {
    return;
  }
  const canvas = asCanvas("crop-canvas");
  const point = imagePoint(canvas, event);
  if (point === null) {
    return;
  }
  event.preventDefault();
  const handle = Math.max(HANDLE_PX, canvas.width / 50);
  if (cropRect !== null) {
    const corner = cornerAt(cropRect, point, handle);
    if (corner !== "") {
      drag = { mode: "resize", corner, origin: cloneRect(cropRect), start: point };
      listenCropDrag();
      return;
    }
    if (containsPoint(cropRect, point)) {
      drag = { mode: "move", corner: "", origin: cloneRect(cropRect), start: point };
      listenCropDrag();
      return;
    }
  }
  cropRect = { x: point.x, y: point.y, w: 0, h: 0 };
  drag = { mode: "new", corner: "", origin: cloneRect(cropRect), start: point };
  listenCropDrag();
}

function onCropMove(event: MouseEvent): void {
  if (drag === null) {
    return;
  }
  const point = imagePoint(asCanvas("crop-canvas"), event);
  if (point === null) {
    return;
  }
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  if (drag.mode === "move") {
    cropRect = clampCrop({
      x: drag.origin.x + dx,
      y: drag.origin.y + dy,
      w: drag.origin.w,
      h: drag.origin.h,
    });
  } else if (drag.mode === "resize") {
    cropRect = clampCrop(resizeRect(drag.origin, drag.corner, point));
  } else {
    cropRect = clampCrop(normalizeRect(drag.start, point));
  }
  drawCrop();
}

function onCropUp(): void {
  if (drag === null) {
    return;
  }
  const mode = drag.mode;
  drag = null;
  stopCropDrag();
  if (
    mode === "new" &&
    cropRect !== null &&
    (cropRect.w < MIN_CROP_PX || cropRect.h < MIN_CROP_PX)
  ) {
    cropRect = null;
  }
  drawCrop();
}

function confirmCrop(): void {
  if (sourceImage === null) {
    showBanner("先选一张图片。", true);
    return;
  }
  const source = cropRect ?? {
    x: 0,
    y: 0,
    w: sourceImage.naturalWidth,
    h: sourceImage.naturalHeight,
  };
  const left = clamp(Math.round(source.x), 0, sourceImage.naturalWidth - 1);
  const top = clamp(Math.round(source.y), 0, sourceImage.naturalHeight - 1);
  const width = clamp(Math.round(source.w), 1, sourceImage.naturalWidth - left);
  const height = clamp(Math.round(source.h), 1, sourceImage.naturalHeight - top);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  context(canvas).drawImage(sourceImage, left, top, width, height, 0, 0, width, height);
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
  croppedCanvas = canvas;
  croppedDataUrl = dataUrl;
  if (regions.length === 0) {
    regions = [bodyRegion()];
    activeRegion = 0;
  }
  showBanner("");
  drawRegions();
  renderRegions();
  showStep(3);
}

function bodyRegion(): PackRegionDraft {
  return {
    id: "",
    name: BODY_REGION_NAME,
    rect: [0, 0, 1, 1],
    color: DEFAULT_REGION_COLOR,
    act: "",
  };
}

/** 部位草稿的 rect 元组 → 可变 Rect（绘制 / 拖拽都用这个形状）。 */
function regionRect(region: PackRegionDraft): Rect {
  const [x = 0, y = 0, w = 0, h = 0] = region.rect;
  return { x, y, w, h };
}

/** 把一次拖拽结果写回草稿：夹到 0–1、保留最小边长。 */
function applyRegionRect(index: number, rect: Rect): void {
  const region = regions[index];
  if (region === undefined) {
    return;
  }
  const x = clamp(rect.x, 0, 1 - MIN_REGION_SIDE);
  const y = clamp(rect.y, 0, 1 - MIN_REGION_SIDE);
  const w = clamp(rect.w, MIN_REGION_SIDE, 1 - x);
  const h = clamp(rect.h, MIN_REGION_SIDE, 1 - y);
  region.rect = [round4(x), round4(y), round4(w), round4(h)];
}

/** 归一化坐标下判断是否抓住四角（把矩形与点换回画布像素，复用裁切步骤的手柄判定）。 */
function regionCornerAt(canvas: HTMLCanvasElement, rect: Rect, point: Point): string {
  const width = canvas.width;
  const height = canvas.height;
  return cornerAt(
    { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height },
    { x: point.x * width, y: point.y * height },
    HANDLE_PX,
  );
}

/** 归一化坐标下按角缩放（同样在像素空间算，避免宽高比例把容差拉歪）。 */
function resizeRegionRect(
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

/** 只为一次拖拽挂一次全局监听（鼠标移出画布也能继续拖）。 */
function bindRegionDrag(): void {
  window.addEventListener("mousemove", onRegionMove);
  window.addEventListener("mouseup", onRegionUp);
}

function drawRegions(): void {
  if (croppedCanvas === null) {
    return;
  }
  const canvas = asCanvas("region-canvas");
  const width = croppedCanvas.width;
  const height = croppedCanvas.height;
  canvas.width = width;
  canvas.height = height;
  fitCanvas(canvas, width, height);
  const ctx = context(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(croppedCanvas, 0, 0);
  regions.forEach((region, index) => {
    const [x = 0, y = 0, w = 0, h = 0] = region.rect;
    const active = index === activeRegion;
    ctx.save();
    ctx.globalAlpha = active ? 0.42 : 0.24;
    ctx.fillStyle = region.color;
    ctx.fillRect(x * width, y * height, w * width, h * height);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = region.color;
    ctx.lineWidth = Math.max(2, width / 280) * (active ? 2 : 1);
    ctx.strokeRect(x * width, y * height, w * width, h * height);
    ctx.fillStyle = region.color;
    ctx.font = String(Math.max(12, Math.round(width / 32))) + "px Microsoft YaHei, sans-serif";
    ctx.fillText(region.name, x * width + 4, y * height + Math.max(14, width / 32));
    ctx.restore();
  });
  // 选中框的四角画小方块：提示「这里可以拖着改大小」
  const active = regions[activeRegion];
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
  if (regionPending === null) {
    return;
  }
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    regionPending.x * width,
    regionPending.y * height,
    regionPending.w * width,
    regionPending.h * height,
  );
  ctx.restore();
}

function onRegionDown(event: MouseEvent): void {
  if (croppedCanvas === null || event.button !== 0) {
    return;
  }
  const canvas = asCanvas("region-canvas");
  const point = normalizedPoint(canvas, event);
  if (point === null) {
    return;
  }
  event.preventDefault();

  // 1) 先判选中框的四角：拉角改大小
  const active = regions[activeRegion];
  if (active !== undefined) {
    const corner = regionCornerAt(canvas, regionRect(active), point);
    if (corner !== "") {
      regionDrag = {
        kind: "resize",
        index: activeRegion,
        corner,
        start: point,
        origin: regionRect(active),
      };
      bindRegionDrag();
      return;
    }
  }
  // 2) 点在框内：选中并拖移
  const hit = locateRegion(regions, point.x, point.y);
  if (hit !== null) {
    const index = regions.findIndex((item) => Object.is(item, hit));
    const region = index >= 0 ? regions[index] : undefined;
    if (region !== undefined) {
      activeRegion = index;
      regionDrag = {
        kind: "move",
        index,
        corner: "",
        start: point,
        origin: regionRect(region),
      };
      renderRegions();
      drawRegions();
      bindRegionDrag();
    }
    return;
  }
  // 3) 空白处：画新框
  regionStart = point;
  regionPending = { x: point.x, y: point.y, w: 0, h: 0 };
  bindRegionDrag();
}

function onRegionMove(event: MouseEvent): void {
  const canvas = asCanvas("region-canvas");
  const point = normalizedPoint(canvas, event);
  if (point === null) {
    return;
  }
  if (regionDrag !== null) {
    const { kind, index, corner, start, origin } = regionDrag;
    if (kind === "move") {
      applyRegionRect(index, {
        x: origin.x + point.x - start.x,
        y: origin.y + point.y - start.y,
        w: origin.w,
        h: origin.h,
      });
    } else {
      applyRegionRect(index, resizeRegionRect(canvas, origin, corner, point));
    }
    drawRegions();
    return;
  }
  if (regionStart === null) {
    return;
  }
  regionPending = normalizeRect(regionStart, point);
  drawRegions();
}

function onRegionUp(): void {
  window.removeEventListener("mousemove", onRegionMove);
  window.removeEventListener("mouseup", onRegionUp);
  if (regionDrag !== null) {
    regionDrag = null;
    showBanner("");
    renderRegions();
    drawRegions();
    return;
  }
  const rect = regionPending;
  regionStart = null;
  regionPending = null;
  if (rect === null) {
    return;
  }
  if (rect.w < MIN_REGION_SIDE || rect.h < MIN_REGION_SIDE) {
    drawRegions();
    return;
  }
  const name = "部位 " + String(regions.length + 1);
  regions = [
    ...regions,
    {
      id: "",
      name,
      rect: [round4(rect.x), round4(rect.y), round4(rect.w), round4(rect.h)],
      color: REGION_COLORS[regions.length % REGION_COLORS.length] ?? DEFAULT_REGION_COLOR,
      act: "",
    },
  ];
  activeRegion = regions.length - 1;
  showBanner("");
  renderRegions();
  drawRegions();
}

function renderRegions(): void {
  const list = byId("region-list");
  list.replaceChildren();
  regions.forEach((region, index) => {
    const row = document.createElement("div");
    row.className = index === activeRegion ? "region-row active" : "region-row";
    row.addEventListener("click", (event) => {
      // 行内的输入框 / 下拉 / 按钮有自己的交互，不能再触发整行重画（否则一点就失焦）
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, select, textarea, button, label") !== null
      ) {
        return;
      }
      activeRegion = index;
      regionDrag = null;
      renderRegions();
      drawRegions();
    });

    const color = document.createElement("input");
    color.type = "color";
    color.value = region.color;
    color.title = "点击部位时框线 / 高亮色";
    color.addEventListener("input", () => {
      region.color = color.value;
      drawRegions();
    });

    const name = document.createElement("input");
    name.type = "text";
    name.value = region.name;
    name.placeholder = "部位名，如 头";
    name.addEventListener("input", () => {
      region.name = name.value;
      drawRegions();
    });

    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      regions = regions.filter((_, at) => at !== index);
      activeRegion = Math.min(activeRegion, regions.length - 1);
      regionDrag = null;
      showBanner("");
      renderRegions();
      drawRegions();
    });

    row.append(color, name, remove);
    list.append(row);
  });
}

function addBodyRegion(): void {
  regions = [...regions, bodyRegion()];
  activeRegion = regions.length - 1;
  renderRegions();
  drawRegions();
}

async function savePack(): Promise<void> {
  if (cardMode) {
    return;
  }
  if (croppedDataUrl === "") {
    showBanner("还没有裁切结果：回到第 2 步确认一块。", true);
    return;
  }
  if (regions.length === 0) {
    showBanner("至少画一个部位框（点「加『身体』」也可以）。", true);
    return;
  }
  const charId = asInput("char-id").value.trim();
  if (!PACK_ID_PATTERN.test(charId)) {
    showBanner(
      "char_id 只能是字母 / 数字 / 下划线 / 短横，最长 64 字，且不能以 _ 或 . 开头。",
      true,
    );
    return;
  }
  const request: PackSaveRequest = {
    char_id: charId,
    display_name: asInput("display-name").value.trim(),
    description: asTextarea("description").value.trim(),
    personality: asTextarea("personality").value.trim(),
    speaking_style: asTextarea("speaking-style").value.trim(),
    portrait_data_url: croppedDataUrl,
    regions,
  };
  const save = asButton("save-pack");
  save.disabled = true;
  try {
    const response = await api.pack.save(request);
    if (response.ok) {
      showBanner(
        "已保存 characters/" +
          response.char_id +
          "：" +
          response.files.join("、") +
          "。角色菜单已刷新。",
      );
      setText(
        "save-result",
        "保存时间：" + new Date().toLocaleTimeString() + "（" + sourceFileName + "）",
      );
    } else {
      showBanner(response.error, true);
    }
  } catch (error) {
    showBanner("保存失败：" + errorText(error), true);
  } finally {
    save.disabled = false;
  }
}

/** 解析 URL 里的编辑上下文：?mode=edit|card&char_id=amber。 */
function readEditContext(): { mode: "create" | "edit" | "card"; charId: string } {
  const params = new URLSearchParams(window.location.search);
  const charId = (params.get("char_id") ?? "").trim();
  const raw = params.get("mode");
  const mode = charId !== "" && (raw === "edit" || raw === "card") ? raw : "create";
  return { mode, charId };
}

/** 编辑模式：加载现有立绘与部位，只留「画部位」一步（T2.5）。 */
async function enterEditMode(charId: string): Promise<void> {
  editMode = true;
  editCharId = charId;
  document.body.dataset.editReady = "0";
  for (const id of ["step-tab-1", "step-tab-2", "step-tab-4"]) {
    byId(id).hidden = true;
  }
  byId("step3-nav").hidden = true;
  byId("edit-note").hidden = false;
  byId("edit-actions").hidden = false;
  byId("save-regions").hidden = false;
  byId("reset-regions").hidden = false;
  setText("editor-title", "编辑角色部位");

  let response: PackLoadResponse;
  try {
    response = await api.pack.load({ char_id: charId });
  } catch (error) {
    showBanner("读取角色包失败：" + errorText(error), true);
    return;
  }
  if (!response.ok) {
    showBanner(response.error, true);
    return;
  }
  editDisplayName = response.display_name;
  setText("editor-title", "编辑角色部位：" + editDisplayName);
  if (response.portrait_data_url === null) {
    showBanner("这个角色没有可读的立绘，无法编辑部位。", true);
    return;
  }
  const image = await loadImage(response.portrait_data_url);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    showBanner("创建画布失败（浏览器不支持 2D canvas）。", true);
    return;
  }
  ctx.drawImage(image, 0, 0);
  croppedCanvas = canvas;
  sourceImage = image;
  regions = response.regions;
  originalRegions = cloneRegions(regions);
  activeRegion = regions.length > 0 ? 0 : -1;
  showStep(3);
  renderRegions();
  drawRegions();
  showBanner("");
  document.body.dataset.editReady = "1";
}

/** 编辑模式保存：只写 hits.json；主进程会广播让主窗重载这个角色的部位。 */
async function saveRegions(): Promise<void> {
  if (!editMode) {
    return;
  }
  if (regions.length === 0) {
    showBanner("至少画一个部位框（点「加『身体』」也可以）。", true);
    return;
  }
  const button = asButton("save-regions");
  button.disabled = true;
  document.body.dataset.saveOk = "0";
  try {
    const response = await api.pack.saveRegions({
      char_id: editCharId,
      regions,
    });
    if (response.ok) {
      document.body.dataset.saveOk = "1";
      originalRegions = cloneRegions(regions);
      showBanner(
        "已保存 characters/" + response.char_id + "/hits.json，主窗已刷新这个角色的触摸区域。",
      );
    } else {
      showBanner(response.error, true);
    }
  } catch (error) {
    showBanner("保存失败：" + errorText(error), true);
  } finally {
    button.disabled = false;
  }
}

/** 撤销本次改动：恢复到打开编辑器 / 上次保存时的部位快照（T2.8）。 */
function resetRegionEdits(): void {
  if (!editMode) {
    return;
  }
  regions = cloneRegions(originalRegions);
  activeRegion = regions.length > 0 ? 0 : -1;
  regionDrag = null;
  regionStart = null;
  regionPending = null;
  renderRegions();
  drawRegions();
  showBanner("已撤销本次改动，恢复到上次保存 / 打开编辑器时的部位。");
}

/** 角色卡模式（T2.7）：只填卡片的四个文字字段，立绘 / 部位 / 音色都不动。 */
async function enterCardMode(charId: string): Promise<void> {
  cardMode = true;
  editCharId = charId;
  document.body.dataset.cardReady = "0";
  for (const id of ["step-tab-1", "step-tab-2", "step-tab-3"]) {
    byId(id).hidden = true;
  }
  byId("edit-note").hidden = false;
  setText(
    "edit-note",
    "角色卡模式：只改显示名 / 简介 / 人格 / 说话风格；立绘、部位与音色都不会被改动。",
  );
  setText("editor-title", "编辑角色卡");
  asButton("step4-back").hidden = true;
  asButton("save-pack").textContent = "保存角色卡";

  let response: PackLoadResponse;
  try {
    response = await api.pack.load({ char_id: charId });
  } catch (error) {
    showBanner("读取角色卡失败：" + errorText(error), true);
    return;
  }
  if (!response.ok) {
    showBanner(response.error, true);
    return;
  }
  editDisplayName = response.display_name;
  setText("editor-title", "编辑角色卡：" + editDisplayName);
  const idInput = asInput("char-id");
  idInput.value = response.char_id;
  idInput.disabled = true;
  asInput("display-name").value = response.display_name;
  asTextarea("description").value = response.description;
  asTextarea("personality").value = response.personality;
  asTextarea("speaking-style").value = response.speaking_style;
  showStep(4);
  showBanner("");
  document.body.dataset.cardReady = "1";
}

/** 保存角色卡：只写 card.json + pack.json 的显示名；失败保留原文。 */
async function saveCard(): Promise<void> {
  if (!cardMode) {
    return;
  }
  const displayName = asInput("display-name").value.trim();
  if (displayName === "") {
    showBanner("显示名不能为空。", true);
    return;
  }
  const button = asButton("save-pack");
  button.disabled = true;
  try {
    const response = await api.pack.saveCard({
      char_id: editCharId,
      display_name: displayName,
      description: asTextarea("description").value.trim(),
      personality: asTextarea("personality").value.trim(),
      speaking_style: asTextarea("speaking-style").value.trim(),
    });
    if (response.ok) {
      editDisplayName = displayName;
      setText("editor-title", "编辑角色卡：" + displayName);
      setText("save-result", "保存时间：" + new Date().toLocaleTimeString());
      showBanner("已保存 characters/" + response.char_id + "/card.json，立绘、部位与音色未动。");
    } else {
      showBanner(response.error, true);
    }
  } catch (error) {
    showBanner("保存失败：" + errorText(error), true);
  } finally {
    button.disabled = false;
  }
}

function main(): void {
  asButton("pick-image").addEventListener("click", () => {
    void pickImage();
  });
  asButton("crop-all").addEventListener("click", () => {
    if (sourceImage === null) {
      return;
    }
    cropRect = { x: 0, y: 0, w: sourceImage.naturalWidth, h: sourceImage.naturalHeight };
    drawCrop();
  });
  asButton("crop-reset").addEventListener("click", () => {
    cropRect = null;
    drawCrop();
  });
  asButton("crop-confirm").addEventListener("click", () => {
    confirmCrop();
  });
  asCanvas("crop-canvas").addEventListener("mousedown", onCropDown);
  asCanvas("region-canvas").addEventListener("mousedown", onRegionDown);
  asButton("add-body").addEventListener("click", () => {
    addBodyRegion();
  });
  asButton("clear-regions").addEventListener("click", () => {
    regions = [];
    activeRegion = -1;
    regionDrag = null;
    regionStart = null;
    regionPending = null;
    renderRegions();
    drawRegions();
  });
  asButton("save-regions").addEventListener("click", () => {
    void saveRegions();
  });
  asButton("reset-regions").addEventListener("click", () => {
    resetRegionEdits();
  });
  // Ctrl/Cmd+Z 只回滚部位编辑；焦点在文本框里时交给浏览器自己的文本撤销
  document.addEventListener("keydown", (event) => {
    if (!editMode || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return;
    }
    event.preventDefault();
    resetRegionEdits();
  });
  asButton("step3-back").addEventListener("click", () => {
    showStep(2);
    drawCrop();
  });
  asButton("step3-next").addEventListener("click", () => {
    if (regions.length === 0) {
      showBanner("至少画一个部位框（点「加『身体』」也可以）。", true);
      return;
    }
    showBanner("");
    showStep(4);
  });
  asButton("step4-back").addEventListener("click", () => {
    showStep(3);
  });
  asButton("save-pack").addEventListener("click", () => {
    if (cardMode) {
      void saveCard();
    } else {
      void savePack();
    }
  });
  const context = readEditContext();
  if (context.mode === "edit") {
    void enterEditMode(context.charId);
  } else if (context.mode === "card") {
    void enterCardMode(context.charId);
  } else {
    showStep(1);
  }
  document.body.dataset.editorReady = "1";
}

main();
