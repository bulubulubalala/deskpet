/**
 * 文件职责：主进程运行时配置与路径推导（纯函数，不 import electron，便于单测）。
 *
 * 为什么集中在这里：窗口、托盘、sidecar 拉起、日志都要用同一批路径与超时参数；
 * 各模块自己拼路径会出现「开发模式写仓库 data/、打包后写 userData/」这类分叉（CODE_STYLE §1.6）。
 * 依赖方向：main -> node（path）；不依赖 electron，也不依赖 sidecar 的 Python 代码。
 * 谁调用：app/main/index.ts 在 app.whenReady 之后装配；tests 直接单测。
 */
import { dirname, join } from "node:path";

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
/**
 * 便携模式开关：在 deskpet.exe 同级放一个同名空文件即生效。
 * 为什么用「文件存在」而不是设置项：便携的目的是「拷走整个文件夹就等于拷走一切」，
 * 开关本身也必须跟着文件夹走，不能存在 %APPDATA% 里。
 */
export const PORTABLE_MARKER = "portable.txt";

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
  /** 传给 sidecar 的完整环境变量（设置文件合并进程环境、去掉 undefined）；T1.3 起 LLM key 只走这里。 */
  readonly childEnv: Readonly<Record<string, string>>;
  /** 旧 .env 的实际路径（D4 起只在首次启动迁移时读）；只用来在日志里说明历史来源，绝不打印内容。 */
  readonly envFile: string;
  /** 角色包目录（§6.1）：主进程读参考音与情感向量、sidecar 加载角色卡，两边必须是同一个。 */
  readonly charactersDir: string;
  /** 打包时随应用带出的默认角色目录；开发态通常不存在。 */
  readonly defaultCharactersDir: string;
  /**
   * 「发布包根」：开发态是仓库 assets/，打包态是 deskpet.exe 所在目录。
   * 带进发布包的东西（内置模型、使用说明）都从这两个镜像位置读，路径规则才能两态一致。
   */
  readonly bundledRoot: string;
  /** 内置向量模型目录：bundledRoot/models/embedding（T2.40，zip 解压即用）。 */
  readonly embedModelDir: string;
}

export interface MainConfigInput {
  readonly isDev: boolean;
  readonly appRoot: string;
  readonly resourcesRoot: string;
  readonly userDataDir: string;
  /** 已合并的最后环境变量（index.ts 负责把设置文件并进来，本函数保持纯函数可单测）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 旧 .env 的路径；不传则记为空串（单测只关心别处时不必造它）。 */
  readonly envFile?: string;
  /** process.execPath（打包态即 deskpet.exe 的绝对路径）：用来定位发布包根目录。 */
  readonly execPath?: string;
  /** 便携模式（exe 同级有 PORTABLE_MARKER）：数据与角色都留在这个文件夹里。 */
  readonly portable?: boolean;
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
  // 发布包根：开发态是仓库根，打包态是 exe 所在目录（bundledRoot 与便携数据目录共用它）。
  const bundleRoot = input.isDev ? input.appRoot : dirname(input.execPath ?? input.appRoot);
  const portable = input.portable === true;
  // 便携模式：数据留在发布包根（U 盘/单文件夹带走）；默认写 userData，因为安装目录常不可写、
  // 多账户共用安装会串库、升级覆盖安装目录会丢数据。
  const fallbackDataDir = portable
    ? join(bundleRoot, "data")
    : input.isDev
      ? join(input.appRoot, "data")
      : join(input.userDataDir, "data");
  const dataDir = input.env["DESKPET_DATA_DIR"] ?? fallbackDataDir;
  const logsDir = join(dataDir, "logs");
  // 子进程环境只保留有值的项：spawn 的 env 类型不接受 undefined，混进一个就会让整次启动失败
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  // 角色包目录在这里定一次并回写进子进程环境：主进程要读 pack 才知道参考音与情感向量，
  // sidecar 也要按同一目录加载。各算一次就会重演 T1.3 那个「默认目录指到仓库外」的坑。
  const charactersDir =
    input.env["DESKPET_CHARACTERS_DIR"] ??
    (portable
      ? join(bundleRoot, "characters")
      : input.isDev
        ? join(input.appRoot, "characters")
        : join(input.userDataDir, "characters"));
  childEnv["DESKPET_CHARACTERS_DIR"] = charactersDir;
  // 发布包根：开发态 assets/ 与打包态 exe 旁边的目录是同一套相对布局（electron-builder.yml
  // 的 extraFiles 把 assets/models/embedding 拷成 models/embedding），所以只算一次。
  const bundledRoot = input.isDev ? join(input.appRoot, "assets") : bundleRoot;
  const embedModelDir = join(bundledRoot, "models", "embedding");
  childEnv["DESKPET_EMBED_MODEL_DIR"] = embedModelDir;
  // 只在「完全没碰过 embedding 配置」时把默认值钉成内置模型（T2.40：zip 解压即用）。
  // 老用户的配置里已经有 DESKPET_EMBED_MODEL/BASE_URL（上一版是 Ollama），必须保持原判，
  // 否则升级后会被静默换模型，已有向量全部作废。
  const embeddingTouched =
    input.env["DESKPET_EMBED_PROVIDER"] !== undefined ||
    input.env["DESKPET_EMBED_MODEL"] !== undefined ||
    input.env["DESKPET_EMBED_BASE_URL"] !== undefined;
  if (!embeddingTouched) {
    childEnv["DESKPET_EMBED_PROVIDER"] = "onnx";
    childEnv["DESKPET_EMBED_ENABLED"] = input.env["DESKPET_EMBED_ENABLED"] ?? "1";
  }
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
    childEnv,
    envFile: input.envFile ?? "",
    charactersDir,
    defaultCharactersDir: join(input.resourcesRoot, "default-characters"),
    bundledRoot,
    embedModelDir,
  };
}
