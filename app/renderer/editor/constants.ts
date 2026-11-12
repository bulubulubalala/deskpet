/**
 * 文件职责：角色包编辑器的固定上限与配色。
 *
 * 为什么单独一个文件：这些数字既是界面上的即时校验，也是最终写进角色包的值；
 * 原先散在画布/拖拽/保存三段代码里，改一个上限要在四个地方找，还容易只改一半。
 * 依赖方向：无（纯常量，任何人都可以 import）。
 */
import {
  DEFAULT_REGION_COLOR,
  MAX_PORTRAIT_BYTES,
  MAX_REGION_PADDING,
  MAX_REGION_POLY_POINTS,
  MAX_REGION_PRIORITY,
  PACK_ID_PATTERN,
} from "../../shared/pack-limits";

/** 画布显示上限：图片按这个尺寸等比缩放，坐标换算仍用 canvas 的像素尺寸。 */
export const CANVAS_MAX_WIDTH = 620;
export const CANVAS_MAX_HEIGHT = 430;
/** 框小于这个像素边长就当没画（防止误点产生一个看不见的框）。 */
export const MIN_CROP_PX = 16;
/** 部位框最小边长（归一化）：太小的框在立绘上几乎点不到。 */
export const MIN_REGION_SIDE = 0.02;
/** 部位默认名（只影响界面文案，不写死任何规则）。 */
export const BODY_REGION_NAME = "身体";
export const DEFAULT_REGION_PADDING = 0.01;
/** 多边形：至少 3 点；上限与主进程读回时的一致。 */
export const POLY_MIN_POINTS = 3;
export const POLY_MAX_POINTS = MAX_REGION_POLY_POINTS;

/**
 * 写盘规则一律来自 shared/pack-limits（主进程写入校验、读取兜底、这里提前挡，三处同一份）。
 * 重新导出是为了编辑器内部继续从 ./constants 取，不必层层改 import。
 */
export {
  DEFAULT_REGION_COLOR,
  MAX_PORTRAIT_BYTES,
  MAX_REGION_PADDING,
  MAX_REGION_POLY_POINTS,
  MAX_REGION_PRIORITY,
  PACK_ID_PATTERN,
};

export const REGION_COLORS: readonly string[] = [
  "#ff6b6b",
  "#ffb347",
  "#ffe66d",
  "#6bcB77",
  "#4ecdc4",
  "#54a0ff",
  "#a29bfe",
  "#ff9ff3",
];
