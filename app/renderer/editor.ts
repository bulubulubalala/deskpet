/**
 * 文件职责：角色包编辑器的入口与装配（T2.3-D）——四步向导：选图 / 裁切 / 画部位 / 填卡片。
 *
 * 为什么拆成 editor/ 目录：这个文件曾经 1500+ 行、25 个模块级可变变量，绘制、拖拽、
 * 保存全挤在一起；现在按「DOM 小工具 / 画布换算 / 绘制 / 裁切 / 部位交互 / 状态」分开，
 * 这个文件只负责保存与三种进入模式（新建 / 编辑部位 / 编辑角色卡）。
 * 依赖方向：renderer -> window.deskpet（经 ./editor/api）+ ./editor/*；禁止 import main 的实现。
 */
import type { PackLoadResponse, PackSaveRequest } from "../shared/contracts/ipc";
import { api } from "./editor/api";
import { loadImage } from "./editor/canvas";
import { PACK_ID_PATTERN } from "./editor/constants";
import {
  asButton,
  asCanvas,
  asInput,
  asTextarea,
  byId,
  errorText,
  setText,
  showBanner,
  showStep,
} from "./editor/dom";
import { clonePoint, cloneRegions } from "./editor/geometry";
import { drawCrop, drawRegions } from "./editor/paint";
import { confirmCrop, onCropDown, pickImage } from "./editor/crop";
import {
  addBodyRegion,
  applyStandardTemplates,
  cancelPoly,
  finishPoly,
  generateRegionsFromMesh,
  onRegionDown,
  onRegionHover,
  renderRegions,
} from "./editor/regions";
import { editorState } from "./editor/state";

