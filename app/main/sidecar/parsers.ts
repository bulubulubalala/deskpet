/**
 * 文件职责：把 sidecar 的 JSON / SSE 返回值读成共享契约形状（原 sidecar-client.ts 的中段）。
 *
 * 为什么单独一个模块：这些函数是纯函数，坏数据只影响一行（读不出来就丢）而不该让界面崩；
 * 单独成文件才能对「脏数据」单独写测试，也不会把 40 个方法淹在 350 行 typeof 判断里。
 * 依赖方向：只看 shared/contracts 的类型与本目录 types.ts，不碰网络、不 import electron。
 */
import {
  CHAT_EVENT_KINDS,
  DATA_BACKUP_KINDS,
  type ChatEvent,
  type AsrModelState,
  type DataBackupEntry,
  type DataBackupKind,
  type DataBackupNowResult,
  type DataBackupsResult,
  type DataExportResult,
  type DataRestoreResult,
  type MemoryContextItem,
  type MemoryContextSection,
  type MemoryDiaryItem,
  type MemoryItem,
  type MemoryPeriodItem,
  type MemoryRelationItem,
  type MemoryListRequest,
  type MemoryMessageItem,
  type MemoryMessagesRequest,
  type MemorySummaryItem,
  type ProviderProbeResult,
  type UsageStats,
} from "../../shared/contracts/ipc";
import {
  SidecarCancelledError,
  SidecarHttpError,
  SidecarUnavailableError,
} from "./types";

export function parseSseLine(line: string): ChatEvent | null {
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
export function parseErrorEnvelope(body: string): { code: string; message: string; userHint?: string } {
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
export function toClientError(error: unknown, path: string): Error {
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
export function parseMemoryItem(value: unknown): MemoryItem | null {
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
    char_id: typeof record["char_id"] === "string" ? record["char_id"] : "",
    kind: typeof record["kind"] === "string" ? record["kind"] : "",
    tier: typeof record["tier"] === "string" ? record["tier"] : "",
    text,
    importance: typeof record["importance"] === "number" ? record["importance"] : 0,
    created_at: typeof record["created_at"] === "string" ? record["created_at"] : "",
    last_used_at: typeof record["last_used_at"] === "string" ? record["last_used_at"] : "",
    used_count: typeof record["used_count"] === "number" ? record["used_count"] : 0,
    source_msg_ids: typeof record["source_msg_ids"] === "string" ? record["source_msg_ids"] : "",
  };
}

/** 拼 GET /memory/list 的查询串；空 kind / tier 不上送（sidecar 用空串当不过滤）。 */
export function memoryListQuery(request: MemoryListRequest): string {
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
export function parseMemoryMessage(value: unknown): MemoryMessageItem | null {
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
export function parseMemorySummary(value: unknown): MemorySummaryItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "number") {
    return null;
  }
  return {
    id,
    char_id: typeof record["char_id"] === "string" ? record["char_id"] : "",
    tier: typeof record["tier"] === "number" ? record["tier"] : 0,
    text: typeof record["text"] === "string" ? record["text"] : "",
    covers_from: typeof record["covers_from"] === "string" ? record["covers_from"] : "",
    covers_to: typeof record["covers_to"] === "string" ? record["covers_to"] : "",
    source_ids: typeof record["source_ids"] === "string" ? record["source_ids"] : "",
    created_at: typeof record["created_at"] === "string" ? record["created_at"] : "",
    archived_at: typeof record["archived_at"] === "string" ? record["archived_at"] : "",
  };
}

export function parseMemoryPeriod(value: unknown): MemoryPeriodItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "number") {
    return null;
  }
  return {
    id,
    char_id: typeof record["char_id"] === "string" ? record["char_id"] : "",
    level: typeof record["level"] === "string" ? record["level"] : "",
    period_start: typeof record["period_start"] === "string" ? record["period_start"] : "",
    period_end: typeof record["period_end"] === "string" ? record["period_end"] : "",
    label: typeof record["label"] === "string" ? record["label"] : "",
    day_key: typeof record["day_key"] === "string" ? record["day_key"] : "",
    summary: typeof record["summary"] === "string" ? record["summary"] : "",
    source_count: typeof record["source_count"] === "number" ? record["source_count"] : 0,
    edited: record["edited"] === true,
    pinned: record["pinned"] === true,
  };
}

export function parseMemoryDiary(value: unknown): MemoryDiaryItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "number") {
    return null;
  }
  return {
    id,
    char_id: typeof record["char_id"] === "string" ? record["char_id"] : "",
    text: typeof record["text"] === "string" ? record["text"] : "",
    occurred_at: typeof record["occurred_at"] === "string" ? record["occurred_at"] : "",
    mood: typeof record["mood"] === "string" ? record["mood"] : "",
    tags: typeof record["tags"] === "string" ? record["tags"] : "",
    created_at: typeof record["created_at"] === "string" ? record["created_at"] : "",
    updated_at: typeof record["updated_at"] === "string" ? record["updated_at"] : "",
  };
}

