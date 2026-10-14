/**
 * 文件职责：renderer ↔ main 的 IPC 白名单契约（channel 常量 + payload 类型）。
 *
 * 依据：需求 §6.3（sidecar HTTP API）、§6.10（IPC 白名单）、CODE_STYLE §1.1 / §1.3。
 * 依赖方向：本模块不 import electron；main 用它注册 handler，preload 用它暴露白名单方法。
 * 谁调用：app/main/index.ts 与 app/preload/index.ts（T0.6 接上）。
 */

/** 白名单通道：只允许这些名字出现在 ipcMain.handle / ipcRenderer.invoke。 */
export const IPC_CHANNELS = {
  /** renderer 拉取一次心跳快照（main 转发 sidecar GET /health） */
  healthGet: "deskpet:health:get",
  /** main 推送心跳变化（连续 3 次失败判定离线后也会推，需求 §7.2） */
  healthChanged: "deskpet:health:changed",
  /** 手动重启 sidecar（不替用户修语音引擎，D14） */
  sidecarRestart: "deskpet:sidecar:restart",
  /** 取应用与 sidecar 的基本信息（版本号、端口、pid） */
  appGetInfo: "deskpet:app:get-info",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** 会被心跳观察的模块名，与 sidecar/contracts/health.py 的 ModuleName 对齐。 */
export const MODULE_NAMES = ["tts", "asr", "llm", "memory", "screen", "stage"] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

/** 模块状态，与 sidecar/contracts/health.py 的 ModuleState 对齐。 */
export const MODULE_STATES = ["idle", "loading", "ready", "error", "offline"] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

/** ModuleHealth 的字段清单（运行时可取，供跨语言契约测试对账）。 */
export const MODULE_HEALTH_FIELDS = ["name", "state", "detail"] as const;

export interface ModuleHealth {
  name: ModuleName;
  state: ModuleState;
  detail?: string;
}

/** GpuUsage 的字段清单（运行时可取）。 */
export const GPU_USAGE_FIELDS = ["loaded_mb", "total_mb"] as const;

export interface GpuUsage {
  loaded_mb: number;
  total_mb?: number;
}

/** sidecar GET /health 的镜像；字段名必须与 contracts/health.py 的 HealthResponse 一致。 */
export const HEALTH_SNAPSHOT_FIELDS = ["status", "uptime_s", "modules", "gpu", "version"] as const;

export interface HealthSnapshot {
  status: "ok" | "degraded" | "starting";
  uptime_s: number;
  modules: ModuleHealth[];
  gpu: GpuUsage;
  version: string;
}

/** IPC appGetInfo 的返回：sidecar 未起来时端口与 pid 为空。 */
export interface AppInfo {
  app_version: string;
  sidecar_port?: number;
  sidecar_pid?: number;
}
