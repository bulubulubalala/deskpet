/**
 * 文件职责：主进程侧的 sidecar HTTP 客户端（需求 §6.3）——聊天流、语音合成、识别与取消。
 *
 * 为什么单独一个模块：主进程需要的不只是心跳，而是「按契约调 sidecar」的全部细节
 * （回环 token、超时、SSE 解析、错误信封还原）。把这些收在一处，编排层只谈业务。
 * 依赖方向：main -> node:http + ./ipc（类型）+ ./runtime-file（端点类型）+ ./logger；
 * 不 import electron，主进程侧所有网络出口都经过这里（CODE_STYLE §1.1）。
 * 谁调用：app/main/chat-orchestrator.ts（T1.6b）。
 */
import { request as httpRequest, type IncomingMessage } from "node:http";

import { CHAT_EVENT_KINDS, type ChatEvent, type ChatSendRequest } from "./ipc";
import type { MainLogger } from "./logger";

/** sidecar 端点：从 runtime.json 来（端口随机、token 每次启动都换）。 */
export interface SidecarEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

/** 合成结果：音频本体 + sidecar / 引擎给的性能头（T1.13 要把它们记进 MEASURED.md）。 */
export interface TtsAudioResult {
  readonly audio: Buffer;
  readonly contentType: string;
  readonly requestId: string;
  readonly genMs: number;
  readonly audioMs: number;
  readonly rtf: number;
  readonly voice: string;
}

export interface TtsSynthesisRequest {
  readonly text: string;
  readonly voiceId: string;
  readonly lang: string;
  readonly emoVector: readonly number[];
  readonly requestId: string;
  readonly timeoutS?: number;
}

export interface AsrRequest {
  readonly pcm: Buffer;
  readonly sampleRate: number;
  readonly requestId: string;
  readonly lang?: string;
}

export interface AsrResult {
  readonly text: string;
  readonly confidence: number;
  readonly durationS: number;
  readonly language: string | null;
}

export interface TtsCancelResult {
  readonly cancelled: boolean;
  readonly reason?: string;
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

export interface ChatStreamHandlers {
  /** 打断时 abort 这个 signal；实现会立刻销毁请求并抛 SidecarCancelledError。 */
  readonly signal?: AbortSignal;
  readonly onEvent: (event: ChatEvent) => void;
}

export interface SidecarClientOptions {
  /** 普通请求超时（合成多留一点余量，TTS 单句上限 30s）。 */
  readonly requestTimeoutMs?: number;
  readonly chatTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_CHAT_TIMEOUT_MS = 90_000;

/** 解析 SSE 的一行；空行 / 注释 / 坏 JSON 都返回 null（坏行跳过，不让整条流炸掉）。 */
function parseSseLine(line: string): ChatEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice("data:".length).trim();
  if (payload.length === 0 || payload === "[DONE]") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const kind = (parsed as { t?: unknown }).t;
  if (typeof kind !== "string" || !CHAT_EVENT_KINDS.includes(kind as ChatEvent["t"])) {
    return null;
  }
  return parsed as ChatEvent;
}

/** 错误信封还原：sidecar 直返 {code,message,user_hint}，FastAPI HTTPException 会包成 {detail:{...}}。 */
function parseErrorEnvelope(body: string): { code: string; message: string; userHint?: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    const inner = (
      typeof record["detail"] === "object" && record["detail"] !== null ? record["detail"] : record
    ) as Record<string, unknown>;
    const code = typeof inner["code"] === "string" ? inner["code"] : "";
    const message = typeof inner["message"] === "string" ? inner["message"] : body.slice(0, 200);
    const hint = typeof inner["user_hint"] === "string" ? inner["user_hint"] : undefined;
    return hint === undefined ? { code, message } : { code, message, userHint: hint };
  } catch {
    return { code: "", message: body.slice(0, 200) };
  }
}

