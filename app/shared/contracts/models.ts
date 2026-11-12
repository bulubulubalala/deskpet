/**
 * 文件职责：模型广场（本机模型文件的安装状态与下载进度）的共享契约。
 *
 * 依赖方向：只含类型，不 import 任何运行时模块；main 的 model-manager.ts 与界面层共用它。
 */
export type ModelCapability = "asr" | "tts" | "vision" | "embedding";
export type ModelKind = "files" | "archive" | "ollama" | "external" | "bundled";

export interface ModelStatus {
  id: string;
  capability: ModelCapability;
  label: string;
  description: string;
  kind: ModelKind;
  size_mb: number;
  license: string;
  installed: boolean;
  detail: string;
  model_id: string;
}

export interface ModelProgress {
  id: string;
  percent: number;
  message: string;
  done: boolean;
  error: string;
}

/** 语音识别模型的四种状态：就绪 / 还没下 / 正在下 / 上次失败（D7）。 */
export type AsrModelStatus = "ready" | "missing" | "downloading" | "error";

/** 语音识别模型现状；与 sidecar contracts/asr_model.py 的 AsrModelState 逐字对齐。 */
export interface AsrModelState {
  status: AsrModelStatus;
  provider: string;
  model: string;
  downloaded_bytes: number;
  estimated_bytes: number;
  /** 0–1；估不出体积时是 0，就绪时是 1。 */
  progress: number;
  /** 一句给用户看的话（已下载多少 / 上次为什么失败）。 */
  message: string;
  /** 下一步怎么办（配镜像、重试、改用云端）。 */
  user_hint: string;
}
