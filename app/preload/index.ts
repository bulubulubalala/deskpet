/**
 * preload 桥（占位）。
 *
 * 职责：只暴露白名单里的 IPC 方法给 renderer（需求 §6.3）；不把 ipcRenderer 原样交给页面。
 * 依赖方向：preload → main 暴露的通道常量；禁止 import renderer。
 * 谁调用：electron（M0 / T0.6 接上真实实现）。
 */
export const MODULE_NAME = "app/preload/index.ts" as const;
