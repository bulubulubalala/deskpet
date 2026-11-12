/**
 * 文件职责：编辑器里所有会变的量（源图、裁切框、部位列表、拖拽现场、卡片原文）。
 *
 * 为什么集中成一个对象：原先这些是 25 个模块级 let，被画布、拖拽、渲染、保存四处
 * 偷偷读写；出了问题只能靠通读全文猜「谁把它改了」。收进一个对象后，函数签名里
 * 出现 editorState 就说明它会改状态，纯函数则完全不碰。
 * 依赖方向：只 import 类型（契约 + 几何 + 命中形状），不 import 任何别的编辑器模块。
 */

import type { PackRegionDraft } from "../../shared/contracts/ipc";
import type { Point, Rect } from "./geometry";
import type { Shape } from "../hit";

export interface DragState {
  readonly mode: "new" | "move" | "resize";
  readonly corner: string;
  readonly origin: Rect;
  readonly start: Point;
}

export interface RegionDragState {
  readonly kind: "move" | "resize";
  readonly index: number;
  readonly corner: string;
  readonly start: Point;
  readonly origin: Rect;
}

export interface EditorState {
  sourceImage: HTMLImageElement | null;
  sourceFileName: string;
  cropRect: Rect | null;
  croppedCanvas: HTMLCanvasElement | null;
  croppedDataUrl: string;
  regions: PackRegionDraft[];
  activeRegion: number;
  /** 裁切框的拖拽现场（与 regionDrag 区分：那个拖的是部位框）。 */
  cropDrag: DragState | null;
  regionStart: Point | null;
  regionPending: Rect | null;
  /** 编辑模式（T2.5）：只改当前角色的 hits.json，不碰立绘 / 卡片。 */
  editMode: boolean;
  /** 角色卡模式（T2.7）：只改 card.json / pack.json 的人设与显示名。 */
  cardMode: boolean;
  /** 打开编辑器时的部位快照：「撤销本次改动」/ 保存成功后回滚到这里（T2.8）。 */
  originalRegions: PackRegionDraft[];
  /** 视觉原点（0–1 画布坐标）：Live2D 视线的支点；不是触摸部位，不进 regions[]（T2.28）。 */
  lookAtOrigin: Point;
  /** 「放到脸部中心」的建议值（faceRig / 脸 / 头 / 默认）。 */
  suggestedLookAtOrigin: Point;
  originalLookAtOrigin: Point;
  /** 当前是否在拖 / 选视觉原点（普通部位行不被选中）。 */
  originMode: boolean;
  originDrag: boolean;
  originInfoNode: HTMLElement | null;
  editCharId: string;
  editDisplayName: string;
  /** 新画的框用什么形状（T2.44）：矩形最常用，椭圆适合头 / 眼睛，多边形留给发梢、裙摆。 */
  shapeKind: Shape["kind"];
  /** 多边形草稿的顶点（归一化坐标）；空数组表示没在画多边形。 */
  polyPoints: Point[];
  /** 鼠标悬停位置与命中的部位 id：用来画「命中预览」（T2.44）。 */
  hoverPoint: Point | null;
  hoverIndex: number;
  /** 已有框的拖移 / 缩放现场；null 表示当前是在画新框或空闲。 */
  regionDrag: RegionDragState | null;
}

export const editorState: EditorState = {
  sourceImage: null,
  sourceFileName: "",
  cropRect: null,
  croppedCanvas: null,
  croppedDataUrl: "",
  regions: [],
  activeRegion: -1,
  cropDrag: null,
  regionStart: null,
  regionPending: null,
  editMode: false,
  cardMode: false,
  originalRegions: [],
  lookAtOrigin: { x: 0.5, y: 0.35 },
  suggestedLookAtOrigin: { x: 0.5, y: 0.35 },
  originalLookAtOrigin: { x: 0.5, y: 0.35 },
  originMode: false,
  originDrag: false,
  originInfoNode: null,
  editCharId: "",
  editDisplayName: "",
  shapeKind: "rect",
  polyPoints: [],
  hoverPoint: null,
  hoverIndex: -1,
  regionDrag: null,
};
