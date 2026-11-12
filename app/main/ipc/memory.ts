/**
 * 文件职责：记忆相关的全部通道——列表与删除、行为开关、语义索引、时间线 / 日记 / 关系、开发者两页。
 *
 * 为什么单独一个文件：记忆的读写语义全在 sidecar（§6.4：界面只能看和删，写入永远由对话链路产生），
 * 主进程这一段只有「转发」和「把开关写回 data/settings.json 再重启引擎」两种动作；
 * 单独成文件后，记忆页能碰到的通道一眼可数，也不会和聊天/语音混在同一个闭包里。
 * 依赖方向：ipc/* -> 本文件 -> sidecar-client / settings-store / memory-settings。
 */
import { basename } from "node:path";

import {
  IPC_CHANNELS,
  type MemoryBehaviorRequest,
  type MemoryBehaviorResponse,
  type MemoryClearRequest,
  type MemoryClearResponse,
  type MemoryContextRequest,
  type MemoryContextResponse,
  type MemoryDeleteRequest,
  type MemoryDeleteResponse,
  type MemoryDiaryItem,
  type MemoryDiaryListRequest,
  type MemoryDiaryListResponse,
  type MemoryDiaryPatchRequest,
  type MemoryDiaryWriteRequest,
  type MemoryEditRequest,
  type MemoryEditResponse,
  type MemoryEmbeddingConfig,
  type MemoryEmbeddingConfigRequest,
  type MemoryEmbeddingIndexRequest,
  type MemoryEmbeddingIndexResponse,
  type MemoryEmbeddingStatus,
  type MemoryEmbeddingStatusRequest,
  type MemoryGraphRebuildRequest,
  type MemoryGraphRebuildResponse,
  type MemoryGraphRequest,
  type MemoryGraphResponse,
  type MemoryIntentionItem,
  type MemoryIntentionWriteRequest,
  type MemoryIntentionsRequest,
  type MemoryIntentionsResponse,
  type MemoryListRequest,
  type MemoryListResponse,
  type MemoryMessageEditRequest,
  type MemoryMessagesRequest,
  type MemoryMessagesResponse,
  type MemoryPeriodDetail,
  type MemoryPeriodEditRequest,
  type MemoryPeriodItem,
  type MemoryRelationItem,
  type MemoryRelationUpdateRequest,
  type MemorySummariesRequest,
  type MemorySummariesResponse,
  type MemorySummaryEditRequest,
  type MemorySummaryItem,
  type MemoryTimelineBackfillRequest,
  type MemoryTimelineRebuildRequest,
  type MemoryTimelineRebuildResponse,
  type MemoryTimelineRequest,
  type MemoryTimelineResponse,
} from "../../shared/contracts/ipc";
import type { IpcRegistry } from "../ipc-registry";
import {
  BUNDLED_EMBEDDING_MODEL_ID,
  behaviorEnvUpdate,
  embeddingEnvUpdate,
  parseBehaviorEnabled,
  parseEmbeddingEnabled,
} from "../memory-settings";
import type { IpcHandlerDeps } from "./deps";

