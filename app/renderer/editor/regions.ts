/**
 * 文件职责：部位框的全部交互：画框、拖移、缩放、多边形、悬停命中、标准模板、按网格生成。
 *
 * 为什么单独一个文件：这是编辑器里最长的一段业务（约 490 行）；和裁切、保存分开后，改「画框手感」不必读保存逻辑。
 * 依赖方向：renderer -> ./state + ./constants + ./geometry + ./dom + ./canvas + ./paint（只调 drawRegions）。
 */

import type { PackRegionDraft } from "../../shared/contracts/ipc";
import { resolveHit, shapeOf } from "../hit";
import {
  STANDARD_REGION_TEMPLATES,
  buildTemplateRegions,
  findTemplateByName,
} from "../region-templates";
import { api } from "./api";
import { normalizedPoint } from "./canvas";
import { asButton, asCanvas, byId, errorText, showBanner } from "./dom";
import {
  clamp,
  clonePoint,
  regionCornerAt,
  normalizeRect,
  regionRect,
  reshape,
  resizeRegionRect,
  round4,
  toHitShape,
  type Rect,
} from "./geometry";
import { drawRegions, setLookAtOrigin, updateOriginInfo } from "./paint";
import {
  BODY_REGION_NAME,
  DEFAULT_REGION_COLOR,
  DEFAULT_REGION_PADDING,
  MAX_REGION_PADDING,
  MAX_REGION_PRIORITY,
  MIN_REGION_SIDE,
  POLY_MAX_POINTS,
  POLY_MIN_POINTS,
  REGION_COLORS,
} from "./constants";
import { editorState } from "./state";

export function bodyRegion(): PackRegionDraft {
  return {
    id: "",
    name: BODY_REGION_NAME,
    rect: [0, 0, 1, 1],
    color: DEFAULT_REGION_COLOR,
    act: "",
  };
}

/** 把一次拖拽结果写回草稿：夹到 0–1、保留最小边长，并同步缩放已设的形状（T2.44）。 */
export function applyRegionRect(index: number, rect: Rect): void {
  const region = editorState.regions[index];
  if (region === undefined) {
    return;
  }
  const before = regionRect(region);
  const x = clamp(rect.x, 0, 1 - MIN_REGION_SIDE);
  const y = clamp(rect.y, 0, 1 - MIN_REGION_SIDE);
  const w = clamp(rect.w, MIN_REGION_SIDE, 1 - x);
  const h = clamp(rect.h, MIN_REGION_SIDE, 1 - y);
  const next = [round4(x), round4(y), round4(w), round4(h)] as const;
  if (region.shape !== undefined) {
    region.shape = toHitShape(
      reshape(shapeOf(region), before, { x: next[0], y: next[1], w: next[2], h: next[3] }),
    );
  }
  region.rect = [next[0], next[1], next[2], next[3]];
}

/** 只为一次拖拽挂一次全局监听（鼠标移出画布也能继续拖）。 */
export function bindRegionDrag(): void {
  window.addEventListener("mousemove", onRegionMove);
  window.addEventListener("mouseup", onRegionUp);
}

/** 画视觉原点：圆环 + 十字 + 标签；选中原点模式时再加虚线辅助线。 */

