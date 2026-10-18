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

import {
  CHAT_EVENT_KINDS,
  type ChatEvent,
  type ChatSendRequest,
  type MemoryClearRequest,
  type MemoryContextItem,
  type MemoryContextRequest,
  type MemoryContextResponse,
  type MemoryContextSection,
  type MemoryEditRequest,
  type MemoryEditResponse,
  type MemoryItem,
  type MemoryListRequest,
  type MemoryMessageItem,
  type MemoryMessagesRequest,
  type MemoryMessagesResponse,
  type ProviderCapability,
  type ProviderProbeResult,
  type ProviderTestReport,
  type UsageRecordRequest,
} from "./ipc";
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

/** 把 sidecar 的一条记忆读成契约形状；坏条目直接丢弃（界面少一行好过整块崩溃）。 */
function parseMemoryItem(value: unknown): MemoryItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const text = record["text"];
  if (typeof id !== "number" || typeof text !== "string") {
    return null;
  }
  return {
    id,
    kind: typeof record["kind"] === "string" ? record["kind"] : "",
    tier: typeof record["tier"] === "string" ? record["tier"] : "",
    text,
    importance: typeof record["importance"] === "number" ? record["importance"] : 0,
    created_at: typeof record["created_at"] === "string" ? record["created_at"] : "",
    last_used_at: typeof record["last_used_at"] === "string" ? record["last_used_at"] : "",
    used_count: typeof record["used_count"] === "number" ? record["used_count"] : 0,
  };
}

/** 拼 GET /memory/list 的查询串；空 kind / tier 不上送（sidecar 用空串当不过滤）。 */
function memoryListQuery(request: MemoryListRequest): string {
  const parts = ["char_id=" + encodeURIComponent(request.char_id)];
  if (request.kind !== undefined && request.kind !== "") {
    parts.push("kind=" + request.kind);
  }
  if (request.tier !== undefined && request.tier !== "") {
    parts.push("tier=" + encodeURIComponent(request.tier));
  }
  if (request.min_importance !== undefined) {
    parts.push("min_importance=" + String(request.min_importance));
  }
  if (request.limit !== undefined) {
    parts.push("limit=" + String(request.limit));
  }
  return "?" + parts.join("&");
}

/** 把 sidecar 的一行历史原文读成契约形状；坏行直接丢弃（界面少一行好过整块崩）。 */
function parseMemoryMessage(value: unknown): MemoryMessageItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const messageId = record["message_id"];
  const role = record["role"];
  const text = record["text"];
  if (typeof messageId !== "number" || typeof role !== "string" || typeof text !== "string") {
    return null;
  }
  return {
    message_id: messageId,
    session_id: typeof record["session_id"] === "string" ? record["session_id"] : "",
    role,
    text,
    created_at: typeof record["created_at"] === "string" ? record["created_at"] : "",
    token_len: typeof record["token_len"] === "number" ? record["token_len"] : 0,
    covered_by: typeof record["covered_by"] === "number" ? record["covered_by"] : 0,
  };
}

/** 拼 GET /memory/messages 的查询串；before_id 只在有值时上送（不传 = 最新一页）。 */
function memoryMessagesQuery(request: MemoryMessagesRequest): string {
  const parts = ["char_id=" + encodeURIComponent(request.char_id)];
  if (request.limit !== undefined) {
    parts.push("limit=" + String(request.limit));
  }
  if (request.before_id !== undefined && request.before_id !== null) {
    parts.push("before_id=" + String(request.before_id));
  }
  return "?" + parts.join("&");
}

/** 把注入预览里的一条内容读成契约形状；坏条目直接丢弃。 */
function parseContextItem(value: unknown): MemoryContextItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const text = record["text"];
  if (typeof text !== "string") {
    return null;
  }
  return {
    text,
    tokens: typeof record["tokens"] === "number" ? record["tokens"] : 0,
    ref_id: typeof record["ref_id"] === "number" ? record["ref_id"] : 0,
    kind: typeof record["kind"] === "string" ? record["kind"] : "",
    role: typeof record["role"] === "string" ? record["role"] : "",
    importance: typeof record["importance"] === "number" ? record["importance"] : 0,
  };
}

