/**
 * 文件职责：sidecar 客户端的契约形状、错误类型与超时常量（原 sidecar-client.ts 的前半段）。
 *
 * 为什么拆出来：这些形状是「调用 sidecar」这件事的输入输出说明，与怎么发请求无关；
 * 拆开后 client 只谈请求，parsers 只谈把返回值读成契约，改一处不会牵动另一处。
 * 依赖方向：main -> app/shared/contracts（类型）+ ./logger；不 import electron。
 * 谁调用：app/main/sidecar/parsers.ts、app/main/sidecar-client.ts；
 * 对外仍由 app/main/sidecar-client.ts 原样转发，既有 import 路径不变。
 */
export interface PresenceRequest {
  readonly char_id: string;
  readonly session_id?: string;
  readonly window_visible: boolean;
  readonly window_minimized: boolean;
  readonly window_focused: boolean;
  readonly idle_seconds: number;
  readonly input_mode: string;
  readonly turn_active: boolean;
  readonly quiet_hours: boolean;
  readonly screen_changed: boolean;
  readonly screen_text: string;
  readonly mic_busy: boolean;
}

export interface PresenceDecision {
  readonly proactive: boolean;
  readonly kind: string;
  readonly reason: string;
}

/** sidecar 端点：从 runtime.json 来（端口随机、token 每次启动都换）。 */
export interface SidecarEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export interface ScreenCaptureResult {
  readonly summary: string;
  readonly interesting: boolean;
  readonly confidence: number;
  readonly visionModel: string;
  readonly capturedAt: string;
  readonly appTitle: string;
}

export interface ScreenOcrResult {
  readonly text: string;
  readonly confidence: number;
  readonly engine: string;
  readonly elapsedMs: number;
}

/** sidecar 明确回了错误信封（业务性失败）：调用方可以按 code 决定降级动作。 */
export class SidecarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly userHint?: string,
  ) {
    super(message);
    this.name = "SidecarHttpError";
  }
}

/** 连不上 / 连接被中断：sidecar 没起来或正在重启，属「稍后再试」而不是业务失败。 */
export class SidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarUnavailableError";
  }
}

/** 调用方自己取消的（打断）：不是故障，编排层按「正常收尾」处理。 */
export class SidecarCancelledError extends Error {
  constructor(message = "请求已取消") {
    super(message);
    this.name = "SidecarCancelledError";
  }
}

export interface SidecarClientOptions {
  /** 普通请求超时（合成多留一点余量，TTS 单句上限 30s）。 */
  readonly requestTimeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
/** 导出要把记忆库快照 + 角色包一起压进 zip，慢在磁盘而不是网络，给足两分钟。 */
export const EXPORT_TIMEOUT_MS = 120_000;