export function parseMemoryRelation(value: unknown): MemoryRelationItem {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const number = (key: string): number => (typeof record[key] === "number" ? record[key] : 0);
  return {
    char_id: typeof record["char_id"] === "string" ? record["char_id"] : "",
    familiarity: number("familiarity"),
    trust: number("trust"),
    warmth: number("warmth"),
    unresolved: typeof record["unresolved"] === "string" ? record["unresolved"] : "",
    recent_conflict: typeof record["recent_conflict"] === "string" ? record["recent_conflict"] : "",
    updated_at: typeof record["updated_at"] === "string" ? record["updated_at"] : "",
  };
}

export function memoryMessagesQuery(request: MemoryMessagesRequest): string {
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
export function parseContextItem(value: unknown): MemoryContextItem | null {
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
export function parseContextSection(value: unknown): MemoryContextSection | null {
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
export function parseUsageStats(body: Record<string, unknown>): UsageStats {
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const characters: UsageStats["characters"] = [];
  const raw = body["characters"];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const charId = typeof record["char_id"] === "string" ? record["char_id"] : "";
      if (charId === "") {
        continue;
      }
      characters.push({
        char_id: charId,
        total_duration_sec: num(record["total_duration_sec"]),
        session_count: num(record["session_count"]),
      });
    }
  }
  return {
    recording_enabled: body["recording_enabled"] !== false,
    total_sessions: num(body["total_sessions"]),
    total_messages: num(body["total_messages"]),
    total_duration_sec: num(body["total_duration_sec"]),
    today_sessions: num(body["today_sessions"]),
    today_messages: num(body["today_messages"]),
    today_duration_sec: num(body["today_duration_sec"]),
    llm_calls: num(body["llm_calls"]),
    prompt_tokens: num(body["prompt_tokens"]),
    cached_tokens: num(body["cached_tokens"]),
    completion_tokens: num(body["completion_tokens"]),
    total_tokens: num(body["total_tokens"]),
    max_prompt_tokens: num(body["max_prompt_tokens"]),
    memory_tokens: num(body["memory_tokens"]),
    characters,
  };
}

/** 导出包摘要：缺字段就当作空，别让界面因为一个字段没回就整块失败。 */
export function parseDataExport(body: Record<string, unknown>): DataExportResult {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    path: typeof body["path"] === "string" ? body["path"] : "",
    bytes: typeof body["bytes"] === "number" ? body["bytes"] : 0,
    created_at: typeof body["created_at"] === "string" ? body["created_at"] : "",
    entries: strings(body["entries"]),
    skipped: strings(body["skipped"]),
  };
}

export function parseDataRestore(body: Record<string, unknown>): DataRestoreResult {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    archive: typeof body["archive"] === "string" ? body["archive"] : "",
    db_bytes: typeof body["db_bytes"] === "number" ? body["db_bytes"] : 0,
    pending_path: typeof body["pending_path"] === "string" ? body["pending_path"] : "",
    entries: strings(body["entries"]),
    // 缺字段时按「需要重启」处理：宁可多提示一次，也不要让用户以为已经生效
    restart_required: body["restart_required"] !== false,
  };
}

/** 备份列表（D9）：认不出的 kind 一律 other —— 界面只用来分组，绝不据此删文件。 */
export function parseDataBackups(body: Record<string, unknown>): DataBackupsResult {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const raw = Array.isArray(body["entries"]) ? body["entries"] : [];
  const entries: DataBackupEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const file = text(entry["file"]);
    if (file.length === 0) {
      continue;
    }
    const kind = entry["kind"];
    entries.push({
      file,
      kind: DATA_BACKUP_KINDS.includes(kind as DataBackupKind) ? (kind as DataBackupKind) : "other",
      bytes: count(entry["bytes"]),
      modified_at: count(entry["modified_at"]),
    });
  }
  return {
    dir: text(body["dir"]),
    total_bytes: count(body["total_bytes"]),
    entries,
  };
}

/** 「立即备份」结果：path 为空就是没做成，界面据此说一句实话。 */
export function parseDataBackupNow(body: Record<string, unknown>): DataBackupNowResult {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    path: text(body["path"]),
    file: text(body["file"]),
    bytes: typeof body["bytes"] === "number" && Number.isFinite(body["bytes"]) ? body["bytes"] : 0,
  };
}

/** 语音识别模型现状（D7）：读不出的状态按「还没下载」算，界面会给下载按钮而不是报错。 */
export function parseAsrModelState(body: Record<string, unknown>): AsrModelState {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const status = body["status"];
  const progress = count(body["progress"]);
  return {
    status:
      status === "ready" || status === "downloading" || status === "error" || status === "missing"
        ? status
        : "missing",
    provider: text(body["provider"]),
    model: text(body["model"]),
    downloaded_bytes: count(body["downloaded_bytes"]),
    estimated_bytes: count(body["estimated_bytes"]),
    progress: Math.min(1, progress),
    message: text(body["message"]),
    user_hint: text(body["user_hint"]),
  };
}

export function parseProbeResult(value: unknown): ProviderProbeResult | null {
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

