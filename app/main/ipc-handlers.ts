/**
 * 文件职责：把 IPC 白名单的通道接到引擎与会话编排上（需求 §6.10）。
 *
 * 为什么收在一个模块：IPC 是 renderer 唯一能碰到主进程的入口，通道与实现集中在一处，
 * 想核对「界面能做什么」时只看这个文件即可（CODE_STYLE §1.3 的白名单意图）。
 * 依赖方向：main -> electron（ipcMain）+ ./ipc 契约 + ./engine + ./chat-orchestrator。
 * 谁调用：app/main/index.ts 在引擎起来之前注册；返回的注销函数交给 will-quit 调用。
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { app, BrowserWindow, dialog, ipcMain } from "electron";

import type { ChatOrchestrator } from "./chat-orchestrator";
import type { HealthView, SidecarEngine } from "./engine";
import { readEnvFile, updateEnvFile } from "./env-file";
import {
  IPC_CHANNELS,
  type AppInfo,
  type CharHitMessage,
  type CharacterHitsRequest,
  type CharacterHitsResponse,
  type CharacterPortraitRequest,
  type CharacterPortraitResponse,
  type CharacterSummary,
  type ChatCancelRequest,
  type ChatCancelResponse,
  type ChatSendRequest,
  type ChatSendResponse,
  type DevModeRequest,
  type DevModeResponse,
  type MemoryBehaviorRequest,
  type MemoryBehaviorResponse,
  type MemoryClearRequest,
  type MemoryClearResponse,
  type MemoryContextRequest,
  type MemoryContextResponse,
  type MemoryDeleteRequest,
  type MemoryDeleteResponse,
  type MemoryEditRequest,
  type MemoryEditResponse,
  type MemoryListRequest,
  type MemoryListResponse,
  type MemoryMessagesRequest,
  type MemoryMessagesResponse,
  type CharactersChangedMessage,
  type PackPickImageResponse,
  type PackSaveRequest,
  type PackSaveResponse,
  type ProviderCapability,
  type ProviderSettingsPatchEntry,
  type ProviderSettingsPayload,
  type ProviderTestReport,
  type UiDragMessage,
  type UiMetricsMessage,
  type UiPointerMessage,
  type UiStatePatch,
  type UiStatePayload,
  type VoiceStatePayload,
  type VoiceStopRequest,
  type VoiceStopResponse,
} from "./ipc";
import type { MainLogger } from "./logger";
import { readCharacterHits, readCharacterPortrait } from "./character-assets";
import { readImageAsDataUrl, saveCharacterPack } from "./pack-editor";
import { CharHitGate } from "./char-hit-gate";
import { readDevMode, writeDevMode } from "./dev-mode";
import { behaviorEnvUpdate, parseBehaviorEnabled } from "./memory-settings";
import { buildProviderSettings, providerPatchToEnv } from "./provider-settings";
import type { SidecarClient } from "./sidecar-client";
import type { UiController } from "./ui-controller";

export interface IpcHandlerDeps {
  readonly engine: SidecarEngine;
  readonly orchestrator: ChatOrchestrator;
  readonly ui: UiController;
  readonly logger: MainLogger;
  /** 供给探测要打到 sidecar /providers/test；端点由心跳同步（T1.14b）。 */
  readonly client: SidecarClient;
  /** characters/ 根目录：立绘与 hits.json 都从这里读（T2.3-C2）。 */
  readonly charactersDir: string;
  /** 「模型供给」读写的 .env 路径；密钥只在这条链路上流动，永不回传渲染层。 */
  readonly envFilePath: string;
  /** 开发者模式开关的落盘路径（data/dev.json，T2.3-B1）；只控制界面显隐，不是安全边界。 */
  readonly devFile: string;
  /** 打开角色包编辑器窗口（T2.3-D）；窗口单实例由调用方（index.ts）持有。 */
  readonly openPackEditor: () => void;
  /** 推送用；窗口可能不存在或正在关闭，取到的可能是 null 或已销毁的实例。 */
  readonly getWindow: () => BrowserWindow | null;
}

/**
 * 生成「推给渲染层」的函数；窗口没了就静默丢弃。
 * 单独导出是因为会话编排（T1.6b）也要推事件与音频，而它不持有 ipcMain。
 */
export function rendererPusher(
  getWindow: () => BrowserWindow | null,
): (channel: string, payload: unknown) => void {
  return (channel, payload) => {
    const window = getWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    window.webContents.send(channel, payload);
  };
}

