/**
 * 文件职责：读 sidecar 落盘的 data/runtime.json —— 端口握手的唯一依据（需求 §6.10）。
 *
 * 为什么用文件而不是读 stdout：sidecar 由 .venv 的 python.exe 启动时，launcher 会再起一个
 * 子进程，stdout 里混着 Python 缓冲与 launcher 输出（T0.5 实测 Popen 40128 / runtime.json 39076）；
 * 文件是两侧都能看见、且原子落盘的稳定通道。
 * 依赖方向：main -> node（fs/promises、process.kill 探活）；不 import electron。
 * 谁调用：app/main/sidecar-process.ts。
 */
import { readFile } from "node:fs/promises";

/** runtime.json 的六个字段，缺一不可（写入侧是 sidecar/contracts/runtime.py）。 */
export interface SidecarRuntime {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly started_at: string;
  readonly version: string;
}

/** 握手相关的失败，调用方据此走 §6.7 的 C 级处理（明示失败 + 导出日志）。 */
export class RuntimeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeFileError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** 解析并校验 runtime.json；字段缺失或类型不对就抛错，绝不猜（字段名写进错误里便于排查）。 */
export function parseRuntime(raw: string): SidecarRuntime {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RuntimeFileError("runtime.json 不是合法 JSON：" + String(error));
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new RuntimeFileError("runtime.json 顶层不是 JSON 对象");
  }
  const { pid, host, port, token, started_at: startedAt, version } = record;
  const bad: string[] = [];
  if (typeof pid !== "number") bad.push("pid");
  if (typeof host !== "string") bad.push("host");
  if (typeof port !== "number") bad.push("port");
  if (typeof token !== "string") bad.push("token");
  if (typeof startedAt !== "string") bad.push("started_at");
  if (typeof version !== "string") bad.push("version");
  if (bad.length > 0) {
    // 只报坏字段名，绝不把 token 之类的内容带进错误文本
    throw new RuntimeFileError("runtime.json 字段缺失或类型不对：" + bad.join("、"));
  }
  // 上面已逐字段校验过类型；分支里只 push 不 return，TS 的 typeof 收窄不会生效，所以这里显式断言
  return {
    pid: pid as number,
    host: host as string,
    port: port as number,
    token: token as string,
    started_at: startedAt as string,
    version: version as string,
  };
}

/** 读 runtime.json；文件不存在或内容损坏一律返回 null（调用方按「还没起来」处理）。 */
export async function readRuntime(path: string): Promise<SidecarRuntime | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parseRuntime(raw);
  } catch {
    return null;
  }
}

/** 用信号 0 探活；Windows 上对「进程存在但无权限」会抛 EPERM，这种情况也算活着。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WaitForRuntimeOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  /** 注入时钟与休眠，测试里不用真的等 10s。 */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 轮询等 sidecar 写出 runtime.json；超时抛 RuntimeFileError（不无限等，见需求 §6.10）。 */
export async function waitForRuntime(
  path: string,
  options: WaitForRuntimeOptions,
): Promise<SidecarRuntime> {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const runtime = await readRuntime(path);
    if (runtime !== null) {
      return runtime;
    }
    if (now() >= deadline) {
      throw new RuntimeFileError(
        "等待 sidecar 端口握手超时（" + options.timeoutMs + "ms）：没有读到 " + path,
      );
    }
    await sleep(options.intervalMs);
  }
}
