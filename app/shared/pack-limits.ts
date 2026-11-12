/**
 * 文件职责：角色包的硬性上限与格式（char_id、立绘体积、部位数量、字段时间、颜色、优先级…）。
 *
 * 为什么放在 shared：同一条规则原先有三份拷贝——主进程写入时校验（pack-editor/rules.ts）、
 * 主进程读取时兜底（character-assets.ts）、编辑器界面上提前挡一遍（renderer/editor/constants.ts）。
 * 三份里漏改一份，就会出现「界面允许保存、读回来被截断」这种最难查的错。
 * 依赖方向：不依赖任何东西（纯常量 + 正则）；主进程与渲染层都可以 import，不得引入 electron / node。
 */

/** char_id 同时是目录名（sidecar/contracts/character.py 的 PackInfo 用同一套规则）。 */
export const PACK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 立绘体积上限：data URL 要塞进 IPC，几十 MB 的图不该走这条路。 */
export const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024;
/** 一个角色最多几个部位框（写进去的与读回来的必须是同一个数）。 */
export const MAX_REGIONS = 24;
/** 部位名最长多少字。 */
export const REGION_NAME_MAX = 24;
/** 卡片四个文字字段各自的上限。 */
export const CARD_TEXT_MAX = 2000;
/** 部位框默认颜色。 */
export const DEFAULT_REGION_COLOR = "#ffb347";
/** 颜色只接受 #rgb / #rrggbb。 */
export const COLOR_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
/** 部位可选扩展字段的上限（T2.44）：编辑器写进去的值必须能被读回来。 */
export const MAX_REGION_PRIORITY = 100;
export const MAX_REGION_PADDING = 0.2;
/** 每个部位最多绑几个 Live2D 网格（T2.42）。 */
export const MAX_REGION_DRAWABLES = 8;
/** 多边形最多几个顶点。 */
export const MAX_REGION_POLY_POINTS = 64;
