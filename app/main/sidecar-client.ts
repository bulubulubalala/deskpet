/**
 * 文件职责：sidecar 的业务客户端（需求 §6.3）——记忆、供给探测、屏幕观察、用量、数据导出/恢复。
 *
 * 分工：这里只负责「业务参数 → 路径与字段、响应 → 契约对象」的翻译；真正发请求、拼 token 头、
 * 处理超时/abort、还原错误信封的部分在 ./sidecar/transport.ts。所以这个文件里看不到 node:http。
 * 依赖方向：main -> ./sidecar/transport（发送）+ ./sidecar/parsers（读数）+ ./sidecar/types（形状）
 * + ../shared/contracts/ipc（业务契约）；不 import electron（CODE_STYLE §1.1）。
 * 谁调用：app/main/ipc/*、app/main/companion-sync.ts；聊天与语音合成走 ./voice-socket.ts 的 WS。
 */
import {
  type AsrModelState,
  type DataBackupNowResult,
  type DataBackupsResult,
  type DataExportResult,
  type DataRestoreResult,
  type MemoryClearRequest,
  type MemoryClearResponse,
  type MemoryContextRequest,
  type MemoryContextResponse,
  type MemoryContextSection,
  type MemoryEditRequest,
  type MemoryEditResponse,
  type MemoryEmbeddingIndexRequest,
  type MemoryEmbeddingIndexResponse,
  type MemoryEmbeddingStatus,
  type MemoryDiaryItem,
  type MemoryDiaryListRequest,
  type MemoryDiaryListResponse,
  type MemoryDiaryPatchRequest,
  type MemoryDiaryWriteRequest,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphRebuildRequest,
  type MemoryGraphRebuildResponse,
  type MemoryGraphRequest,
  type MemoryGraphResponse,
  type MemoryIntentionItem,
  type MemoryIntentionWriteRequest,
  type MemoryIntentionsRequest,
  type MemoryIntentionsResponse,
  type MemoryItem,
  type MemoryPeriodDetail,
  type MemoryPeriodEditRequest,
  type MemoryPeriodItem,
  type MemoryRelationItem,
  type MemoryRelationUpdateRequest,
  type MemoryTimelineBackfillRequest,
  type MemoryTimelineRebuildRequest,
  type MemoryTimelineRebuildResponse,
  type MemoryTimelineRequest,
  type MemoryTimelineResponse,
  type MemoryListRequest,
  type MemoryMessageItem,
  type MemoryMessagesRequest,
  type MemoryMessagesResponse,
  type MemoryMessageEditRequest,
  type MemorySummariesRequest,
  type MemorySummariesResponse,
  type MemorySummaryEditRequest,
  type MemorySummaryItem,
  type ProviderModelsRequest,
  type ProviderModelsResponse,
  type ProviderProbeResult,
  type ProviderTestReport,
  type ProviderTestRequest,
  type UsageRecordRequest,
  type UsageStats,
} from "../shared/contracts/ipc";
import type {
  PresenceDecision,
  PresenceRequest,
  ScreenCaptureResult,
  ScreenOcrResult,
  SidecarClientOptions,
} from "./sidecar/types";
import { SidecarTransport } from "./sidecar/transport";
import {
  parseMemoryItem,
  memoryListQuery,
  parseMemoryMessage,
  parseMemorySummary,
  parseMemoryPeriod,
  parseMemoryDiary,
  parseMemoryRelation,
  memoryMessagesQuery,
  parseContextSection,
  parseUsageStats,
  parseDataBackups,
  parseDataBackupNow,
  parseDataExport,
  parseDataRestore,
  parseProbeResult,
  parseAsrModelState,
} from "./sidecar/parsers";
import { EXPORT_TIMEOUT_MS } from "./sidecar/types";
import type { MainLogger } from "./logger";

export class SidecarClient {
  private readonly transport: SidecarTransport;

  constructor(logger: MainLogger, options: SidecarClientOptions = {}) {
    this.transport = new SidecarTransport(logger, options);
  }

  /** 握手成功后由引擎调用；sidecar 重启会换端口与 token，所以每次都重新设。 */
  setEndpoint(runtime: { host: string; port: number; token: string }): void {
    this.transport.setEndpoint(runtime);
  }

