/**
 * 文件职责：动态命中框的夹取规则（T2.42）——网格算出来的框不能跑到作者画的框太远。
 *
 * 为什么单独一层：网格的外接框会被姿势放大好几倍（手一抬，袖子网格能垂到大腿；胯的网格
 * 能盖住整条腿），所以只允许它在作者画的框外再扩一个固定倍数，交集为空就退回静态框。
 * 这条规则是「手感」的一部分，改它要能单独看、单独测。
 * 依赖方向：只有几何（./hit 的形状工具），不 import pixi / DOM。
 */
import type { CharHitRegion } from "../../shared/contracts/ipc";
import { shapeBounds, shapeOf, type Bounds, type Shape } from "../hit";

/** 动态框最多比作者画的框大多少倍：1.4 是「能跟上动作，又抢不走隔壁部位」的折中。 */
export const DYNAMIC_SHAPE_SLACK = 1.4;

/**
 * 把网格框夹进「作者框外扩 slack 倍」的范围里；交集为空返回 null（调用方退回静态形状）。
 */
export function clampToAuthored(region: CharHitRegion, dynamic: Bounds): Shape | null {
  const authored = shapeBounds(shapeOf(region));
  const slackX = (authored.w * (DYNAMIC_SHAPE_SLACK - 1)) / 2;
  const slackY = (authored.h * (DYNAMIC_SHAPE_SLACK - 1)) / 2;
  const minX = Math.max(dynamic.x, authored.x - slackX);
  const minY = Math.max(dynamic.y, authored.y - slackY);
  const maxX = Math.min(dynamic.x + dynamic.w, authored.x + authored.w + slackX);
  const maxY = Math.min(dynamic.y + dynamic.h, authored.y + authored.h + slackY);
  if (maxX <= minX || maxY <= minY) {
    return null;
  }
  return { kind: "rect", x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