export function registerMemoryHandlers(registry: IpcRegistry, deps: IpcHandlerDeps): void {
  // 记忆管理（T2.1b）：界面只能看和删，写入永远由对话链路产生（§6.4）。
  // 记忆是增强项：sidecar 没起来时这里会抛 SidecarUnavailableError，设置窗只显示错误，不影响聊天。
  registry.handle(
    IPC_CHANNELS.memoryList,
    async (_event, request: MemoryListRequest): Promise<MemoryListResponse> => ({
      items: await deps.client.listMemories(request),
    }),
  );

  registry.handle(
    IPC_CHANNELS.memoryDelete,
    async (_event, request: MemoryDeleteRequest): Promise<MemoryDeleteResponse> => ({
      deleted: await deps.client.deleteMemory(request.memory_id),
    }),
  );

  // 编辑 L0（T2.3-B2，只在开发者模式露出）：只动 memories 表，行为观察由 sidecar 挡。
  registry.handle(
    IPC_CHANNELS.memoryEdit,
    async (_event, request: MemoryEditRequest): Promise<MemoryEditResponse> => {
      const result = await deps.client.editMemory(request);
      // 只记「改了哪条、有没有并条」，不记正文：正文可能含用户隐私（§7.1）
      deps.logger.info("ipc.memory_edit", "用户在开发者模式里改了一条记忆", {
        memory_id: request.memory_id,
        updated: result.updated,
        merged: result.merged,
      });
      return result;
    },
  );

  registry.handle(
    IPC_CHANNELS.memoryClear,
    async (_event, request: MemoryClearRequest): Promise<MemoryClearResponse> => {
      const result = await deps.client.clearMemories(request);
      // 只记「删了几条」和留底文件名，不记记忆正文：正文可能含用户隐私（§7.1）
      deps.logger.info("ipc.memory_clear", "用户清空了角色记忆", {
        deleted: result.deleted,
        snapshot: result.snapshot === "" ? "none" : basename(result.snapshot),
      });
      return result;
    },
  );

  // 行为记忆开关（T2.1c）：enabled = null 只读；true / false 写设置仓库，下一次 sidecar 启动生效。
  // 这里和「模型供给」一样把 data/settings.json 当成唯一事实来源，界面不缓存，每次问一遍。
  registry.handle(
    IPC_CHANNELS.memoryBehavior,
    async (_event, request: MemoryBehaviorRequest): Promise<MemoryBehaviorResponse> => {
      if (request.enabled === null) {
        return { enabled: parseBehaviorEnabled(deps.settings.toEnv()) };
      }
      const env = await deps.settings.update(behaviorEnvUpdate(request.enabled));
      // 只记开关状态，不记键值：这条链路上没有隐私，但保持与其他设置通道一致的日志口径
      deps.logger.info("ipc.memory_behavior", "行为记忆总开关已写回 data/settings.json", {
        enabled: request.enabled,
      });
      // 与「模型供给」同口径：sidecar 只在启动时读一次环境，写完就地重启，
      // 否则界面说「已打开」而实际下一条记忆仍按旧开关走。
      void deps.engine.restartSidecar("记忆设置已更新");
      return { enabled: parseBehaviorEnabled(env) };
    },
  );

  // 语义检索（T2.32）：状态与手动补索引都转发 sidecar；失败只影响记忆页这一块。
  registry.handle(
    IPC_CHANNELS.memoryEmbeddingConfig,
    async (_event, request: MemoryEmbeddingConfigRequest): Promise<MemoryEmbeddingConfig> => {
      const env = deps.settings.toEnv();
      if (request.enabled === null) {
        return {
          enabled: parseEmbeddingEnabled(env),
          // 没配置时给内置模型：界面按这个 id 找 catalog 里的条目，不能落回 bge-m3
          model: (env["DESKPET_EMBED_MODEL"] ?? "").trim() || BUNDLED_EMBEDDING_MODEL_ID,
          base_url: (env["DESKPET_EMBED_BASE_URL"] ?? "").trim(),
        };
      }
      const next = await deps.settings.update(embeddingEnvUpdate(env, request.enabled));
      deps.logger.info("ipc.memory_embedding_config", "语义检索开关已写回 data/settings.json", {
        enabled: request.enabled,
      });
      // 同上：向量开关也是启动期配置，写完重启后台引擎才真的生效
      void deps.engine.restartSidecar("记忆设置已更新");
      return {
        enabled: parseEmbeddingEnabled(next),
        model: (next["DESKPET_EMBED_MODEL"] ?? "").trim() || BUNDLED_EMBEDDING_MODEL_ID,
        base_url: (next["DESKPET_EMBED_BASE_URL"] ?? "").trim(),
      };
    },
  );

  registry.handle(
    IPC_CHANNELS.memoryEmbeddingStatus,
    async (_event, request: MemoryEmbeddingStatusRequest): Promise<MemoryEmbeddingStatus> =>
      await deps.client.memoryEmbeddingStatus(request.char_id),
  );

  registry.handle(
    IPC_CHANNELS.memoryEmbeddingIndex,
    async (_event, request: MemoryEmbeddingIndexRequest): Promise<MemoryEmbeddingIndexResponse> => {
      const result = await deps.client.indexMemoryEmbeddings(request);
      deps.logger.info("ipc.memory_embedding_index", "用户手动补语义索引", {
        char_id: request.char_id,
        indexed: result.indexed,
        pending: result.pending,
      });
      return result;
    },
  );

  // 时间线 / 日记 / 关系记忆（T2.33）：全部转发 sidecar，失败只影响记忆页。
  registry.handle(
    IPC_CHANNELS.memoryTimeline,
    async (_event, request: MemoryTimelineRequest): Promise<MemoryTimelineResponse> =>
      await deps.client.memoryTimeline(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryTimelineRebuild,
    async (_event, request: MemoryTimelineRebuildRequest): Promise<MemoryTimelineRebuildResponse> =>
      await deps.client.rebuildMemoryTimeline(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryTimelineBackfill,
    async (
      _event,
      request: MemoryTimelineBackfillRequest,
    ): Promise<MemoryTimelineRebuildResponse> => await deps.client.backfillMemoryTimeline(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryPeriodEdit,
    async (_event, request: MemoryPeriodEditRequest): Promise<MemoryPeriodItem> =>
      await deps.client.editMemoryPeriod(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryPeriodDetail,
    async (_event, periodId: number): Promise<MemoryPeriodDetail> =>
      await deps.client.memoryPeriodDetail(periodId),
  );
  registry.handle(
    IPC_CHANNELS.memoryDiaryList,
    async (_event, request: MemoryDiaryListRequest): Promise<MemoryDiaryListResponse> =>
      await deps.client.listDiary(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryDiaryAdd,
    async (_event, request: MemoryDiaryWriteRequest): Promise<MemoryDiaryItem> =>
      await deps.client.addDiary(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryDiaryUpdate,
    async (_event, request: MemoryDiaryPatchRequest): Promise<MemoryDiaryItem> =>
      await deps.client.updateDiary(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryDiaryDelete,
    async (_event, entryId: number): Promise<boolean> => await deps.client.deleteDiary(entryId),
  );
  registry.handle(
    IPC_CHANNELS.memoryIntentions,
    async (_event, request: MemoryIntentionsRequest): Promise<MemoryIntentionsResponse> =>
      await deps.client.listIntentions(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryIntentionAdd,
    async (_event, request: MemoryIntentionWriteRequest): Promise<MemoryIntentionItem> =>
      await deps.client.addIntention(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryIntentionResolve,
    async (_event, intentionId: number): Promise<boolean> =>
      await deps.client.resolveIntention(intentionId),
  );
  registry.handle(
    IPC_CHANNELS.memoryGraph,
    async (_event, request: MemoryGraphRequest): Promise<MemoryGraphResponse> =>
      await deps.client.memoryGraph(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryGraphRebuild,
    async (_event, request: MemoryGraphRebuildRequest): Promise<MemoryGraphRebuildResponse> =>
      await deps.client.rebuildMemoryGraph(request),
  );
  registry.handle(
    IPC_CHANNELS.memoryRelationGet,
    async (_event, charId: string): Promise<MemoryRelationItem> =>
      await deps.client.memoryRelation(charId),
  );
  registry.handle(
    IPC_CHANNELS.memoryRelationSave,
    async (_event, payload: { char_id: string; request: MemoryRelationUpdateRequest }) =>
      await deps.client.saveMemoryRelation(payload.char_id, payload.request),
  );

  // 开发者模式的两页（T2.3-B1）：原文只读转发；注入预览由 sidecar 干跑装配、不 mark_used。
  registry.handle(
    IPC_CHANNELS.memoryMessages,
    async (_event, request: MemoryMessagesRequest): Promise<MemoryMessagesResponse> =>
      await deps.client.listMessages(request),
  );

  registry.handle(
    IPC_CHANNELS.memorySummaries,
    async (_event, request: MemorySummariesRequest): Promise<MemorySummariesResponse> =>
      await deps.client.listSummaries(request),
  );

  registry.handle(
    IPC_CHANNELS.memoryEditSummary,
    async (_event, request: MemorySummaryEditRequest): Promise<MemorySummaryItem | null> =>
      await deps.client.editSummary(request),
  );

  registry.handle(
    IPC_CHANNELS.memoryDeleteSummary,
    async (_event, summaryId: number): Promise<boolean> =>
      await deps.client.deleteSummary(summaryId),
  );

  registry.handle(
    IPC_CHANNELS.memoryEditMessage,
    async (_event, request: MemoryMessageEditRequest) => await deps.client.editMessage(request),
  );

  registry.handle(
    IPC_CHANNELS.memoryDeleteMessage,
    async (_event, messageId: number): Promise<boolean> =>
      await deps.client.deleteMessage(messageId),
  );

  registry.handle(
    IPC_CHANNELS.memoryContext,
    async (_event, request: MemoryContextRequest): Promise<MemoryContextResponse> =>
      await deps.client.memoryContext(request),
  );
}
