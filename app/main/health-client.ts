/**
 * 文件职责：主进程侧的 GET /health 客户端——唯一被轮询的接口（需求 §6.3）。
 *
 * 为什么手写 node:http 而不用 fetch：只需要一个「500ms 内给答案或报错」的小请求，
 * 手写能精确控制超时与 socket 生命周期，也不给主进程加依赖（CODE_STYLE §1.2）。
 * 依赖方向：main -> node:http + ./ipc（类型）；不 import electron。
 * 谁调用：app/main/engine.ts（心跳轮询）。
 */
import { request } from "node:http";

import type {
  HealthSnapshot,
  ModuleHealth,
  ModuleName,
  ModuleState,
  ProviderCapability,
  ProviderHealth,
  VoiceState,
} from "./ipc";

const HEALTH_STATUSES: ReadonlySet<string> = new Set(["ok", "degraded", "starting"]);
const VOICE_STATE_NAMES: ReadonlySet<string> = new Set([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "cancelling",
]);
const MODULE_STATE_NAMES: ReadonlySet<string> = new Set([
  "idle",
  "loading",
  "ready",
  "error",
  "offline",
]);
const PROVIDER_CAPABILITY_NAMES: ReadonlySet<string> = new Set(["llm", "asr", "tts"]);

/** /health 的响应不符合契约时抛这个，调用方按「这次心跳失败」处理。 */
export class HealthResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthResponseError";
  }
}

export interface HealthClientOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly timeoutMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 解析模块条目：坏掉的单条跳过，其余照常上报——一个模块的脏数据不该把整盏灯打灭。
 * name 只做「非空字符串」校验后按 ModuleName 使用：字段全集由 sidecar 的契约测试保证（§1.8）。
 */
function parseModules(value: unknown): ModuleHealth[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const modules: ModuleHealth[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) {
      continue;
    }
    const name = record["name"];
    const state = record["state"];
    if (typeof name !== "string" || typeof state !== "string" || !MODULE_STATE_NAMES.has(state)) {
      continue;
    }
    const detail = record["detail"];
    const entry: ModuleHealth = {
      name: name as ModuleName,
      state: state as ModuleState,
    };
    modules.push(typeof detail === "string" ? { ...entry, detail } : entry);
  }
  return modules;
}

/**
 * 解析模型供给条目：坏掉的单条跳过（与 parseModules 同样的宽容度，§6.13）。
 * 这里只做「认得出来」的校验，字段全集由契约测试保证。
 */
function parseProviders(value: unknown): ProviderHealth[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const providers: ProviderHealth[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) {
      continue;
    }
    const capability = record["capability"];
    const name = record["name"];
    if (
      typeof capability !== "string" ||
      !PROVIDER_CAPABILITY_NAMES.has(capability) ||
      typeof name !== "string"
    ) {
      continue;
    }
    const detail = record["detail"];
    const entry: ProviderHealth = {
      capability: capability as ProviderCapability,
      name,
      // configured 不是布尔值时按未配置处理：宁可少报「可用」，也不假装引擎在。
      configured: record["configured"] === true,
    };
    providers.push(typeof detail === "string" ? { ...entry, detail } : entry);
  }
  return providers;
}

/** 校验并归一化 /health 响应（严格认 status，字段缺失给安全默认值而不是整条丢弃）。 */
export function parseHealthResponse(raw: unknown): HealthSnapshot {
  const record = asRecord(raw);
  if (record === null) {
    throw new HealthResponseError("/health 响应不是 JSON 对象");
  }
  const status = record["status"];
  if (typeof status !== "string" || !HEALTH_STATUSES.has(status)) {
    throw new HealthResponseError("/health 的 status 不认识：" + String(status));
  }
  const voice = record["voice"];
  return {
    status: status as HealthSnapshot["status"],
    uptime_s: asNumber(record["uptime_s"], 0),
    modules: parseModules(record["modules"]),
    providers: parseProviders(record["providers"]),
    // 语音状态缺失或认不出来时按 idle 处理：状态机是「锦上添花」，不该让整条心跳失败。
    voice:
      typeof voice === "string" && VOICE_STATE_NAMES.has(voice) ? (voice as VoiceState) : "idle",
    version: typeof record["version"] === "string" ? record["version"] : "unknown",
  };
}

export class HealthClient {
  private host: string;
  private port: number;
  private token: string;
  private readonly timeoutMs: number;

  constructor(options: HealthClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
  }

  /** 握手成功后用 runtime.json 里的真实值刷新：sidecar 端口被占时会回退到系统分配端口（T0.5）。 */
  setEndpoint(runtime: { host: string; port: number; token: string }): void {
    this.host = runtime.host;
    this.port = runtime.port;
    this.token = runtime.token;
  }

  async fetchHealth(): Promise<HealthSnapshot> {
    const body = await this.requestHealth();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HealthResponseError("/health 响应不是合法 JSON");
    }
    return parseHealthResponse(parsed);
  }

  private requestHealth(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: this.host,
          port: this.port,
          path: "/health",
          method: "GET",
          headers: this.token === "" ? {} : { "X-Deskpet-Token": this.token },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => {
            if (status !== 200) {
              reject(new HealthResponseError("/health 返回 " + status + "：" + body.slice(0, 200)));
              return;
            }
            resolve(body);
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new HealthResponseError("/health 超时（" + this.timeoutMs + "ms）"));
      });
      req.on("error", (error: Error) => {
        reject(
          error instanceof HealthResponseError
            ? error
            : new HealthResponseError("/health 请求失败：" + error.message),
        );
      });
      req.end();
    });
  }
}