  clearEndpoint(): void {
    this.transport.clearEndpoint();
  }

  get ready(): boolean {
    return this.transport.ready;
  }

  /**
   * 供给探测：POST /providers/test（T1.14b）。
   *
   * 只回结论：候选顺序与真实请求一致，detail 由 sidecar 生成且绝不含密钥。
   * overrides 里的密钥只经这条本机回环请求转发，不落盘、不日志、不进返回值。
   */
  async testProvider(request: ProviderTestRequest): Promise<ProviderTestReport> {
    const body = await this.transport.requestJson("POST", "/providers/test", request);
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
    return { capability: request.capability, results };
  }

  /** 获取云端模型列表；detail 只在失败时有一句人话（不含密钥）。 */
  async listProviderModels(request: ProviderModelsRequest): Promise<ProviderModelsResponse> {
    const body = await this.transport.requestJson("POST", "/providers/models", request);
    const raw = body["models"];
    const models: string[] = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : [];
    return {
      capability: request.capability,
      models,
      detail: typeof body["detail"] === "string" ? body["detail"] : "",
    };
  }

  /** 语音识别模型现状（D7）：GET /asr/model。云端识别时永远是就绪，不会下载。 */
  async asrModel(): Promise<AsrModelState> {
    return parseAsrModelState(await this.transport.requestJson("GET", "/asr/model", undefined));
  }

  /**
   * 让 sidecar 开始下载语音识别模型（D7）：POST /asr/model/prefetch。
   *
   * 只起任务：下载可能要几分钟，界面靠再查一次 asrModel 看进度，不在这里等。
   */
  async prefetchAsrModel(): Promise<AsrModelState> {
    return parseAsrModelState(await this.transport.requestJson("POST", "/asr/model/prefetch", {}));
  }