export function onRegionDown(event: MouseEvent): void {
  if (editorState.croppedCanvas === null || event.button !== 0) {
    return;
  }
  const canvas = asCanvas("region-canvas");
  const point = normalizedPoint(canvas, event);
  if (point === null) {
    return;
  }
  event.preventDefault();

  if (editorState.originMode) {
    setLookAtOrigin(point);
    editorState.originDrag = true;
    bindRegionDrag();
    drawRegions();
    return;
  }

  // 多边形模式：每次点击落一个顶点，双击 / Enter 结束，Esc 取消（T2.44）
  if (editorState.shapeKind === "poly") {
    if (editorState.polyPoints.length >= POLY_MAX_POINTS) {
      showBanner("多边形最多 " + String(POLY_MAX_POINTS) + " 个顶点，先双击结束这一个。", true);
      return;
    }
    editorState.polyPoints = [...editorState.polyPoints, point];
    editorState.hoverPoint = point;
    drawRegions();
    return;
  }

  // 1) 先判选中框的四角：拉角改大小
  const active = editorState.regions[editorState.activeRegion];
  if (active !== undefined) {
    const corner = regionCornerAt(canvas, regionRect(active), point);
    if (corner !== "") {
      editorState.regionDrag = {
        kind: "resize",
        index: editorState.activeRegion,
        corner,
        start: point,
        origin: regionRect(active),
      };
      bindRegionDrag();
      return;
    }
  }
  // 2) 点在框内：选中并拖移
  const hit = resolveHit(editorState.regions, point.x, point.y);
  if (hit !== null) {
    const index = editorState.regions.findIndex((item) => Object.is(item, hit));
    const region = index >= 0 ? editorState.regions[index] : undefined;
    if (region !== undefined) {
      editorState.activeRegion = index;
      editorState.regionDrag = {
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
  editorState.regionStart = point;
  editorState.regionPending = { x: point.x, y: point.y, w: 0, h: 0 };
  bindRegionDrag();
}

export function onRegionMove(event: MouseEvent): void {
  const canvas = asCanvas("region-canvas");
  const point = normalizedPoint(canvas, event);
  if (point === null) {
    return;
  }
  if (editorState.originDrag) {
    setLookAtOrigin(point);
    drawRegions();
    return;
  }
  if (editorState.regionDrag !== null) {
    const { kind, index, corner, start, origin } = editorState.regionDrag;
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
  if (editorState.regionStart === null) {
    return;
  }
  editorState.regionPending = normalizeRect(editorState.regionStart, point);
  drawRegions();
}

export function onRegionUp(): void {
  window.removeEventListener("mousemove", onRegionMove);
  window.removeEventListener("mouseup", onRegionUp);
  if (editorState.originDrag) {
    editorState.originDrag = false;
    renderRegions();
    drawRegions();
    return;
  }
  if (editorState.regionDrag !== null) {
    editorState.regionDrag = null;
    showBanner("");
    renderRegions();
    drawRegions();
    return;
  }
  const rect = editorState.regionPending;
  editorState.regionStart = null;
  editorState.regionPending = null;
  if (rect === null) {
    return;
  }
  if (rect.w < MIN_REGION_SIDE || rect.h < MIN_REGION_SIDE) {
    drawRegions();
    return;
  }
  const name = "部位 " + String(editorState.regions.length + 1);
  const frame = [round4(rect.x), round4(rect.y), round4(rect.w), round4(rect.h)] as const;
  const draft: PackRegionDraft = {
    id: "",
    name,
    rect: [frame[0], frame[1], frame[2], frame[3]],
    color: REGION_COLORS[editorState.regions.length % REGION_COLORS.length] ?? DEFAULT_REGION_COLOR,
    act: "",
    padding: DEFAULT_REGION_PADDING,
  };
  if (editorState.shapeKind === "ellipse") {
    draft.shape = { kind: "ellipse", rect: [frame[0], frame[1], frame[2], frame[3]] };
  }
  editorState.regions = [...editorState.regions, draft];
  editorState.activeRegion = editorState.regions.length - 1;
  showBanner("");
  renderRegions();
  drawRegions();
}

export function renderRegions(): void {
  const list = byId("region-list");
  list.replaceChildren();

  // 视觉原点特殊行：不在 regions[] 里，所以不会参与触摸命中 / usage 记账（T2.28）
  const originRow = document.createElement("div");
  originRow.className = editorState.originMode
    ? "region-row origin-row active"
    : "region-row origin-row";
  originRow.title = "Live2D 视线的支点；选中后可在画布上拖动";
  originRow.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button") !== null) {
      return;
    }
    editorState.originMode = true;
    editorState.activeRegion = -1;
    editorState.regionDrag = null;
    editorState.regionStart = null;
    editorState.regionPending = null;
    renderRegions();
    drawRegions();
  });

  const mark = document.createElement("span");
  mark.className = "origin-mark";
  mark.textContent = "◎";
  const info = document.createElement("div");
  info.className = "origin-info";
  const title = document.createElement("strong");
  title.textContent = "视觉原点";
  const detail = document.createElement("span");
  detail.className = "origin-detail";
  editorState.originInfoNode = detail;
  updateOriginInfo();
  info.append(title, detail);

  const faceButton = document.createElement("button");
  faceButton.textContent = "放到脸部中心";
  faceButton.title = "使用 faceRig / 脸部 / 头部框推导的建议位置";
  faceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    editorState.originMode = true;
    editorState.lookAtOrigin = clonePoint(editorState.suggestedLookAtOrigin);
    updateOriginInfo();
    renderRegions();
    drawRegions();
  });
  originRow.append(mark, info, faceButton);
  list.append(originRow);

  editorState.regions.forEach((region, index) => {
    const row = document.createElement("div");
    row.className =
      index === editorState.activeRegion && !editorState.originMode
        ? "region-row active"
        : "region-row";
    row.addEventListener("click", (event) => {
      // 行内的输入框 / 下拉 / 按钮有自己的交互，不能再触发整行重画（否则一点就失焦）
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, select, textarea, button, label") !== null
      ) {
        return;
      }
      editorState.originMode = false;
      editorState.activeRegion = index;
      editorState.regionDrag = null;
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
      editorState.regions = editorState.regions.filter((_, at) => at !== index);
      editorState.activeRegion = Math.min(editorState.activeRegion, editorState.regions.length - 1);
      editorState.regionDrag = null;
      showBanner("");
      renderRegions();
      drawRegions();
    });

    const standard = document.createElement("select");
    standard.className = "region-standard";
    standard.title = "标准部位名（触摸分类按 id / 名字识别）";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "标准…";
    standard.append(blank);
    const matched = findTemplateByName(region.name);
    for (const template of STANDARD_REGION_TEMPLATES) {
      const option = document.createElement("option");
      option.value = template.id;
      option.textContent = template.name;
      if (template.id === (matched?.id ?? region.id)) {
        option.selected = true;
      }
      standard.append(option);
    }
    standard.addEventListener("change", () => {
      const template = STANDARD_REGION_TEMPLATES.find((item) => item.id === standard.value);
      if (template === undefined) {
        return;
      }
      region.name = template.name;
      region.priority = region.priority ?? template.priority;
      region.padding = region.padding ?? template.padding;
      renderRegions();
      drawRegions();
    });

    const priority = document.createElement("input");
    priority.type = "number";
    priority.className = "region-num";
    priority.min = "0";
    priority.max = String(MAX_REGION_PRIORITY);
    priority.step = "1";
    priority.value = String(region.priority ?? 0);
    priority.title = "重叠时谁先算（越大越先）";
    priority.addEventListener("change", () => {
      const value = Number(priority.value);
      const next = Number.isFinite(value) ? Math.round(clamp(value, 0, MAX_REGION_PRIORITY)) : 0;
      region.priority = next;
      priority.value = String(next);
      drawRegions();
    });

    const padding = document.createElement("input");
    padding.type = "number";
    padding.className = "region-num";
    padding.min = "0";
    padding.max = String(MAX_REGION_PADDING);
    padding.step = "0.005";
    padding.value = String(region.padding ?? DEFAULT_REGION_PADDING);
    padding.title = "命中容差：框外这么多也算命中（0–0.2）";
    padding.addEventListener("change", () => {
      const value = Number(padding.value);
      const next = Number.isFinite(value)
        ? round4(clamp(value, 0, MAX_REGION_PADDING))
        : DEFAULT_REGION_PADDING;
      region.padding = next;
      padding.value = String(next);
      drawRegions();
    });

    const badge = document.createElement("span");
    badge.className = "region-shape";
    const shape = region.shape;
    badge.textContent = shape === undefined ? "矩形" : shape.kind === "ellipse" ? "椭圆" : "多边形";
    badge.title = "形状由上方「形状」下拉决定；拖四角会同步缩放";

    row.append(color, name, standard, priority, padding, badge, remove);
    list.append(row);
  });
}

