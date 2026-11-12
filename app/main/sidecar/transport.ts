/**
 * 文件职责：sidecar HTTP 传输层——一条请求从拼头发到读回响应的全过程（需求 §6.3）。
 *
 * 为什么单独一层：客户端里 40 多个业务方法（聊天/语音/记忆/数据）关心的是「路径、参数、怎么读回来」，
 * 但真正容易出错的却是同一套东西：回环 token 头、超时、abort 与 signal 的先后顺序、错误信封还原、
 * 非 2xx 的日志。把这些收在传输层，业务方法只剩翻译参数，测试也可以直接用假端点打这一层。
 * 依赖方向：main/sidecar/transport -> node:http + ./types（形状与错误）+ ./parsers（读数）+ ../logger。
 * 谁调用：app/main/sidecar-client.ts（每个业务方法都经过它）。
 */
import { request as httpRequest, type IncomingMessage } from "node:http";

import type { MainLogger } from "../logger";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  SidecarCancelledError,
  SidecarHttpError,
  SidecarUnavailableError,
  type SidecarEndpoint,
} from "./types";
import { parseErrorEnvelope } from "./parsers";

/** 一次请求的可选项；`timeoutMs` 必填，避免有人忘了给超时。 */
export interface SidecarRequestOptions {
  json?: unknown;
  body?: Buffer;
  contentType?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface SidecarTransportOptions {
  requestTimeoutMs?: number;
}

/**
 * sidecar 的连接端点与请求细节。
 *
 * 端点由引擎在握手成功后设置（重启会换端口与 token），所以这里只保存不推导；
 * 没就绪时任何请求都直接抛 SidecarUnavailableError，业务方法不必自己判空。
 */
export class SidecarTransport {
  private endpoint: SidecarEndpoint | null = null;
  /** 普通请求的默认超时（导出这类慢接口会显式传更长的）。 */
  readonly requestTimeoutMs: number;

  constructor(
    private readonly logger: MainLogger,
    options: SidecarTransportOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** 握手成功后由引擎调用；sidecar 重启会换端口与 token，所以每次都重新设。 */
  setEndpoint(runtime: { host: string; port: number; token: string }): void {
    this.endpoint = { host: runtime.host, port: runtime.port, token: runtime.token };
  }

  clearEndpoint(): void {
    this.endpoint = null;
  }

  get ready(): boolean {
    return this.endpoint !== null;
  }


  /** 发一个 JSON 请求并把响应体当 JSON 读回来；流式接口请直接用 open()。 */
  async requestJson(
    method: string,
    path: string,
    json: unknown,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const response = await this.open(method, path, {
      json,
      timeoutMs: timeoutMs ?? this.requestTimeoutMs,
    });
    const text = (await this.readBody(response)).toString("utf8");
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
    return (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  }

  /** 打开一条请求；2xx 直接给响应流，非 2xx 还原错误信封后抛 SidecarHttpError。 */
  async open(
    method: string,
    path: string,
    options: SidecarRequestOptions,
  ): Promise<IncomingMessage> {
    const endpoint = this.endpoint;
    if (endpoint === null) {
      throw new SidecarUnavailableError("sidecar 还没就绪（没有 runtime.json 端点）");
    }
    const payload =
      options.json === undefined ? options.body : Buffer.from(JSON.stringify(options.json), "utf8");
    const headers: Record<string, string> = {
      "X-Deskpet-Token": endpoint.token,
      Accept: "application/json, text/event-stream",
    };
    if (payload !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/json";
      headers["Content-Length"] = String(payload.byteLength);
    }
    return await new Promise<IncomingMessage>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (!settled) {
          settled = true;
          action();
        }
      };
      const request = httpRequest(
        { host: endpoint.host, port: endpoint.port, method, path, headers },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            finish(() => resolve(response));
            return;
          }
          void this.readBody(response)
            .then((body) => {
              const parsed = parseErrorEnvelope(body.toString("utf8"));
              const detail = {
                status,
                code: parsed.code,
                message: parsed.message,
                ...(parsed.userHint === undefined ? {} : { userHint: parsed.userHint }),
              };
              this.logger.warn("sidecar.http_error", path + " 返回 " + String(status), {
                module: "sidecar",
                fields: { path, status, code: parsed.code },
              });
              finish(() =>
                reject(new SidecarHttpError(status, detail.code, detail.message, detail.userHint)),
              );
            })
            .catch(() => {
              finish(() =>
                reject(new SidecarHttpError(status, "", "sidecar 返回了错误但读不出内容")),
              );
            });
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        finish(() =>
          reject(
            new SidecarUnavailableError(path + " 超时（" + String(options.timeoutMs) + "ms）"),
          ),
        );
      }, options.timeoutMs);
      const abort = (): void => {
        request.destroy();
        finish(() => reject(new SidecarCancelledError()));
      };
      // 先挂监听再处理信号：信号已 abort 时 destroy() 会同步抛 socket hang up，
      // 没有 error 监听就变成进程级 uncaught（vitest 会直接判失败）
      request.on("error", (error) => {
        clearTimeout(timer);
        finish(() => reject(new SidecarUnavailableError(path + " 连不上：" + error.message)));
      });
      request.on("close", () => {
        clearTimeout(timer);
      });
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          abort();
          return;
        }
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          abort();
        });
      }
      if (payload !== undefined) {
        request.write(payload);
      }
      request.end();
    });
  }

  async readBody(response: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  header(response: IncomingMessage, name: string, fallback: string): string {
    const value = response.headers[name];
    return typeof value === "string" && value.length > 0 ? value : fallback;
  }

  numberHeader(response: IncomingMessage, name: string): number {
    const value = this.header(response, name, "");
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

export * from "./types";