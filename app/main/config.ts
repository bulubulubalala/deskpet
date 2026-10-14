/**
 * 文件职责：主进程运行时配置与路径推导（纯函数，不 import electron，便于单测）。
 *
 * 为什么集中在这里：窗口、托盘、sidecar 拉起、日志都要用同一批路径与超时参数；
 * 各模块自己拼路径会出现「开发模式写仓库 data/、打包后写 userData/」这类分叉（CODE_STYLE §1.6）。
 * 依赖方向：main -> node（path）；不依赖 electron，也不依赖 sidecar 的 Python 代码。
 * 谁调用：app/main/index.ts 在 app.whenReady 之后装配；tests 直接单测。
 */
import { join } from "node:path";

/** 回环地址：sidecar 只监听本机，不暴露到局域网（需求 §6.3）。 */
export const DEFAULT_SIDECAR_HOST = "127.0.0.1";
/** 与 sidecar/config.py 的默认值一致；被占时 sidecar 会回退到系统分配端口（T0.5 实测）。 */
export const DEFAULT_SIDECAR_PORT = 8737;
/** 心跳节奏：每 2s 探一次 /health（需求 §7.2）。 */
export const DEFAULT_HEALTH_POLL_MS = 2000;
/**
 * 需求 §6.3 要求 /health 在 10ms 内返回，那说的是 sidecar 的处理预算，不是网络往返预算；
 * 客户端给 500ms，避免 Windows 首次连接的握手开销被误判成失败（T0.5 实测首连 141ms）。
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 500;
/** 端口握手上限 10s；超时按 §6.7 的 C 级处理（明示失败 + 导出日志）。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** 握手轮询间隔：runtime.json 是原子写，100ms 足够及时又不会打满磁盘。 */
export const DEFAULT_HANDSHAKE_INTERVAL_MS = 100;
/** 连续失败多少次判离线（需求 §7.2）。 */
export const DEFAULT_MAX_HEALTH_FAILURES = 3;
/** 自动重启预算：连挂 3 次就明示失败，不无限重启（需求 §7.2）。 */
export const DEFAULT_MAX_AUTO_RESTARTS = 3;

export interface MainConfig {
  /** 开发模式（未打包）：从仓库根找 sidecar 源码与 .venv。 */
  readonly isDev: boolean;
  /** 应用根目录：开发模式是仓库根，打包后是 app.getAppPath()。 */
  readonly appRoot: string;
  /** 打包后的 resources 目录（process.resourcesPath），sidecar.exe 放在它下面。 */
  readonly resourcesRoot: string;
  /** 运行时数据目录（已 gitignore）：runtime.json 与 logs 都在这里。 */
  readonly dataDir: string;
  readonly runtimePath: string;
  readonly logsDir: string;
  /** 主进程日志；sidecar 自己写 sidecarLogFile，两个进程不抢同一个文件。 */
  readonly mainLogFile: string;
  readonly sidecarLogFile: string;
  readonly host: string;
  readonly preferredPort: number;
  readonly healthPollMs: number;
  readonly healthTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly handshakeIntervalMs: number;
  readonly maxHealthFailures: number;
  readonly maxAutoRestarts: number;
}

export interface MainConfigInput {
  readonly isDev: boolean;
  readonly appRoot: string;
  readonly resourcesRoot: string;
  readonly userDataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** 解析数字型环境变量：空、非数字、非正数一律回退默认值——一个坏变量不该让应用起不来。 */
export function positiveNumberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 由启动环境推导出全部配置；路径一律用 path.join，避免反斜杠被当成转义。 */
export function loadMainConfig(input: MainConfigInput): MainConfig {
  const fallbackDataDir = input.isDev ? join(input.appRoot, "data") : join(input.userDataDir, "data");
  const dataDir = input.env["DESKPET_DATA_DIR"] ?? fallbackDataDir;
  const logsDir = join(dataDir, "logs");
  return {
    isDev: input.isDev,
    appRoot: input.appRoot,
    resourcesRoot: input.resourcesRoot,
    dataDir,
    runtimePath: join(dataDir, "runtime.json"),
    logsDir,
    mainLogFile: join(logsDir, "deskpet-main.log"),
    sidecarLogFile: join(logsDir, "deskpet.log"),
    host: input.env["DESKPET_SIDECAR_HOST"] ?? DEFAULT_SIDECAR_HOST,
    preferredPort: positiveNumberOr(input.env["DESKPET_SIDECAR_PORT"], DEFAULT_SIDECAR_PORT),
    healthPollMs: positiveNumberOr(input.env["DESKPET_HEALTH_POLL_MS"], DEFAULT_HEALTH_POLL_MS),
    healthTimeoutMs: positiveNumberOr(
      input.env["DESKPET_HEALTH_TIMEOUT_MS"],
      DEFAULT_HEALTH_TIMEOUT_MS,
    ),
    handshakeTimeoutMs: positiveNumberOr(
      input.env["DESKPET_HANDSHAKE_TIMEOUT_MS"],
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
    ),
    handshakeIntervalMs: positiveNumberOr(
      input.env["DESKPET_HANDSHAKE_INTERVAL_MS"],
      DEFAULT_HANDSHAKE_INTERVAL_MS,
    ),
    maxHealthFailures: DEFAULT_MAX_HEALTH_FAILURES,
    maxAutoRestarts: DEFAULT_MAX_AUTO_RESTARTS,
  };
}