export function addBodyRegion(): void {
  editorState.regions = [...editorState.regions, bodyRegion()];
  editorState.originMode = false;
  editorState.activeRegion = editorState.regions.length - 1;
  renderRegions();
  drawRegions();
}

/** 结束多边形：顶点不足就提示，太扁就丢弃，否则变成一个多边形部位（T2.44）。 */
export function finishPoly(): void {
  if (editorState.polyPoints.length < POLY_MIN_POINTS) {
    if (editorState.polyPoints.length > 0) {
      showBanner("多边形至少 " + String(POLY_MIN_POINTS) + " 个顶点，再点几下；Esc 取消。", true);
    }
    drawRegions();
    return;
  }
  const xs = editorState.polyPoints.map((point) => point.x);
  const ys = editorState.polyPoints.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  if (w < MIN_REGION_SIDE || h < MIN_REGION_SIDE) {
    editorState.polyPoints = [];
    showBanner("这个多边形太小了，再画一个。", true);
    drawRegions();
    return;
  }
  const points = editorState.polyPoints.map((point) => [round4(point.x), round4(point.y)] as const);
  editorState.regions = [
    ...editorState.regions,
    {
      id: "",
      name: "部位 " + String(editorState.regions.length + 1),
      rect: [round4(x), round4(y), round4(w), round4(h)],
      color:
        REGION_COLORS[editorState.regions.length % REGION_COLORS.length] ?? DEFAULT_REGION_COLOR,
      act: "",
      padding: DEFAULT_REGION_PADDING,
      shape: { kind: "poly", points },
    },
  ];
  editorState.polyPoints = [];
  editorState.activeRegion = editorState.regions.length - 1;
  showBanner("");
  renderRegions();
  drawRegions();
}

