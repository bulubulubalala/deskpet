/**
 * 渲染进程入口（占位）。
 *
 * 职责：聊天界面、Live2D / PNG Stage、设置页；一切重活都通过 preload 白名单走 sidecar。
 * 依赖方向：renderer → preload 暴露的 API；禁止 import main。
 * 谁调用：electron（M0 / T0.6 接上真实实现）。
 */
export const MODULE_NAME = "app/renderer/index.ts" as const;
