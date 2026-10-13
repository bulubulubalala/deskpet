/**
 * Electron 主进程入口（占位）。
 *
 * 职责：应用生命周期、窗口与托盘、sidecar 拉起与心跳、IPC 白名单的本端实现。
 * 依赖方向：main → preload（仅类型）/ IPC 白名单；禁止直接 import renderer（CODE_STYLE §1.1）。
 * 谁调用：electron（M0 / T0.6 接上真实实现）。
 */
export const MODULE_NAME = "app/main/index.ts" as const;