/** 取消正在画的多边形（Esc）。 */
export function cancelPoly(): void {
  if (editorState.polyPoints.length === 0) {
    return;
  }
  editorState.polyPoints = [];
  showBanner("");
  drawRegions();
}

/** 鼠标移动：记录悬停点（多边形草稿跟手）并更新命中预览；拖拽时不抢活。 */
export function onRegionHover(event: MouseEvent): void {
  if (editorState.croppedCanvas === null) {
    return;
  }
  const canvas = asCanvas("region-canvas");
  const point = normalizedPoint(canvas, event);
  if (point === null) {
    if (editorState.hoverPoint !== null || editorState.hoverIndex >= 0) {
      editorState.hoverPoint = null;
      editorState.hoverIndex = -1;
      drawRegions();
    }
    return;
  }
  editorState.hoverPoint = point;
  if (editorState.shapeKind === "poly") {
    drawRegions();
    return;
  }
  if (
    editorState.regionDrag !== null ||
    editorState.originDrag ||
    editorState.regionStart !== null
  ) {
    return;
  }
  const hit = resolveHit(editorState.regions, point.x, point.y);
  const index = hit === null ? -1 : editorState.regions.findIndex((item) => Object.is(item, hit));
  if (index === editorState.hoverIndex) {
    return;
  }
  editorState.hoverIndex = index;
  drawRegions();
}

/** 一键铺 13 个标准部位（只补缺的 id，不动已画好的）。 */
export function applyStandardTemplates(): void {
  if (editorState.croppedCanvas === null) {
    showBanner("先在第 2 步确认一块立绘，再来加部位。", true);
    return;
  }
  const added = buildTemplateRegions(editorState.regions, REGION_COLORS);
  if (added.length === 0) {
    showBanner("标准部位都已经有了。");
    return;
  }
  editorState.regions = [...editorState.regions, ...added];
  editorState.activeRegion = editorState.regions.length - 1;
  editorState.originMode = false;
  showBanner(
    "已套用 " + String(added.length) + " 个标准部位（可以直接拖 / 改），保存前记得核对位置。",
  );
  renderRegions();
  drawRegions();
}

/** 按当前 Live2D 模型网格生成部位框：走主窗的 getDrawableVertices 探测（T2.44）。 */
export async function generateRegionsFromMesh(): Promise<void> {
  if (!editorState.editMode) {
    showBanner("「按模型网格生成」只有在编辑已有角色时可用。", true);
    return;
  }
  const button = asButton("generate-regions");
  button.disabled = true;
  try {
    const response = await api.pack.generateRegions({ char_id: editorState.editCharId });
    if (!response.ok) {
      showBanner(response.error, true);
      return;
    }
    const byId = new Map(editorState.regions.map((region) => [region.id, region] as const));
    let added = 0;
    let updated = 0;
    for (const draft of response.regions) {
      const existing = byId.get(draft.id);
      if (existing === undefined) {
        editorState.regions = [...editorState.regions, draft];
        added += 1;
        continue;
      }
      existing.rect = draft.rect;
      if (draft.priority !== undefined) {
        existing.priority = draft.priority;
      }
      if (draft.padding !== undefined) {
        existing.padding = draft.padding;
      }
      if (draft.drawables !== undefined) {
        existing.drawables = draft.drawables;
      }
      updated += 1;
    }
    editorState.activeRegion = editorState.regions.length - 1;
    editorState.originMode = false;
    showBanner(
      "按模型网格生成：新增 " +
        String(added) +
        " 个、更新 " +
        String(updated) +
        " 个（已有部位的名字和颜色没动）。",
    );
    renderRegions();
    drawRegions();
  } catch (error) {
    showBanner("生成失败：" + errorText(error), true);
  } finally {
    button.disabled = false;
  }
}