async function savePack(): Promise<void> {
  if (editorState.cardMode) {
    return;
  }
  if (editorState.croppedDataUrl === "") {
    showBanner("还没有裁切结果：回到第 2 步确认一块。", true);
    return;
  }
  if (editorState.regions.length === 0) {
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
    portrait_data_url: editorState.croppedDataUrl,
    regions: editorState.regions,
    look_at_origin: [editorState.lookAtOrigin.x, editorState.lookAtOrigin.y],
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
        "保存时间：" + new Date().toLocaleTimeString() + "（" + editorState.sourceFileName + "）",
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
  editorState.editMode = true;
  editorState.editCharId = charId;
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
  editorState.editDisplayName = response.display_name;
  setText("editor-title", "编辑角色部位：" + editorState.editDisplayName);
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
  editorState.croppedCanvas = canvas;
  editorState.sourceImage = image;
  editorState.regions = response.regions;
  editorState.originalRegions = cloneRegions(editorState.regions);
  editorState.lookAtOrigin = { x: response.look_at_origin[0], y: response.look_at_origin[1] };
  editorState.suggestedLookAtOrigin = {
    x: response.suggested_look_at_origin[0],
    y: response.suggested_look_at_origin[1],
  };
  editorState.originalLookAtOrigin = clonePoint(editorState.lookAtOrigin);
  editorState.originMode = false;
  editorState.activeRegion = editorState.regions.length > 0 ? 0 : -1;
  showStep(3);
  renderRegions();
  drawRegions();
  showBanner("");
  document.body.dataset.editReady = "1";
}

/** 编辑模式保存：只写 hits.json；主进程会广播让主窗重载这个角色的部位。 */
async function saveRegions(): Promise<void> {
  if (!editorState.editMode) {
    return;
  }
  if (editorState.regions.length === 0) {
    showBanner("至少画一个部位框（点「加『身体』」也可以）。", true);
    return;
  }
  const button = asButton("save-regions");
  button.disabled = true;
  document.body.dataset.saveOk = "0";
  try {
    const response = await api.pack.saveRegions({
      char_id: editorState.editCharId,
      regions: editorState.regions,
      look_at_origin: [editorState.lookAtOrigin.x, editorState.lookAtOrigin.y],
    });
    if (response.ok) {
      document.body.dataset.saveOk = "1";
      editorState.originalRegions = cloneRegions(editorState.regions);
      editorState.originalLookAtOrigin = clonePoint(editorState.lookAtOrigin);
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
  if (!editorState.editMode) {
    return;
  }
  editorState.regions = cloneRegions(editorState.originalRegions);
  editorState.lookAtOrigin = clonePoint(editorState.originalLookAtOrigin);
  editorState.originMode = false;
  editorState.originDrag = false;
  editorState.activeRegion = editorState.regions.length > 0 ? 0 : -1;
  editorState.regionDrag = null;
  editorState.regionStart = null;
  editorState.regionPending = null;
  renderRegions();
  drawRegions();
  showBanner("已撤销本次改动，恢复到上次保存 / 打开编辑器时的部位。");
}

/** 角色卡模式（T2.7）：只填卡片的四个文字字段，立绘 / 部位 / 音色都不动。 */
async function enterCardMode(charId: string): Promise<void> {
  editorState.cardMode = true;
  editorState.editCharId = charId;
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
  editorState.editDisplayName = response.display_name;
  setText("editor-title", "编辑角色卡：" + editorState.editDisplayName);
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
  if (!editorState.cardMode) {
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
      char_id: editorState.editCharId,
      display_name: displayName,
      description: asTextarea("description").value.trim(),
      personality: asTextarea("personality").value.trim(),
      speaking_style: asTextarea("speaking-style").value.trim(),
    });
    if (response.ok) {
      editorState.editDisplayName = displayName;
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
    if (editorState.sourceImage === null) {
      return;
    }
    editorState.cropRect = {
      x: 0,
      y: 0,
      w: editorState.sourceImage.naturalWidth,
      h: editorState.sourceImage.naturalHeight,
    };
    drawCrop();
  });
  asButton("crop-reset").addEventListener("click", () => {
    editorState.cropRect = null;
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
    editorState.regions = [];
    editorState.originMode = false;
    editorState.activeRegion = -1;
    editorState.regionDrag = null;
    editorState.regionStart = null;
    editorState.regionPending = null;
    renderRegions();
    drawRegions();
  });
  asCanvas("region-canvas").addEventListener("mousemove", onRegionHover);
  asCanvas("region-canvas").addEventListener("mouseleave", () => {
    if (editorState.hoverPoint !== null || editorState.hoverIndex >= 0) {
      editorState.hoverPoint = null;
      editorState.hoverIndex = -1;
      drawRegions();
    }
  });
  asCanvas("region-canvas").addEventListener("dblclick", () => {
    if (editorState.shapeKind === "poly") {
      finishPoly();
    }
  });
  const shapeSelect = byId("shape-select");
  if (shapeSelect instanceof HTMLSelectElement) {
    shapeSelect.addEventListener("change", () => {
      const value = shapeSelect.value;
      editorState.shapeKind = value === "ellipse" || value === "poly" ? value : "rect";
      if (editorState.shapeKind !== "poly") {
        editorState.polyPoints = [];
      }
      showBanner("");
      drawRegions();
    });
  }
  asButton("apply-templates").addEventListener("click", () => {
    applyStandardTemplates();
  });
  asButton("generate-regions").addEventListener("click", () => {
    void generateRegionsFromMesh();
  });
  document.addEventListener("keydown", (event) => {
    if (editorState.polyPoints.length === 0) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      finishPoly();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelPoly();
    }
  });
  asButton("save-regions").addEventListener("click", () => {
    void saveRegions();
  });
  asButton("reset-regions").addEventListener("click", () => {
    resetRegionEdits();
  });
  // Ctrl/Cmd+Z 只回滚部位编辑；焦点在文本框里时交给浏览器自己的文本撤销
  document.addEventListener("keydown", (event) => {
    if (
      !editorState.editMode ||
      !(event.ctrlKey || event.metaKey) ||
      event.key.toLowerCase() !== "z"
    ) {
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
    if (editorState.regions.length === 0) {
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
    if (editorState.cardMode) {
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