  /**
   * 列记忆（设置窗记忆面板，T2.1b）：GET /memory/list。
   *
   * 只读、只回条目本身：记忆的写入永远由对话链路产生，界面不许手写记忆条目。
   */
  async listMemories(request: MemoryListRequest): Promise<MemoryItem[]> {
    const body = await this.transport.requestJson(
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
    const body = await this.transport.requestJson(
      "DELETE",
      "/memory/" + String(memoryId),
      undefined,
    );
    return body["deleted"] === true;
  }

  /**
   * 清空该角色记忆：POST /memory/clear（keep_days 为空则全清）。
   *
   * 返回真删掉的条数，以及服务端在删除前留的快照路径（D9 第 5 条）。
   */
  async clearMemories(request: MemoryClearRequest): Promise<MemoryClearResponse> {
    const body = await this.transport.requestJson("POST", "/memory/clear", {
      char_id: request.char_id,
    });
    return {
      deleted: typeof body["deleted"] === "number" ? body["deleted"] : 0,
      snapshot: typeof body["snapshot"] === "string" ? body["snapshot"] : "",
    };
  }

  /**
   * 改一条 L0 记忆（开发者模式，T2.3-B2）：PATCH /memory/{id}。
   *
   * 只动 memories 表：原文与摘要层都不碰；updated=false 表示该 id 不存在（幂等）。
   */
  async editMemory(request: MemoryEditRequest): Promise<MemoryEditResponse> {
    const importance = request.importance;
    const body = await this.transport.requestJson("PATCH", "/memory/" + String(request.memory_id), {
      text: request.text,
      ...(importance === undefined || importance === null ? {} : { importance }),
      ...(request.kind === undefined ? {} : { kind: request.kind }),
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
    const body = await this.transport.requestJson(
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

  async listSummaries(request: MemorySummariesRequest): Promise<MemorySummariesResponse> {
    const params = new URLSearchParams({ char_id: request.char_id });
    if (request.limit !== undefined) {
      params.set("limit", String(request.limit));
    }
    const body = await this.transport.requestJson(
      "GET",
      "/memory/summaries?" + params.toString(),
      undefined,
    );
    const items: MemorySummaryItem[] = [];
    if (Array.isArray(body["items"])) {
      for (const value of body["items"]) {
        const parsed = parseMemorySummary(value);
        if (parsed !== null) {
          items.push(parsed);
        }
      }
    }
    return { items };
  }

  async editSummary(request: MemorySummaryEditRequest): Promise<MemorySummaryItem | null> {
    const body = await this.transport.requestJson(
      "PATCH",
      "/memory/summaries/" + String(request.summary_id),
      { text: request.text },
    );
    return parseMemorySummary(body);
  }

  async deleteSummary(summaryId: number): Promise<boolean> {
    const body = await this.transport.requestJson(
      "DELETE",
      "/memory/summaries/" + String(summaryId),
      undefined,
    );
    return body["deleted"] === true;
  }

  async editMessage(request: MemoryMessageEditRequest): Promise<MemoryMessageItem | null> {
    const body = await this.transport.requestJson(
      "PATCH",
      "/memory/messages/" + String(request.message_id),
      {
        text: request.text,
      },
    );
    return parseMemoryMessage(body);
  }

  async deleteMessage(messageId: number): Promise<boolean> {
    const body = await this.transport.requestJson(
      "DELETE",
      "/memory/messages/" + String(messageId),
      undefined,
    );
    return body["deleted"] === true;
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
    const body = await this.transport.requestJson(
      "GET",
      "/memory/context?" + parts.join("&"),
      undefined,
    );
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

  /** 语义检索状态（T2.32）：GET /memory/embeddings/status；坏字段回落到安全默认值。 */
  async memoryEmbeddingStatus(charId: string): Promise<MemoryEmbeddingStatus> {
    const body = await this.transport.requestJson(
      "GET",
      "/memory/embeddings/status?char_id=" + encodeURIComponent(charId),
      undefined,
    );
    return {
      enabled: body["enabled"] === true,
      available: body["available"] === true,
      model: typeof body["model"] === "string" ? body["model"] : "",
      provider: typeof body["provider"] === "string" ? body["provider"] : "",
      model_dir: typeof body["model_dir"] === "string" ? body["model_dir"] : "",
      base_url: typeof body["base_url"] === "string" ? body["base_url"] : "",
      indexed: typeof body["indexed"] === "number" ? body["indexed"] : 0,
      pending: typeof body["pending"] === "number" ? body["pending"] : 0,
      error: typeof body["error"] === "string" ? body["error"] : "",
    };
  }

  /** 手动补索引（T2.32）：POST /memory/embeddings/index；limit 不传就用 sidecar 默认值。 */
  async indexMemoryEmbeddings(
    request: MemoryEmbeddingIndexRequest,
  ): Promise<MemoryEmbeddingIndexResponse> {
    const payload: Record<string, unknown> = { char_id: request.char_id };
    if (request.limit !== undefined) {
      payload["limit"] = request.limit;
    }
    const body = await this.transport.requestJson("POST", "/memory/embeddings/index", payload);
    return {
      indexed: typeof body["indexed"] === "number" ? body["indexed"] : 0,
      pending: typeof body["pending"] === "number" ? body["pending"] : 0,
      error: typeof body["error"] === "string" ? body["error"] : "",
    };
  }

  async memoryTimeline(request: MemoryTimelineRequest): Promise<MemoryTimelineResponse> {
    const params = new URLSearchParams({ char_id: request.char_id });
    if (request.levels !== undefined && request.levels !== "") {
      params.set("levels", request.levels);
    }
    if (request.limit !== undefined) {
      params.set("limit", String(request.limit));
    }
    const body = await this.transport.requestJson(
      "GET",
      "/memory/timeline?" + params.toString(),
      undefined,
    );
    const items: MemoryPeriodItem[] = [];
    if (Array.isArray(body["items"])) {
      for (const value of body["items"]) {
        const parsed = parseMemoryPeriod(value);
        if (parsed !== null) {
          items.push(parsed);
        }
      }
    }
    return { items };
  }

  async rebuildMemoryTimeline(
    request: MemoryTimelineRebuildRequest,
  ): Promise<MemoryTimelineRebuildResponse> {
    const body = await this.transport.requestJson("POST", "/memory/timeline/rebuild", {
      char_id: request.char_id,
    });
    return {
      episode: typeof body["episode"] === "number" ? body["episode"] : 0,
      day: typeof body["day"] === "number" ? body["day"] : 0,
      week: typeof body["week"] === "number" ? body["week"] : 0,
      month: typeof body["month"] === "number" ? body["month"] : 0,
    };
  }

  async editMemoryPeriod(request: MemoryPeriodEditRequest): Promise<MemoryPeriodItem> {
    const body = await this.transport.requestJson(
      "PATCH",
      "/memory/timeline/" + String(request.period_id),
      {
        summary: request.summary,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.pinned === undefined ? {} : { pinned: request.pinned }),
      },
    );
    const period = parseMemoryPeriod(body);
    if (period === null) {
      throw new Error("sidecar 返回的时间桶格式不正确");
    }
    return period;
  }

  async backfillMemoryTimeline(
    request: MemoryTimelineBackfillRequest,
  ): Promise<MemoryTimelineRebuildResponse> {
    const body = await this.transport.requestJson("POST", "/memory/timeline/backfill", {
      char_id: request.char_id,
      ...(request.days === undefined ? {} : { days: request.days }),
    });
    return {
      episode: typeof body["episode"] === "number" ? body["episode"] : 0,
      day: typeof body["day"] === "number" ? body["day"] : 0,
      week: typeof body["week"] === "number" ? body["week"] : 0,
      month: typeof body["month"] === "number" ? body["month"] : 0,
    };
  }

  async memoryPeriodDetail(periodId: number): Promise<MemoryPeriodDetail> {
    const body = await this.transport.requestJson(
      "GET",
      "/memory/timeline/" + String(periodId),
      undefined,
    );
    const period = parseMemoryPeriod(body);
    if (period === null) {
      throw new Error("sidecar 返回的时间桶格式不正确");
    }
    const sources: [string, number][] = [];
    if (Array.isArray(body["sources"])) {
      for (const value of body["sources"]) {
        if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number") {
          sources.push([value[0], value[1]]);
        }
      }
    }
    return { ...period, sources };
  }

  async listDiary(request: MemoryDiaryListRequest): Promise<MemoryDiaryListResponse> {
    const params = new URLSearchParams({ char_id: request.char_id });
    if (request.limit !== undefined) {
      params.set("limit", String(request.limit));
    }
    const body = await this.transport.requestJson(
      "GET",
      "/memory/diary?" + params.toString(),
      undefined,
    );
    const items: MemoryDiaryItem[] = [];
    if (Array.isArray(body["items"])) {
      for (const value of body["items"]) {
        const parsed = parseMemoryDiary(value);
        if (parsed !== null) {
          items.push(parsed);
        }
      }
    }
    return { items };
  }

  async addDiary(request: MemoryDiaryWriteRequest): Promise<MemoryDiaryItem> {
    const body = await this.transport.requestJson("POST", "/memory/diary", request);
    const entry = parseMemoryDiary(body);
    if (entry === null) {
      throw new Error("sidecar 返回的日记格式不正确");
    }
    return entry;
  }

  async updateDiary(request: MemoryDiaryPatchRequest): Promise<MemoryDiaryItem> {
    const body = await this.transport.requestJson(
      "PATCH",
      "/memory/diary/" + String(request.entry_id),
      {
        text: request.text,
        ...(request.mood === undefined ? {} : { mood: request.mood }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
      },
    );
    const entry = parseMemoryDiary(body);
    if (entry === null) {
      throw new Error("sidecar 返回的日记格式不正确");
    }
    return entry;
  }

  async deleteDiary(entryId: number): Promise<boolean> {
    const body = await this.transport.requestJson(
      "DELETE",
      "/memory/diary/" + String(entryId),
      undefined,
    );
    return body["deleted"] === true;
  }

  async memoryGraph(request: MemoryGraphRequest): Promise<MemoryGraphResponse> {
    const params = new URLSearchParams({ char_id: request.char_id });
    if (request.limit !== undefined) {
      params.set("limit", String(request.limit));
    }
    const body = await this.transport.requestJson(
      "GET",
      "/memory/graph?" + params.toString(),
      undefined,
    );
    const nodes: MemoryGraphNode[] = [];
    if (Array.isArray(body["nodes"])) {
      for (const value of body["nodes"]) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (typeof record["id"] === "string") {
            nodes.push({
              id: record["id"],
              kind: typeof record["kind"] === "string" ? record["kind"] : "",
              label: typeof record["label"] === "string" ? record["label"] : "",
              summary: typeof record["summary"] === "string" ? record["summary"] : "",
              level: typeof record["level"] === "string" ? record["level"] : "",
            });
          }
        }
      }
    }
    const edges: MemoryGraphEdge[] = [];
    if (Array.isArray(body["edges"])) {
      for (const value of body["edges"]) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (typeof record["source"] === "string" && typeof record["target"] === "string") {
            edges.push({
              source: record["source"],
              target: record["target"],
              relation: typeof record["relation"] === "string" ? record["relation"] : "",
            });
          }
        }
      }
    }
    return { nodes, edges };
  }

  async listIntentions(request: MemoryIntentionsRequest): Promise<MemoryIntentionsResponse> {
    const params = new URLSearchParams({ char_id: request.char_id });
    if (request.limit !== undefined) {
      params.set("limit", String(request.limit));
    }
    const body = await this.transport.requestJson(
      "GET",
      "/memory/intentions?" + params.toString(),
      undefined,
    );
    const items: MemoryIntentionItem[] = [];
    if (Array.isArray(body["items"])) {
      for (const value of body["items"]) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (typeof record["id"] === "number") {
            items.push({
              id: record["id"],
              char_id: typeof record["char_id"] === "string" ? record["char_id"] : "",
              text: typeof record["text"] === "string" ? record["text"] : "",
              trigger_at: typeof record["trigger_at"] === "string" ? record["trigger_at"] : "",
              trigger_context:
                typeof record["trigger_context"] === "string" ? record["trigger_context"] : "",
              status: typeof record["status"] === "string" ? record["status"] : "",
              created_at: typeof record["created_at"] === "string" ? record["created_at"] : "",
            });
          }
        }
      }
    }
    return { items };
  }

  async addIntention(request: MemoryIntentionWriteRequest): Promise<MemoryIntentionItem> {
    const body = await this.transport.requestJson("POST", "/memory/intentions", {
      char_id: request.char_id,
      text: request.text,
      ...(request.trigger_at === undefined ? {} : { trigger_at: request.trigger_at }),
    });
    const parsed = await this.listIntentions({ char_id: request.char_id, limit: 50 });
    return (
      parsed.items.find((item) => item.text === request.text) ?? {
        id: typeof body["id"] === "number" ? body["id"] : 0,
        char_id: request.char_id,
        text: request.text,
        trigger_at: "",
        trigger_context: "",
        status: "open",
        created_at: "",
      }
    );
  }

  async resolveIntention(intentionId: number): Promise<boolean> {
    const body = await this.transport.requestJson(
      "POST",
      "/memory/intentions/" + String(intentionId) + "/resolve",
      undefined,
    );
    return body["deleted"] === true;
  }

  async rebuildMemoryGraph(
    request: MemoryGraphRebuildRequest,
  ): Promise<MemoryGraphRebuildResponse> {
    const body = await this.transport.requestJson("POST", "/memory/graph/rebuild", {
      char_id: request.char_id,
    });
    return {
      entities: typeof body["entities"] === "number" ? body["entities"] : 0,
      links: typeof body["links"] === "number" ? body["links"] : 0,
    };
  }

  async memoryRelation(charId: string): Promise<MemoryRelationItem> {
    const body = await this.transport.requestJson(
      "GET",
      "/memory/relation?char_id=" + encodeURIComponent(charId),
      undefined,
    );
    return parseMemoryRelation(body);
  }

  async saveMemoryRelation(
    charId: string,
    request: MemoryRelationUpdateRequest,
  ): Promise<MemoryRelationItem> {
    const body = await this.transport.requestJson(
      "PUT",
      "/memory/relation?char_id=" + encodeURIComponent(charId),
      request,
    );
    return parseMemoryRelation(body);
  }

  /**
   * 上报一条使用事实（T2.3）：POST /usage/record。
   *
   * 返回 recorded=false 表示 sidecar 明确没收（没有可承接的会话 / 记录开关关着）；
   * 这不是错误，调用方也不该把它升级成故障（§6.7）。
   */
  async presence(request: PresenceRequest): Promise<PresenceDecision> {
    const body = await this.transport.requestJson("POST", "/presence", request);
    const record = body;
    return {
      proactive: record["proactive"] === true,
      kind: typeof record["kind"] === "string" ? record["kind"] : "",
      reason: typeof record["reason"] === "string" ? record["reason"] : "",
    };
  }

  async usageStats(): Promise<UsageStats> {
    const body = await this.transport.requestJson("GET", "/usage/stats", undefined);
    return parseUsageStats(body);
  }

  async setUsageRecording(enabled: boolean): Promise<UsageStats> {
    const body = await this.transport.requestJson("POST", "/usage/recording", { enabled });
    return parseUsageStats(body);
  }

  async clearUsage(): Promise<UsageStats> {
    const body = await this.transport.requestJson("DELETE", "/usage", undefined);
    return parseUsageStats(body);
  }

  async recordUsage(request: UsageRecordRequest): Promise<boolean> {
    // 可选字段不传就不进 JSON（exactOptionalPropertyTypes 下也不该塞 undefined）
    const payload: Record<string, unknown> = { fact: request.fact, char_id: request.char_id };
    if (request.region_id !== undefined) {
      payload["region_id"] = request.region_id;
    }
    if (request.gesture !== undefined) {
      payload["gesture"] = request.gesture;
    }
    if (request.count !== undefined) {
      payload["count"] = request.count;
    }
    const body = await this.transport.requestJson("POST", "/usage/record", payload);
    return body["recorded"] === true;
  }

  /**
   * 导出数据包。必须走 sidecar：记忆库是 SQLCipher + WAL，主进程没密钥，
   * 直接拷文件会拿到半个事务。VACUUM INTO 再打 zip 可能要几十秒，所以单独放宽超时。
   */
  async exportData(): Promise<DataExportResult> {
    const body = await this.transport.requestJson(
      "POST",
      "/data/export",
      undefined,
      EXPORT_TIMEOUT_MS,
    );
    return parseDataExport(body);
  }

  async restoreData(archivePath: string): Promise<DataRestoreResult> {
    const body = await this.transport.requestJson(
      "POST",
      "/data/restore",
      { path: archivePath },
      EXPORT_TIMEOUT_MS,
    );
    return parseDataRestore(body);
  }

  /** 备份目录现状（D9）：只读目录，不碰数据库。 */
  async listBackups(): Promise<DataBackupsResult> {
    const body = await this.transport.requestJson("GET", "/data/backups", undefined);
    return parseDataBackups(body);
  }

  /** 用户点「立即备份」：sidecar 走与操作前留底同一条 VACUUM INTO 路径。 */
  async backupNow(): Promise<DataBackupNowResult> {
    const body = await this.transport.requestJson(
      "POST",
      "/data/backup",
      undefined,
      EXPORT_TIMEOUT_MS,
    );
    return parseDataBackupNow(body);
  }

  async ocrScreen(image: Buffer, appTitle: string): Promise<ScreenOcrResult> {
    const body = await this.transport.requestJson("POST", "/screen/ocr", {
      image_base64: image.toString("base64"),
      app_title: appTitle,
    });
    return {
      text: typeof body["text"] === "string" ? body["text"] : "",
      confidence: typeof body["confidence"] === "number" ? body["confidence"] : 0,
      engine: typeof body["engine"] === "string" ? body["engine"] : "",
      elapsedMs: typeof body["elapsed_ms"] === "number" ? body["elapsed_ms"] : 0,
    };
  }

  async captureScreen(
    image: Buffer,
    appTitle: string,
    capturedAt: string,
    model: string,
  ): Promise<ScreenCaptureResult> {
    const body = await this.transport.requestJson("POST", "/screen/capture", {
      image_base64: image.toString("base64"),
      app_title: appTitle,
      captured_at: capturedAt,
      model,
    });
    return {
      summary: typeof body["summary"] === "string" ? body["summary"] : "",
      interesting: body["interesting"] === true,
      confidence: typeof body["confidence"] === "number" ? body["confidence"] : 0,
      visionModel: typeof body["vision_model"] === "string" ? body["vision_model"] : "",
      capturedAt: typeof body["captured_at"] === "string" ? body["captured_at"] : capturedAt,
      appTitle: typeof body["app_title"] === "string" ? body["app_title"] : appTitle,
    };
  }

  async writeScreenMemory(charId: string, text: string): Promise<boolean> {
    const body = await this.transport.requestJson("POST", "/memory/write", {
      char_id: charId,
      kind: "event",
      text,
      importance: 0.4,
      source: "screen",
    });
    return typeof body["id"] === "number";
  }
}

export * from "./sidecar/types";