/** 当前视图的 appGetInfo 返回；端口与 pid 未知时不带这两个字段（exactOptionalPropertyTypes 要求）。 */
function buildAppInfo(engine: SidecarEngine): AppInfo {
  const view: HealthView = engine.getHealth();
  const info: AppInfo = { app_version: app.getVersion() };
  return {
    ...info,
    ...(view.sidecar_port === null ? {} : { sidecar_port: view.sidecar_port }),
    ...(view.sidecar_pid === null ? {} : { sidecar_pid: view.sidecar_pid }),
  };
}

export function registerIpcHandlers(deps: IpcHandlerDeps): () => void {
  const push = rendererPusher(deps.getWindow);

  // 部位点击的闸门与待发事实（T2.3-C2b）：状态放在注册闭包里，注销时连同定时器一起清掉。
  const hitGate = new CharHitGate();
  let hitTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingHit: CharHitMessage | null = null;

  /** 发起一轮互动回应：复用聊天链路，interaction 字段会变成本轮的用户消息（core/prompt.py）。 */
  const startInteractionTurn = async (message: CharHitMessage, streak: number): Promise<void> => {
    const charId = deps.ui.getState().char_id ?? "";
    if (charId === "") {
      return;
    }
    try {
      const session = deps.orchestrator.session;
      const response = await deps.orchestrator.send({
        session_id: session === "" ? randomUUID() : session,
        char_id: charId,
        text: "",
        interaction: {
          region_id: message.region_id,
          region_name: message.region_name,
          streak,
          kind: message.kind,
        },
      });
      if (!response.accepted) {
        deps.logger.debug("ui.char_hit_skipped", "上一轮还没说完，这次点击不另起一轮", {
          region_id: message.region_id,
        });
      }
    } catch (error: unknown) {
      // 互动是增强项：失败只记日志——点击瞬间的本地台词已经给过反馈了（方案 §4.3）
      deps.logger.warn("ui.char_hit_speak_failed", "部位点击没能发起回应（不影响界面）", {
        error: String(error),
      });
    }
  };

  /** 到点真正发起一次；没到点（定时器早回来）就按剩余时间重排，绝不静默丢弃。 */
  const firePendingHit = (): void => {
    const latest = pendingHit;
    if (latest === null) {
      return;
    }
    const fired = hitGate.flush(Date.now());
    if (fired === null) {
      if (!hitGate.hasPending()) {
        // 这串已经被闸门吞了（≥10 下 / 每分钟上限）：点击早就记过账，本地兜底台词也发过了。
        pendingHit = null;
        deps.logger.debug("ui.char_hit_dropped", "这一串已被闸门吞掉，不再补发", {
          region_id: latest.region_id,
        });
        return;
      }
      const wait = Math.max(1, hitGate.remainingMs(Date.now()));
      deps.logger.debug("ui.char_hit_retry", "定时器比到点时刻早了一点点，按剩余时间重排", {
        wait_ms: wait,
      });
      armHitTimer(wait);
      return;
    }
    pendingHit = null;
    deps.logger.debug("ui.char_hit_fired", "部位点击发起回应", {
      region_id: latest.region_id,
      streak: fired.streak,
    });
    void startInteractionTurn(latest, fired.streak);
  };

  const armHitTimer = (delayMs: number): void => {
    if (hitTimer !== null) {
      clearTimeout(hitTimer);
    }
    hitTimer = setTimeout(() => {
      hitTimer = null;
      firePendingHit();
    }, delayMs);
  };

  ipcMain.handle(IPC_CHANNELS.healthGet, (): HealthView => deps.engine.getHealth());

  ipcMain.handle(IPC_CHANNELS.sidecarRestart, async (): Promise<HealthView> => {
    deps.logger.info("ipc.sidecar_restart", "收到界面发来的手动重启 sidecar 请求");
    return await deps.engine.restartSidecar("用户手动触发");
  });

  ipcMain.handle(IPC_CHANNELS.appGetInfo, (): AppInfo => buildAppInfo(deps.engine));

  // 聊天与语音：主进程只做转发与编排，业务语义在 chat-orchestrator（T1.6b）
  ipcMain.handle(
    IPC_CHANNELS.chatSend,
    async (_event, request: ChatSendRequest): Promise<ChatSendResponse> =>
      await deps.orchestrator.send(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.chatCancel,
    async (_event, request: ChatCancelRequest): Promise<ChatCancelResponse> =>
      await deps.orchestrator.cancel(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.voiceStart,
    async (): Promise<VoiceStatePayload> => await deps.orchestrator.startListening(),
  );

  ipcMain.handle(
    IPC_CHANNELS.voiceStop,
    async (_event, request: VoiceStopRequest): Promise<VoiceStopResponse> =>
      await deps.orchestrator.stopListening(request),
  );

  // 界面形态（T1.12a）：状态存在主进程，主窗与设置窗都从同一份读
  ipcMain.handle(IPC_CHANNELS.uiGetState, (): UiStatePayload => deps.ui.getState());

  ipcMain.handle(
    IPC_CHANNELS.uiSetState,
    async (_event, patch: UiStatePatch): Promise<UiStatePayload> => await deps.ui.setState(patch),
  );

  ipcMain.handle(IPC_CHANNELS.settingsOpen, (): void => {
    deps.ui.openSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.charList,
    async (): Promise<readonly CharacterSummary[]> => await deps.ui.characters(),
  );

  // 角色包素材（T2.3-C2）：立绘以 data URL 交给渲染层（CSP 只放行 'self' 与 data:，不放开 file://），
  // hits.json 是 0–1 归一化框，命中换算在渲染层做。两者都只读，坏包返回空值而不是报错。
  ipcMain.handle(
    IPC_CHANNELS.charPortrait,
    async (_event, request: CharacterPortraitRequest): Promise<CharacterPortraitResponse> => ({
      data_url: await readCharacterPortrait(deps.charactersDir, request.char_id),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.charHits,
    async (_event, request: CharacterHitsRequest): Promise<CharacterHitsResponse> => ({
      regions: await readCharacterHits(deps.charactersDir, request.char_id),
    }),
  );

  // 指针进出一律走单向消息：renderer 只报事实，开关穿透由主进程决定（§6.11）
  ipcMain.on(IPC_CHANNELS.uiPointer, (_event, message: UiPointerMessage): void => {
    deps.ui.setPointerInside(message.inside);
  });

  // 立绘包围盒与聊天条高度同样是「renderer 报事实、main 决定窗口」：尺寸 = 素材包围盒 × 缩放 + 聊天条
  ipcMain.on(IPC_CHANNELS.uiMetrics, (_event, message: UiMetricsMessage): void => {
    deps.ui.noteMetrics(message);
  });

  // JS 拖动同样是「renderer 报事实」：它只报开始 / 结束，位置由 main 读系统光标算（T2.2）
  ipcMain.on(IPC_CHANNELS.uiDrag, (_event, message: UiDragMessage): void => {
    if (message.action === "end") {
      deps.ui.endDrag();
      return;
    }
    deps.ui.beginDrag();
  });

  // 部位点击（T2.3-C2 / C2b）：渲染层只报事实（哪个部位、这一串点了几下），记账与「要不要花一次
  // LLM」都在主进程做：记账每次都要，发起回应要过闸门（去抖 / 冷却 / 每分钟上限 / 太欠就吞掉）。
  ipcMain.on(IPC_CHANNELS.uiCharHit, (_event, message: CharHitMessage): void => {
    const charId = deps.ui.getState().char_id ?? "";
    deps.logger.debug("ui.char_hit", "立绘部位被点", {
      char_id: charId,
      region_id: message.region_id,
      streak: message.streak,
      kind: message.kind,
    });
    if (charId === "") {
      return;
    }
    void deps.client
      .recordUsage({
        fact: "char_hit",
        char_id: charId,
        region_id: message.region_id,
        streak: message.streak,
      })
      .catch((error: unknown) => {
        // 纯统计：失败只记日志，不打断界面（§6.9 的降级口径）
        deps.logger.warn("ui.char_hit_failed", "部位点击没能记账（不影响界面）", {
          error: String(error),
        });
      });

    const decision = hitGate.onHit(message.streak, Date.now());
    if (decision.kind === "ignored") {
      deps.logger.debug("ui.char_hit_gated", "这次点击只记账，不发起回应", {
        reason: decision.reason,
        streak: message.streak,
      });
      return;
    }
    pendingHit = message;
    armHitTimer(decision.delayMs);
  });

  // 模型供给（T1.14b）：配置的唯一事实来源是 .env，这里只做「读写 + 探测」三件事。
  // 读回来的密钥一律只给布尔量；写的时候用 applyEnvUpdates 保住注释与顺序（见 env-file.ts）。
  ipcMain.handle(IPC_CHANNELS.providersGet, async (): Promise<ProviderSettingsPayload> => ({
    entries: buildProviderSettings(await readEnvFile(deps.envFilePath)),
    env_file: deps.envFilePath,
  }));

  ipcMain.handle(
    IPC_CHANNELS.providersSet,
    async (
      _event,
      patch: readonly ProviderSettingsPatchEntry[],
    ): Promise<ProviderSettingsPayload> => {
      const updates = providerPatchToEnv(patch);
      const env = await updateEnvFile(deps.envFilePath, updates);
      // 只记改了几个键，不记键值：LLM key 与 TTS token 都在这条路上（§7.1）
      deps.logger.info("ipc.providers_set", "已把模型供给设置写回 .env", {
        changed: Object.keys(updates).length,
      });
      return { entries: buildProviderSettings(env), env_file: deps.envFilePath };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.providersTest,
    async (_event, capability: ProviderCapability): Promise<ProviderTestReport> =>
      await deps.client.testProvider(capability),
  );

  // 记忆管理（T2.1b）：界面只能看和删，写入永远由对话链路产生（§6.4）。
  // 记忆是增强项：sidecar 没起来时这里会抛 SidecarUnavailableError，设置窗只显示错误，不影响聊天。
  ipcMain.handle(
    IPC_CHANNELS.memoryList,
    async (_event, request: MemoryListRequest): Promise<MemoryListResponse> => ({
      items: await deps.client.listMemories(request),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryDelete,
    async (_event, request: MemoryDeleteRequest): Promise<MemoryDeleteResponse> => ({
      deleted: await deps.client.deleteMemory(request.memory_id),
    }),
  );

  // 编辑 L0（T2.3-B2，只在开发者模式露出）：只动 memories 表，行为观察由 sidecar 挡。
  ipcMain.handle(
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

  ipcMain.handle(
    IPC_CHANNELS.memoryClear,
    async (_event, request: MemoryClearRequest): Promise<MemoryClearResponse> => {
      const deleted = await deps.client.clearMemories(request);
      // 只记「删了几条」，不记记忆正文：正文可能含用户隐私（§7.1）
      deps.logger.info("ipc.memory_clear", "用户清空了角色记忆", { deleted });
      return { deleted };
    },
  );

  // 行为记忆开关（T2.1c）：enabled = null 只读；true / false 写 .env，下一次 sidecar 启动生效。
  // 这里和「模型供给」一样把 .env 当成唯一事实来源，界面不缓存，每次问一遍。
  ipcMain.handle(
    IPC_CHANNELS.memoryBehavior,
    async (_event, request: MemoryBehaviorRequest): Promise<MemoryBehaviorResponse> => {
      if (request.enabled === null) {
        return { enabled: parseBehaviorEnabled(await readEnvFile(deps.envFilePath)) };
      }
      const env = await updateEnvFile(deps.envFilePath, behaviorEnvUpdate(request.enabled));
      // 只记开关状态，不记键值：这条链路上没有隐私，但保持与其他设置通道一致的日志口径
      deps.logger.info("ipc.memory_behavior", "行为记忆总开关已写回 .env", {
        enabled: request.enabled,
      });
      return { enabled: parseBehaviorEnabled(env) };
    },
  );

  // 开发者模式开关（T2.3-B1）：存在 data/dev.json，与 .env / ui.json 都无关（用户 m09634 定案）。
  // enabled = null 只读；这个开关不是安全边界，所以写它不需要额外确认。
  ipcMain.handle(
    IPC_CHANNELS.devModeGet,
    async (): Promise<DevModeResponse> => await readDevMode(deps.devFile),
  );

  ipcMain.handle(
    IPC_CHANNELS.devModeSet,
    async (_event, request: DevModeRequest): Promise<DevModeResponse> => {
      if (request.enabled === null) {
        return await readDevMode(deps.devFile);
      }
      await writeDevMode(deps.devFile, { enabled: request.enabled });
      deps.logger.info("ipc.dev_mode", "开发者模式开关已写回 data/dev.json", {
        enabled: request.enabled,
      });
      return { enabled: request.enabled };
    },
  );

  // 开发者模式的两页（T2.3-B1）：原文只读转发；注入预览由 sidecar 干跑装配、不 mark_used。
  ipcMain.handle(
    IPC_CHANNELS.memoryMessages,
    async (_event, request: MemoryMessagesRequest): Promise<MemoryMessagesResponse> =>
      await deps.client.listMessages(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryContext,
    async (_event, request: MemoryContextRequest): Promise<MemoryContextResponse> =>
      await deps.client.memoryContext(request),
  );

  // 角色包编辑器（T2.3-D）：选图走系统对话框、写盘走 pack-editor；渲染层全程只拿到 data URL。
  ipcMain.handle(IPC_CHANNELS.packOpenEditor, (): void => {
    deps.openPackEditor();
  });

  ipcMain.handle(IPC_CHANNELS.packPickImage, async (event): Promise<PackPickImageResponse> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    // 不传 properties：默认就是「选单个已存在的文件」
    const options = {
      title: "选一张立绘（PNG / JPEG / WebP）",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    };
    // 有父窗口就挂在它上面：否则对话框可能被窗口盖住，用户以为点了没反应
    const picked =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    const file = picked.canceled ? null : (picked.filePaths[0] ?? null);
    if (file === null) {
      return { canceled: true, data_url: "", file_name: "" };
    }
    let dataUrl: string;
    try {
      dataUrl = await readImageAsDataUrl(file);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    const fileName = basename(file);
    deps.logger.info("ipc.pack_pick_image", "选中一张立绘", { file_name: fileName });
    return { canceled: false, data_url: dataUrl, file_name: fileName };
  });

  ipcMain.handle(
    IPC_CHANNELS.packSave,
    async (_event, request: PackSaveRequest): Promise<PackSaveResponse> => {
      const result = await saveCharacterPack(deps.charactersDir, request);
      if (result.ok) {
        deps.logger.info("ipc.pack_save", "角色包已保存", {
          char_id: result.char_id,
          files: result.files.length,
        });
        // 两个渲染层都要知道目录变了：聊天条的角色菜单与设置窗的角色下拉都从 characters/ 读
        const message: CharactersChangedMessage = { char_id: result.char_id };
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.charactersChanged, message);
          }
        }
      } else {
        deps.logger.warn("ipc.pack_save_failed", "角色包没存下", {
          char_id: result.char_id,
          reason: result.error,
        });
      }
      return {
        ok: result.ok,
        char_id: result.char_id,
        error: result.error,
        files: [...result.files],
      };
    },
  );

  // 心跳变化只推给渲染层，不做业务判断：状态机在主进程，界面只是显示器
  const unsubscribe = deps.engine.onHealthChanged((view) => {
    push(IPC_CHANNELS.healthChanged, view);
  });

  return () => {
    unsubscribe();
    // 注销通道，避免「窗口重建后旧 handler 还挂着」导致重复响应
    ipcMain.removeHandler(IPC_CHANNELS.healthGet);
    ipcMain.removeHandler(IPC_CHANNELS.sidecarRestart);
    ipcMain.removeHandler(IPC_CHANNELS.appGetInfo);
    ipcMain.removeHandler(IPC_CHANNELS.chatSend);
    ipcMain.removeHandler(IPC_CHANNELS.chatCancel);
    ipcMain.removeHandler(IPC_CHANNELS.voiceStart);
    ipcMain.removeHandler(IPC_CHANNELS.voiceStop);
    ipcMain.removeHandler(IPC_CHANNELS.uiGetState);
    ipcMain.removeHandler(IPC_CHANNELS.uiSetState);
    ipcMain.removeHandler(IPC_CHANNELS.settingsOpen);
    ipcMain.removeHandler(IPC_CHANNELS.charList);
    ipcMain.removeHandler(IPC_CHANNELS.charPortrait);
    ipcMain.removeHandler(IPC_CHANNELS.charHits);
    ipcMain.removeHandler(IPC_CHANNELS.providersGet);
    ipcMain.removeHandler(IPC_CHANNELS.providersSet);
    ipcMain.removeHandler(IPC_CHANNELS.providersTest);
    ipcMain.removeHandler(IPC_CHANNELS.memoryList);
    ipcMain.removeHandler(IPC_CHANNELS.memoryDelete);
    ipcMain.removeHandler(IPC_CHANNELS.memoryEdit);
    ipcMain.removeHandler(IPC_CHANNELS.memoryClear);
    ipcMain.removeHandler(IPC_CHANNELS.memoryBehavior);
    ipcMain.removeHandler(IPC_CHANNELS.devModeGet);
    ipcMain.removeHandler(IPC_CHANNELS.devModeSet);
    ipcMain.removeHandler(IPC_CHANNELS.memoryMessages);
    ipcMain.removeHandler(IPC_CHANNELS.memoryContext);
    ipcMain.removeHandler(IPC_CHANNELS.packOpenEditor);
    ipcMain.removeHandler(IPC_CHANNELS.packPickImage);
    ipcMain.removeHandler(IPC_CHANNELS.packSave);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiPointer);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiMetrics);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiDrag);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiCharHit);
    if (hitTimer !== null) {
      clearTimeout(hitTimer);
      hitTimer = null;
    }
    pendingHit = null;
    hitGate.reset();
  };
}
