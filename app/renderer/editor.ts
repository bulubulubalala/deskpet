/**
 * 文件职责：角色包编辑器的渲染层（T2.3-D）——选图 / 裁切 / 画部位 / 填卡片四步向导。
 *
 * 为什么坐标换算复用 ./char-hit：主窗点击立绘用的是同一套「object-fit: contain 的实际画面
 * 矩形 + 归一化坐标」，编辑器里画出来的框必须与那边一致，否则保存的 hits.json 到了主窗会整体偏移。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）+ ./char-hit（纯几何）；禁止 import main 的实现。
 */
import type { PackRegionDraft, PackSaveRequest } from "../main/ipc";
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

const ACT_OPTIONS: readonly (readonly [string, string])[] = [
  ["", "不变"],
  ["blush", "害羞"],
  ["wave", "挥手"],
  ["shake", "发抖"],
  ["think", "思考"],
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
  const hit = locateRegion(regions, point.x, point.y);
  if (hit !== null) {
    // hit 是 regions 里的同一个对象（locateRegion 只做几何判定），按身份找下标；
    // 直接 indexOf 会因为 rect 的 readonly 元组类型不兼容而报 TS2345。
    const index = regions.findIndex((item) => Object.is(item, hit));
    if (index >= 0) {
      activeRegion = index;
      renderRegions();
      drawRegions();
    }
    return;
  }
  regionStart = point;
  regionPending = { x: point.x, y: point.y, w: 0, h: 0 };
  window.addEventListener("mousemove", onRegionMove);
  window.addEventListener("mouseup", onRegionUp);
}

function onRegionMove(event: MouseEvent): void {
  if (regionStart === null) {
    return;
  }
  const point = normalizedPoint(asCanvas("region-canvas"), event);
  if (point === null) {
    return;
  }
  regionPending = normalizeRect(regionStart, point);
  drawRegions();
}

function onRegionUp(): void {
  window.removeEventListener("mousemove", onRegionMove);
  window.removeEventListener("mouseup", onRegionUp);
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
    row.addEventListener("click", () => {
      activeRegion = index;
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

    const act = document.createElement("select");
    for (const [value, label] of ACT_OPTIONS) {
      act.append(new Option(label, value));
    }
    act.value = region.act;
    act.title = "点了这个部位时播放的动作（M3 之后用）";
    act.addEventListener("change", () => {
      region.act = act.value;
    });

    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      regions = regions.filter((_, at) => at !== index);
      activeRegion = Math.min(activeRegion, regions.length - 1);
      showBanner("");
      renderRegions();
      drawRegions();
    });

    row.append(color, name, act, remove);
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
    renderRegions();
    drawRegions();
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
    void savePack();
  });
  showStep(1);
  document.body.dataset.editorReady = "1";
}

main();