/** 把注入预览的一段读成契约形状；坏条目直接丢弃。 */
function parseContextSection(value: unknown): MemoryContextSection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record["name"];
  if (typeof name !== "string") {
    return null;
  }
  const items: MemoryContextItem[] = [];
  const rawItems = record["items"];
  if (Array.isArray(rawItems)) {
    for (const item of rawItems) {
      const parsed = parseContextItem(item);
      if (parsed !== null) {
        items.push(parsed);
      }
    }
  }
  return {
    name,
    title: typeof record["title"] === "string" ? record["title"] : "",
    budget_tokens: typeof record["budget_tokens"] === "number" ? record["budget_tokens"] : 0,
    used_tokens: typeof record["used_tokens"] === "number" ? record["used_tokens"] : 0,
    dropped: record["dropped"] === true,
    items,
  };
}
/** 把 sidecar 的一条探测结论读成契约形状；坏条目直接丢弃（界面少一行好过整块崩）。 */
function parseProbeResult(value: unknown): ProviderProbeResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const provider = record["provider"];
  const detail = record["detail"];
  if (typeof provider !== "string" || typeof detail !== "string") {
    return null;
  }
  return {
    provider,
    ...(typeof record["base_url"] === "string" ? { base_url: record["base_url"] } : {}),
    ...(typeof record["model"] === "string" ? { model: record["model"] } : {}),
    ok: record["ok"] === true,
    detail,
    elapsed_ms: typeof record["elapsed_ms"] === "number" ? record["elapsed_ms"] : 0,
  };
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

  /**
   * 供给探测：POST /providers/test（T1.14b）。
   *
   * 只回结论：候选顺序与真实请求一致，detail 由 sidecar 生成且绝不含密钥——
   * 本方法也不从配置里读任何 key，密钥始终留在 sidecar 进程内。
   */
  async testProvider(capability: ProviderCapability): Promise<ProviderTestReport> {
    const body = await this.requestJson("POST", "/providers/test", { capability });
    const raw = body["results"];
    const results: ProviderProbeResult[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const parsed = parseProbeResult(item);
        if (parsed !== null) {
          results.push(parsed);
        }
      }
    }
    return { capability, results };
  }

  /**
   * 列记忆（设置窗记忆面板，T2.1b）：GET /memory/list。
   *
   * 只读、只回条目本身：记忆的写入永远由对话链路产生，界面不许手写记忆条目。
   */
  async listMemories(request: MemoryListRequest): Promise<MemoryItem[]> {
    const body = await this.requestJson(
      "GET",
      "/memory/list" + memoryListQuery(request),
      undefined,
    );
    const raw = body["items"];
    const items: MemoryItem[] = [];
    if (Array.isArray(raw)) {
      for (const value of raw) {
        const parsed = parseMemoryItem(value);
        if (parsed !== null) {
          items.push(parsed);
        }
      }
    }
    return items;
  }

  /** 删一条记忆：DELETE /memory/{id}；deleted=false 表示本来就没有（幂等）。 */
  async deleteMemory(memoryId: number): Promise<boolean> {
    const body = await this.requestJson("DELETE", "/memory/" + String(memoryId), undefined);
    return body["deleted"] === true;
  }

  /** 清空该角色记忆：POST /memory/clear；返回真删掉的条数（keep_days 为空则全清）。 */
  async clearMemories(request: MemoryClearRequest): Promise<number> {
    const keepDays = request.keep_days;
    const body = await this.requestJson("POST", "/memory/clear", {
      char_id: request.char_id,
      ...(keepDays === undefined || keepDays === null ? {} : { keep_days: keepDays }),
    });
    return typeof body["deleted"] === "number" ? body["deleted"] : 0;
  }

  /**
   * 改一条 L0 记忆（开发者模式，T2.3-B2）：PATCH /memory/{id}。
   *
   * 只动 memories 表：原文与摘要层都不碰；updated=false 表示该 id 不存在（幂等）。
   */
  async editMemory(request: MemoryEditRequest): Promise<MemoryEditResponse> {
    const importance = request.importance;
    const body = await this.requestJson("PATCH", "/memory/" + String(request.memory_id), {
      text: request.text,
      ...(importance === undefined || importance === null ? {} : { importance }),
    });
    return {
      updated: body["updated"] === true,
      merged: body["merged"] === true,
      item: parseMemoryItem(body["item"]),
    };
  }

  /**
   * 开发者模式「原文」页（T2.3-B1）：GET /memory/messages。
   *
   * 只读：原文是压缩链路的输入，改了会让 covered_by 对不上，所以界面只能看不能改。
   */
  async listMessages(request: MemoryMessagesRequest): Promise<MemoryMessagesResponse> {
    const body = await this.requestJson(
      "GET",
      "/memory/messages" + memoryMessagesQuery(request),
      undefined,
    );
    const raw = body["items"];
    const items: MemoryMessageItem[] = [];
    if (Array.isArray(raw)) {
      for (const value of raw) {
        const parsed = parseMemoryMessage(value);
        if (parsed !== null) {
          items.push(parsed);
        }
      }
    }
    return { items, has_more: body["has_more"] === true };
  }

  /**
   * 开发者模式「注入上下文」页（T2.3-B1）：GET /memory/context。
   *
   * sidecar 侧是干跑：真的装配一遍但**不 mark_used**，所以反复预览不会污染使用次数。
   */
  async memoryContext(request: MemoryContextRequest): Promise<MemoryContextResponse> {
    const parts = ["char_id=" + encodeURIComponent(request.char_id)];
    if (request.query !== undefined && request.query !== "") {
      parts.push("query=" + encodeURIComponent(request.query));
    }
    const body = await this.requestJson("GET", "/memory/context?" + parts.join("&"), undefined);
    const sections: MemoryContextSection[] = [];
    const rawSections = body["sections"];
    if (Array.isArray(rawSections)) {
      for (const value of rawSections) {
        const parsed = parseContextSection(value);
        if (parsed !== null) {
          sections.push(parsed);
        }
      }
    }
    const injectedIds: number[] = [];
    const rawIds = body["injected_ids"];
    if (Array.isArray(rawIds)) {
      for (const value of rawIds) {
        if (typeof value === "number") {
          injectedIds.push(value);
        }
      }
    }
    const dropped: string[] = [];
    const rawDropped = body["dropped"];
    if (Array.isArray(rawDropped)) {
      for (const value of rawDropped) {
        if (typeof value === "string") {
          dropped.push(value);
        }
      }
    }
    return {
      char_id: typeof body["char_id"] === "string" ? body["char_id"] : request.char_id,
      query: typeof body["query"] === "string" ? body["query"] : "",
      empty: body["empty"] === true,
      total_tokens: typeof body["total_tokens"] === "number" ? body["total_tokens"] : 0,
      budget_tokens: typeof body["budget_tokens"] === "number" ? body["budget_tokens"] : 0,
      dropped,
      injected_ids: injectedIds,
      sections,
      text: typeof body["text"] === "string" ? body["text"] : "",
    };
  }
  /**
   * 上报一条使用事实（T2.3）：POST /usage/record。
   *
   * 返回 recorded=false 表示 sidecar 明确没收（没有可承接的会话 / 记录开关关着）；
   * 这不是错误，调用方也不该把它升级成故障（§6.7）。
   */
  async recordUsage(request: UsageRecordRequest): Promise<boolean> {
    // 可选字段不传就不进 JSON（exactOptionalPropertyTypes 下也不该塞 undefined）
    const payload: Record<string, unknown> = { fact: request.fact, char_id: request.char_id };
    if (request.region_id !== undefined) {
      payload["region_id"] = request.region_id;
    }
    if (request.streak !== undefined) {
      payload["streak"] = request.streak;
    }
    const body = await this.requestJson("POST", "/usage/record", payload);
    return body["recorded"] === true;
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