/** 结果统一成错误类型，避免每个调用点各写一遍。 */
function toClientError(error: unknown, path: string): Error {
  if (error instanceof SidecarHttpError || error instanceof SidecarCancelledError) {
    return error;
  }
  if (error instanceof SidecarUnavailableError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SidecarUnavailableError(path + " 请求失败：" + message);
}

export class SidecarClient {
  private endpoint: SidecarEndpoint | null = null;
  private readonly requestTimeoutMs: number;
  private readonly chatTimeoutMs: number;

  constructor(
    private readonly logger: MainLogger,
    options: SidecarClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.chatTimeoutMs = options.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
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

  /** 会话主链路：POST /chat/stream，逐行喂给 onEvent（§6.2）。 */
  async streamChat(request: ChatSendRequest, handlers: ChatStreamHandlers): Promise<void> {
    const response = await this.open("POST", "/chat/stream", {
      json: request,
      ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
      timeoutMs: this.chatTimeoutMs,
    });
    let buffer = "";
    try {
      for await (const chunk of response) {
        buffer += (chunk as Buffer).toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const event = parseSseLine(line);
          if (event !== null) {
            handlers.onEvent(event);
          }
          index = buffer.indexOf("\n");
        }
      }
      const tail = parseSseLine(buffer);
      if (tail !== null) {
        handlers.onEvent(tail);
      }
    } catch (error) {
      throw toClientError(error, "POST /chat/stream");
    }
  }

  /** 单句合成：POST /tts → audio/wav + 性能头（单句 ≤40 字的约束由 sidecar 再校验一次）。 */
  async synthesize(request: TtsSynthesisRequest, signal?: AbortSignal): Promise<TtsAudioResult> {
    const response = await this.open("POST", "/tts", {
      json: {
        text: request.text,
        voice_id: request.voiceId,
        lang: request.lang,
        emo_vector: request.emoVector,
        request_id: request.requestId,
        ...(request.timeoutS === undefined ? {} : { timeout_s: request.timeoutS }),
      },
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.requestTimeoutMs,
    });
    const audio = await this.readBody(response);
    return {
      audio,
      contentType: response.headers["content-type"] ?? "application/octet-stream",
      requestId: this.header(response, "x-deskpet-request-id", request.requestId),
      genMs: this.numberHeader(response, "x-deskpet-gen-ms"),
      audioMs: this.numberHeader(response, "x-deskpet-audio-ms"),
      rtf: this.numberHeader(response, "x-deskpet-rtf"),
      voice: this.header(response, "x-deskpet-voice", request.voiceId),
    };
  }

  /** 打断：POST /tts/cancel（queued 直接丢弃；in_flight 只标记，真正停播在播放侧）。 */
  async cancelTts(requestId: string): Promise<TtsCancelResult> {
    const body = await this.requestJson("POST", "/tts/cancel", { request_id: requestId });
    return {
      cancelled: body["cancelled"] === true,
      ...(typeof body["reason"] === "string" ? { reason: body["reason"] } : {}),
    };
  }

  /** 识别：POST /asr，请求体是裸 PCM（16kHz int16 小端）。 */
  async transcribe(request: AsrRequest, signal?: AbortSignal): Promise<AsrResult> {
    const query =
      "?sample_rate=" +
      String(request.sampleRate) +
      "&request_id=" +
      encodeURIComponent(request.requestId);
    const queryWithLang =
      request.lang === undefined || request.lang === ""
        ? query
        : query + "&lang=" + encodeURIComponent(request.lang);
    const response = await this.open("POST", "/asr" + queryWithLang, {
      body: request.pcm,
      contentType: "application/octet-stream",
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.requestTimeoutMs,
    });
    const body = JSON.parse((await this.readBody(response)).toString("utf8")) as Record<
      string,
      unknown
    >;
    return {
      text: typeof body["text"] === "string" ? body["text"] : "",
      confidence: typeof body["confidence"] === "number" ? body["confidence"] : 0,
      durationS: typeof body["duration_s"] === "number" ? body["duration_s"] : 0,
      language: typeof body["language"] === "string" ? body["language"] : null,
    };
  }

  // ---- 内部：一次请求的完整生命周期 ----

  private async requestJson(
    method: string,
    path: string,
    json: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await this.open(method, path, { json, timeoutMs: this.requestTimeoutMs });
    const text = (await this.readBody(response)).toString("utf8");
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
    return (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  }

  private async open(
    method: string,
    path: string,
    options: {
      json?: unknown;
      body?: Buffer;
      contentType?: string;
      signal?: AbortSignal;
      timeoutMs: number;
    },
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

  private async readBody(response: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private header(response: IncomingMessage, name: string, fallback: string): string {
    const value = response.headers[name];
    return typeof value === "string" && value.length > 0 ? value : fallback;
  }

  private numberHeader(response: IncomingMessage, name: string): number {
    const value = this.header(response, name, "");
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
