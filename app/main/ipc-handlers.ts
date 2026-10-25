/**
 * 文件职责：把 IPC 白名单的通道接到引擎与会话编排上（需求 §6.10）。
 *
 * 为什么收在一个模块：IPC 是 renderer 唯一能碰到主进程的入口，通道与实现集中在一处，
 * 想核对「界面能做什么」时只看这个文件即可（CODE_STYLE §1.3 的白名单意图）。
 * 依赖方向：main -> electron（ipcMain）+ ./ipc 契约 + ./engine + ./chat-orchestrator。
 * 谁调用：app/main/index.ts 在引擎起来之前注册；返回的注销函数交给 will-quit 调用。
 */
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";

import type { ActivityLog } from "./activity-log";
import type { ChatOrchestrator } from "./chat-orchestrator";
import type { HealthView, SidecarEngine } from "./engine";
import { readEnvFile, updateEnvFile } from "./env-file";
import {
  IPC_CHANNELS,
  type AppInfo,
  type TouchGateState,
  type TouchIntentMessage,
  type TouchMessage,
  type UiInputModeMessage,
  type CharacterHitsRequest,
  type CharacterHitsResponse,
  type CharacterAppearanceRequest,
  type CharacterAppearanceResponse,
  type CharacterPortraitRequest,
  type CharacterPortraitResponse,
  type CharacterSummary,
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
  type MemoryMessageEditRequest,
  type MemorySummariesRequest,
  type MemorySummariesResponse,
  type MemorySummaryEditRequest,
  type MemorySummaryItem,
  type CharactersChangedMessage,
  type PackPickImageResponse,
  type PackLoadRequest,
  type PackLoadResponse,
  type PackOpenEditorRequest,
  type PackSaveCardRequest,
  type PackSaveRegionsRequest,
  type PackSaveRequest,
  type PackSaveResponse,
  type PackExportRequest,
  type PackExportResponse,
  type PackImportRequest,
  type PackImportResponse,
  type ProviderCapability,
  type ProviderSettingsPatchEntry,
  type ProviderSettingsPayload,
  type ProviderTestReport,
  type UsageStats,
  type UiDragMessage,
  type UiMetricsMessage,
  type UiPointerMessage,
  type UiStatePatch,
  type UiStatePayload,
  type VoiceStatePayload,
  type VoiceStopRequest,
  type VoiceStopResponse,
  type VoiceBeginRequest,
  type VoiceAudioChunk,
  type VoiceEndRequest,
  type NativeMicStartResponse,
} from "./ipc";
import type { NativeMicCapture } from "./native-mic";
import type { MainLogger } from "./logger";
import { microphoneAccessStatus } from "./media-permissions";
import type { ModelManager } from "./model-manager";
import {
  readCharacterAppearance,
  readCharacterHits,
  readCharacterPortrait,
} from "./character-assets";
import {
  loadCharacterPack,
  readImageAsDataUrl,
  saveCharacterCard,
  saveCharacterPack,
  saveCharacterRegions,
} from "./pack-editor";
import {
  commitPackImport,
  exportPackArchive,
  inspectPackArchive,
  type PackImportPreview,
} from "./pack-archive";
import { CharHitGate, HIT_COOLDOWN_MS, HIT_RATE_MAX } from "./char-hit-gate";
import { classifyTouchIntent, mergeTouches, type TouchIntent } from "./touch-arbiter";
import type { TurnCoordinator } from "./turn-coordinator";
import { readDevMode, writeDevMode } from "./dev-mode";
import { behaviorEnvUpdate, parseBehaviorEnabled } from "./memory-settings";
import { buildProviderSettings, providerPatchToEnv } from "./provider-settings";
import type { SidecarClient } from "./sidecar-client";
import type { UiController } from "./ui-controller";
import type { VoiceSocketClient } from "./voice-socket";

export interface IpcHandlerDeps {
  readonly engine: SidecarEngine;
  readonly orchestrator: ChatOrchestrator;
  /** 语音 / 文字 / 触摸共用的单一话筒（T2.6）：模式、phase、取消都从这里过。 */
  readonly turn: TurnCoordinator;
  readonly ui: UiController;
  readonly logger: MainLogger;
  /** 供给探测要打到 sidecar /providers/test；端点由心跳同步（T1.14b）。 */
  readonly client: SidecarClient;
  /** 语音全双工长连接（P2）：音频上行 / 事件下行都经它。 */
  readonly voiceSocket: VoiceSocketClient;
  /** Chromium 麦克风不可用时，由 sidecar helper 做 Windows 原生采集。 */
  readonly nativeMic: NativeMicCapture | null;
  /** characters/ 根目录：立绘与 hits.json 都从这里读（T2.3-C2）。 */
  readonly charactersDir: string;
  /** 「模型供给」读写的 .env 路径；密钥只在这条链路上流动，永不回传渲染层。 */
  readonly envFilePath: string;
  /** 开发者模式开关的落盘路径（data/dev.json，T2.3-B1）；只控制界面显隐，不是安全边界。 */
  readonly devFile: string;
  /** 打开角色包编辑器窗口（T2.3-D）；mode=edit 时只编辑当前角色的部位（T2.5）。 */
  readonly openCompanion: () => void;
  readonly activity: ActivityLog;
  readonly models: ModelManager;
  readonly openPackEditor: (request: PackOpenEditorRequest) => void;
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
  const recordActivity = (text: string): void => {
    const companion = deps.ui.getState().companion;
    if (companion.enabled || companion.app_activity_enabled) {
      deps.activity.record(text);
    }
  };

  /** characters/ 变了：两个渲染层都要刷新（角色菜单 / 设置窗下拉 / 当前角色 hits）。 */
  const broadcastCharactersChanged = (charId: string): void => {
    const message: CharactersChangedMessage = { char_id: charId };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.charactersChanged, message);
      }
    }
  };

  // 触摸（T2.3-C2c / T2.6）：闸门、提前 intent、冷却排队三类状态都放在注册闭包里，
  // 注销时连同定时器一起清掉。模式互斥后，触摸只在 mode === "touch" 时被接受。
  const hitGate = new CharHitGate();
  let hitTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingHit: TouchMessage | null = null;
  let pendingHitIntent: TouchIntent = "demand";
  let pendingHitCharId = "";
  let queuedTouch: {
    message: TouchMessage;
    count: number;
    dueAt: number;
    expiresAt: number;
    charId: string;
  } | null = null;
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  let intentTimer: ReturnType<typeof setTimeout> | null = null;
  /** demand intent 已经把旧轮取消了，等完整会话到了再起新轮（不能在这里丢）。 */
  let touchIntentPending = false;

  /** 把闸门当前快照推给渲染层；只用于画冷却条与额度点，不参与判断。 */
  const pushTouchGate = (): void => {
    const now = Date.now();
    const endsAt = hitGate.cooldownEndsAt(now);
    const remaining = Number.isFinite(endsAt) ? Math.max(0, endsAt - now) : 0;
    const state: TouchGateState = {
      cooldown_remaining_ms: remaining,
      cooldown_total_ms: HIT_COOLDOWN_MS,
      rate_remaining: hitGate.remainingCalls(now),
      rate_max: HIT_RATE_MAX,
      pending: hitGate.hasPending(),
    };
    push(IPC_CHANNELS.uiTouchGate, state);
  };

  /** 冷却期排队上限：超过 10s 还没发出去就丢（用户早就忘了这一下）。 */
  const TOUCH_QUEUE_TTL_MS = 10_000;
  /** 提前 intent 后迟迟没有完整会话（手势被取消 / 模式切走）时，别让界面卡在 cancelling。 */
  const TOUCH_INTENT_FALLBACK_MS = 2_500;

  /** 发起一轮互动回应：复用聊天链路，interaction 字段会变成本轮的用户消息（core/prompt.py）。 */
  const startInteractionTurn = async (message: TouchMessage, count: number): Promise<void> => {
    const charId = deps.ui.getState().char_id ?? "";
    if (charId === "") {
      return;
    }
    await deps.turn.startHttp();
    try {
      const session = deps.orchestrator.session;
      const response = await deps.orchestrator.send({
        session_id: session === "" ? randomUUID() : session,
        char_id: charId,
        text: "",
        interaction: {
          gesture: message.gesture,
          regions: message.regions,
          count,
          duration_ms: message.duration_ms,
        },
        app_context: deps.activity.recent(),
      });
      if (!response.accepted) {
        deps.logger.debug("ui.char_hit_skipped", "上一轮还没说完，这次触摸不另起一轮", {
          gesture: message.gesture,
          count,
        });
      }
    } catch (error: unknown) {
      // 互动是增强项：失败只记日志——点到时界面已经回了脉冲（方案 §4.3）
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
    if (deps.ui.getState().char_id !== pendingHitCharId) {
      pendingHit = null;
      deps.logger.debug("ui.char_hit_dropped", "角色已经切走，这条触摸不再补发");
      return;
    }
    if (pendingHitIntent === "backchannel" && deps.turn.getPhase() !== "idle") {
      pendingHit = null;
      deps.logger.debug("ui.touch_backchannel_dropped", "轻点还没发出去，角色已经开始新一轮");
      return;
    }
    const fired = hitGate.flush(Date.now());
    if (fired === null) {
      if (!hitGate.hasPending()) {
        pendingHit = null;
        deps.logger.debug("ui.char_hit_dropped", "这一串已被闸门吞掉，不再补发", {
          gesture: latest.gesture,
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
    deps.logger.debug("ui.char_hit_fired", "触摸发起回应", {
      gesture: latest.gesture,
      count: fired.count,
      intent: pendingHitIntent,
    });
    pushTouchGate();
    void startInteractionTurn(latest, fired.count);
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

  const clearPendingHit = (): void => {
    if (hitTimer !== null) {
      clearTimeout(hitTimer);
      hitTimer = null;
    }
    pendingHit = null;
    pendingHitIntent = "demand";
    pendingHitCharId = "";
    hitGate.reset();
  };

  const clearQueuedTouch = (): void => {
    if (queueTimer !== null) {
      clearTimeout(queueTimer);
      queueTimer = null;
    }
    queuedTouch = null;
  };

  const clearIntentFallback = (): void => {
    if (intentTimer !== null) {
      clearTimeout(intentTimer);
      intentTimer = null;
    }
  };

  const clearTouchWaiting = (): void => {
    clearPendingHit();
    clearQueuedTouch();
    clearIntentFallback();
    touchIntentPending = false;
  };

  /** 冷却期的 demand：合并成一条，等冷却结束且界面空闲再发。 */
  const queueDemand = (message: TouchMessage, count: number, dueAt: number): void => {
    const charId = deps.ui.getState().char_id ?? "";
    if (charId === "") {
      return;
    }
    const older = queuedTouch;
    const merged = mergeTouches(older?.message ?? null, message);
    queuedTouch = {
      message: merged,
      count: Math.max(older?.count ?? 0, count),
      dueAt: older === null ? dueAt : Math.min(older.dueAt, dueAt),
      expiresAt: older?.expiresAt ?? Date.now() + TOUCH_QUEUE_TTL_MS,
      charId,
    };
    armQueueTimer();
    deps.logger.debug("ui.touch_queued", "冷却期 demand 已排队", {
      gesture: merged.gesture,
      count: queuedTouch.count,
      wait_ms: Math.max(0, queuedTouch.dueAt - Date.now()),
    });
  };

  const fireQueued = (): void => {
    const queued = queuedTouch;
    if (queued === null) {
      return;
    }
    const now = Date.now();
    if (now > queued.expiresAt) {
      clearQueuedTouch();
      deps.logger.debug("ui.touch_queue_drop", "排队触摸超过 TTL，丢弃");
      return;
    }
    // 到期时角色还在说 / 在想：不二次打断，等下一次 idle（subscribe 会再调一次）
    if (deps.turn.getPhase() !== "idle") {
      return;
    }
    if (deps.ui.getState().char_id !== queued.charId) {
      clearQueuedTouch();
      deps.logger.debug("ui.touch_queue_drop", "角色已经切走，排队触摸丢弃");
      return;
    }
    const decision = hitGate.onHit(queued.count, now, 0);
    if (decision.kind === "ignored") {
      if (decision.reason === "cooling") {
        queued.dueAt = hitGate.cooldownEndsAt(now);
        armQueueTimer();
        return;
      }
      clearQueuedTouch();
      deps.logger.debug("ui.touch_queue_drop", "排队触摸被闸门吞掉", {
        reason: decision.reason,
      });
      return;
    }
    pendingHit = queued.message;
    pendingHitIntent = "demand";
    pendingHitCharId = queued.charId;
    queuedTouch = null;
    if (queueTimer !== null) {
      clearTimeout(queueTimer);
      queueTimer = null;
    }
    deps.logger.debug("ui.touch_queue_fire", "排队触摸开始起轮", {
      gesture: queued.message.gesture,
      count: queued.count,
    });
    armHitTimer(decision.delayMs);
  };

  const armQueueTimer = (): void => {
    if (queueTimer !== null) {
      clearTimeout(queueTimer);
    }
    const queued = queuedTouch;
    if (queued === null) {
      return;
    }
    queueTimer = setTimeout(
      () => {
        queueTimer = null;
        fireQueued();
      },
      Math.max(0, queued.dueAt - Date.now()),
    );
  };

  // 排队 demand 到期时角色还在说：等回到 idle 再发（不二次打断）
  const unsubscribeTurn = deps.turn.subscribe((phase) => {
    if (phase === "idle") {
      fireQueued();
    }
  });

  ipcMain.handle(IPC_CHANNELS.healthGet, (): HealthView => deps.engine.getHealth());

  ipcMain.handle(IPC_CHANNELS.sidecarRestart, async (): Promise<HealthView> => {
    deps.logger.info("ipc.sidecar_restart", "收到界面发来的手动重启 sidecar 请求");
    return await deps.engine.restartSidecar("用户手动触发");
  });

  ipcMain.handle(IPC_CHANNELS.appGetInfo, (): AppInfo => buildAppInfo(deps.engine));

  // 聊天与语音：主进程只做转发与编排，业务语义在 chat-orchestrator（T1.6b）
  ipcMain.handle(
    IPC_CHANNELS.chatSend,
    async (_event, request: ChatSendRequest): Promise<ChatSendResponse> => {
      if (deps.turn.getMode() !== "text") {
        return {
          accepted: false,
          session_id: request.session_id,
          reason: "当前不是文字模式；先切到「文字」再发送",
        };
      }
      // 忙时先停播 + cancel 旧轮（T2.6：文字发送与语音开口一样可以抢话筒）
      await deps.turn.startHttp();
      return await deps.orchestrator.send({
        ...request,
        app_context: deps.activity.recent(),
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.chatCancel, async (): Promise<ChatCancelResponse> => {
    const active = deps.turn.isBusy();
    await deps.turn.cancelAll();
    deps.turn.finishCancel();
    return active ? { cancelled: true } : { cancelled: false, reason: "当前没有进行中的回复" };
  });

  ipcMain.handle(
    IPC_CHANNELS.voiceStart,
    async (): Promise<VoiceStatePayload> => await deps.orchestrator.startListening(),
  );

  ipcMain.handle(
    IPC_CHANNELS.voiceStop,
    async (_event, request: VoiceStopRequest): Promise<VoiceStopResponse> =>
      await deps.orchestrator.stopListening(request),
  );

  // 语音全双工（P2）：渲染层只报「开始 / 音频块 / 说完 / 打断」，其余都交给 sidecar 的 WS 流水线
  ipcMain.handle(IPC_CHANNELS.voiceMicStatus, () => ({
    status: microphoneAccessStatus(),
  }));

  ipcMain.handle(IPC_CHANNELS.voiceOpenMicSettings, async (): Promise<void> => {
    await shell.openExternal("ms-settings:privacy-microphone");
  });

  ipcMain.handle(IPC_CHANNELS.voiceOpenSoundSettings, async (): Promise<void> => {
    await shell.openExternal("ms-settings:sound");
  });

  ipcMain.handle(IPC_CHANNELS.voiceNativeStart, async (): Promise<NativeMicStartResponse> => {
    if (deps.nativeMic === null) {
      return { ok: false, error: "原生麦克风未装配" };
    }
    return deps.nativeMic.start();
  });

  ipcMain.handle(IPC_CHANNELS.voiceNativeStop, async (): Promise<void> => {
    await deps.nativeMic?.stop();
  });

  ipcMain.on(IPC_CHANNELS.voiceBegin, (_event, request: VoiceBeginRequest): void => {
    if (deps.turn.getMode() !== "voice") {
      return;
    }
    void (async (): Promise<void> => {
      await deps.turn.startVoice();
      deps.voiceSocket.begin(request);
    })();
  });

  ipcMain.on(IPC_CHANNELS.voiceAudio, (_event, chunk: VoiceAudioChunk): void => {
    if (deps.turn.getMode() !== "voice") {
      return;
    }
    deps.voiceSocket.sendAudio(chunk.pcm);
  });

  ipcMain.on(IPC_CHANNELS.voiceEnd, (_event, request: VoiceEndRequest): void => {
    if (deps.turn.getMode() !== "voice") {
      return;
    }
    deps.turn.markVoiceEnd();
    deps.voiceSocket.end(request);
  });

  ipcMain.on(IPC_CHANNELS.voiceCancel, (): void => {
    void (async (): Promise<void> => {
      await deps.turn.cancelAll();
      deps.turn.finishCancel();
    })();
  });

  // 输入模式（T2.6）：三选一。切走语音且正在听 -> 取消未提交的语音轮；切走触摸 -> 清排队。
  ipcMain.on(IPC_CHANNELS.uiInputMode, (_event, message: UiInputModeMessage): void => {
    const previous = deps.turn.getMode();
    deps.turn.setMode(message.mode);
    if (previous !== message.mode) {
      const label = message.mode === "text" ? "文字" : message.mode === "voice" ? "语音" : "互动";
      recordActivity("用户切到了" + label + "模式。");
    }
    deps.logger.debug("ui.input_mode", "输入模式切换", {
      from: previous,
      to: message.mode,
    });
    pushTouchGate();
    if (previous === "voice" && message.mode !== "voice" && deps.turn.getPhase() === "listening") {
      void (async (): Promise<void> => {
        await deps.turn.cancelAll();
        deps.turn.finishCancel();
      })();
    }
    if (message.mode !== "touch") {
      clearTouchWaiting();
      if (previous === "touch" && deps.turn.getPhase() === "cancelling") {
        deps.turn.finishCancel();
      }
    }
  });

  // demand 手势刚成立：只停播 + cancel，完整事实稍后仍走 uiCharHit（T2.6 两阶段）
  ipcMain.on(IPC_CHANNELS.uiTouchIntent, (_event, message: TouchIntentMessage): void => {
    if (deps.turn.getMode() !== "touch") {
      return;
    }
    const now = Date.now();
    if (hitGate.isRateLimited(now) || hitGate.isCooling(now)) {
      deps.logger.debug("ui.touch_intent_skip", "冷却 / 超频期不在手势成立时取消", {
        gesture: message.gesture,
      });
      return;
    }
    const phase = deps.turn.getPhase();
    if (phase !== "thinking" && phase !== "speaking") {
      return;
    }
    deps.logger.debug("ui.touch_intent", "demand 手势成立，提前停播", {
      gesture: message.gesture,
      phase,
    });
    touchIntentPending = true;
    void (async (): Promise<void> => {
      await deps.turn.cancelAll();
      clearIntentFallback();
      intentTimer = setTimeout(() => {
        intentTimer = null;
        touchIntentPending = false;
        deps.turn.finishCancel();
      }, TOUCH_INTENT_FALLBACK_MS);
    })();
  });

  // 界面形态（T1.12a）：状态存在主进程，主窗与设置窗都从同一份读
  ipcMain.handle(IPC_CHANNELS.uiGetState, (): UiStatePayload => deps.ui.getState());

  ipcMain.handle(
    IPC_CHANNELS.uiSetState,
    async (_event, patch: UiStatePatch): Promise<UiStatePayload> => {
      const before = deps.ui.getState();
      const next = await deps.ui.setState(patch);
      // 语音输出开关同时作用于主进程的合成链（文字聊天走这里；语音轮由 WS 自己带过去）
      if (typeof patch.tts_enabled === "boolean") {
        deps.orchestrator.setTtsEnabled(patch.tts_enabled);
        if (before.tts_enabled !== patch.tts_enabled) {
          recordActivity(patch.tts_enabled ? "用户打开了语音输出。" : "用户关闭了语音输出。");
        }
      }
      if (
        typeof patch.always_on_top === "boolean" &&
        before.always_on_top !== patch.always_on_top
      ) {
        recordActivity(
          patch.always_on_top ? "用户把窗口设为置顶。" : "用户把窗口设为只在桌面显示。",
        );
      }
      if (
        patch.char_id !== undefined &&
        patch.char_id !== null &&
        before.char_id !== next.char_id
      ) {
        recordActivity("用户切换了角色。");
      }
      return next;
    },
  );

  ipcMain.handle(IPC_CHANNELS.settingsOpen, (): void => {
    recordActivity("用户打开了设置。");
    deps.ui.openSettings();
  });

  ipcMain.handle(IPC_CHANNELS.companionOpen, (): void => {
    recordActivity("用户打开了主动陪伴设置。");
    deps.openCompanion();
  });

  ipcMain.handle(IPC_CHANNELS.modelsList, async () => await deps.models.list());
  ipcMain.handle(IPC_CHANNELS.modelsInstall, async (_event, id: string): Promise<void> => {
    await deps.models.install(id);
  });
  ipcMain.handle(IPC_CHANNELS.modelsRemove, async (_event, id: string): Promise<void> => {
    await deps.models.remove(id);
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

  // appearance.json 的只读投影（T2.4）：Stage 抽象层据此选 PNG / Live2D 实现、按 acts 播动作
  ipcMain.handle(
    IPC_CHANNELS.charAppearance,
    async (_event, request: CharacterAppearanceRequest): Promise<CharacterAppearanceResponse> => ({
      appearance: await readCharacterAppearance(deps.charactersDir, request.char_id),
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
  ipcMain.on(IPC_CHANNELS.uiMinimize, (): void => {
    recordActivity("用户把主窗收进了托盘。");
    deps.ui.minimize();
  });

  ipcMain.on(IPC_CHANNELS.uiDrag, (_event, message: UiDragMessage): void => {
    if (message.action === "end") {
      deps.ui.endDrag();
      return;
    }
    deps.ui.beginDrag();
  });

  // 触摸（T2.3-C2c / T2.6）：渲染层只报事实（手势、摸过哪些部位、这一串几下、按了多久），
  // 记账每次都要；发起回应要先过意图分类与闸门。三模式互斥后，只有 touch 模式会走到这里。
  ipcMain.on(IPC_CHANNELS.uiCharHit, (_event, message: TouchMessage): void => {
    const charId = deps.ui.getState().char_id ?? "";
    deps.logger.debug("ui.char_hit", "立绘被触摸", {
      char_id: charId,
      mode: deps.turn.getMode(),
      gesture: message.gesture,
      regions: message.regions.map((region) => region.id).join(","),
      count: message.count,
      duration_ms: message.duration_ms,
    });
    if (deps.turn.getMode() !== "touch" || charId === "") {
      return;
    }
    pushTouchGate();
    void deps.client
      .recordUsage({
        fact: "char_hit",
        char_id: charId,
        region_id: message.regions[0]?.id ?? "",
        gesture: message.gesture,
        count: message.count,
      })
      .catch((error: unknown) => {
        // 纯统计：失败只记日志，不打断界面（§6.9 的降级口径）
        deps.logger.warn("ui.char_hit_failed", "触摸没能记账（不影响界面）", {
          error: String(error),
        });
      });

    const intent = classifyTouchIntent(message);
    const phase = deps.turn.getPhase();
    if (intent === "backchannel" && (phase === "thinking" || phase === "speaking")) {
      deps.logger.debug("ui.touch_backchannel", "轻点不打断当前轮", { phase });
      return;
    }
    if (phase === "cancelling") {
      if (!touchIntentPending || intent !== "demand") {
        deps.logger.debug("ui.char_hit_dropped", "正在取消，丢弃这一串触摸");
        return;
      }
      // 这是 intent 提前取消的那一串：完整会话到了，接着起新轮（不要重复 cancel）
      touchIntentPending = false;
      clearIntentFallback();
    }

    const schedule = (now: number): void => {
      if (intent === "demand" && hitGate.isRateLimited(now)) {
        deps.logger.debug("ui.char_hit_gated", "每分钟触摸上限已满，只记账", {
          count: message.count,
        });
        return;
      }
      if (intent === "demand" && hitGate.isCooling(now)) {
        const dueAt = hitGate.cooldownEndsAt(now);
        if (!Number.isFinite(dueAt)) {
          deps.logger.debug("ui.char_hit_gated", "冷却且已超频，只记账");
          return;
        }
        queueDemand(message, message.count, dueAt);
        return;
      }
      const decision = hitGate.onHit(message.count, now, intent === "demand" ? 0 : undefined);
      if (decision.kind === "ignored") {
        deps.logger.debug("ui.char_hit_gated", "这次触摸只记账，不发起回应", {
          reason: decision.reason,
          count: message.count,
        });
        return;
      }
      pendingHit = message;
      pendingHitIntent = intent;
      pendingHitCharId = charId;
      clearIntentFallback();
      armHitTimer(decision.delayMs);
      pushTouchGate();
    };

    const now = Date.now();
    if (intent === "demand") {
      if (hitGate.isRateLimited(now)) {
        deps.logger.debug("ui.char_hit_gated", "每分钟触摸上限已满，只记账");
        return;
      }
      if (hitGate.isCooling(now)) {
        const dueAt = hitGate.cooldownEndsAt(now);
        if (Number.isFinite(dueAt)) {
          queueDemand(message, message.count, dueAt);
          return;
        }
      }
    }

    if (intent === "demand" && (phase === "thinking" || phase === "speaking")) {
      // 正常 demand：会话已经结束，先取消旧轮再排这一下；intent 可能已提前取消，cancelAll 幂等
      void (async (): Promise<void> => {
        await deps.turn.cancelAll();
        schedule(Date.now());
      })();
      return;
    }
    schedule(now);
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

  ipcMain.handle(IPC_CHANNELS.usageStats, async (): Promise<UsageStats> =>
    deps.client.usageStats(),
  );

  ipcMain.handle(
    IPC_CHANNELS.usageSetRecording,
    async (_event, enabled: boolean): Promise<UsageStats> =>
      deps.client.setUsageRecording(enabled === true),
  );

  ipcMain.handle(IPC_CHANNELS.usageClear, async (): Promise<UsageStats> =>
    deps.client.clearUsage(),
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
      recordActivity(request.enabled ? "用户打开了开发者模式。" : "用户关闭了开发者模式。");
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
    IPC_CHANNELS.memorySummaries,
    async (_event, request: MemorySummariesRequest): Promise<MemorySummariesResponse> =>
      await deps.client.listSummaries(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryEditSummary,
    async (_event, request: MemorySummaryEditRequest): Promise<MemorySummaryItem | null> =>
      await deps.client.editSummary(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryDeleteSummary,
    async (_event, summaryId: number): Promise<boolean> =>
      await deps.client.deleteSummary(summaryId),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryEditMessage,
    async (_event, request: MemoryMessageEditRequest) => await deps.client.editMessage(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryDeleteMessage,
    async (_event, messageId: number): Promise<boolean> =>
      await deps.client.deleteMessage(messageId),
  );

  ipcMain.handle(
    IPC_CHANNELS.memoryContext,
    async (_event, request: MemoryContextRequest): Promise<MemoryContextResponse> =>
      await deps.client.memoryContext(request),
  );

  // 角色包编辑器（T2.3-D / T2.5 / T2.7）：选图走系统对话框、写盘走 pack-editor；渲染层全程只拿到 data URL。
  ipcMain.handle(IPC_CHANNELS.packOpenEditor, (_event, request?: PackOpenEditorRequest): void => {
    // 老调用方（无参）= 新建；edit / card 必须带合法 char_id，否则也按新建打开
    const charId = (request?.char_id ?? "").trim();
    const mode =
      (request?.mode === "edit" || request?.mode === "card") && charId !== ""
        ? request.mode
        : "create";
    recordActivity(
      "用户打开了角色包编辑器的" +
        (mode === "create" ? "新建" : mode === "card" ? "角色卡" : "部位") +
        "页面。",
    );
    deps.openPackEditor(mode === "create" ? { mode } : { mode, char_id: charId });
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
        broadcastCharactersChanged(result.char_id);
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

  // 编辑当前角色部位（T2.5）：读现有包 → 编辑器只改 hits.json；保存后广播让主窗重载 hits。
  ipcMain.handle(
    IPC_CHANNELS.packLoad,
    async (_event, request: PackLoadRequest): Promise<PackLoadResponse> =>
      await loadCharacterPack(deps.charactersDir, request.char_id),
  );

  ipcMain.handle(
    IPC_CHANNELS.packSaveRegions,
    async (_event, request: PackSaveRegionsRequest): Promise<PackSaveResponse> => {
      const result = await saveCharacterRegions(deps.charactersDir, request);
      if (result.ok) {
        deps.logger.info("ipc.pack_save_regions", "角色部位已保存", {
          char_id: result.char_id,
          files: result.files.length,
        });
        broadcastCharactersChanged(result.char_id);
      } else {
        deps.logger.warn("ipc.pack_save_regions_failed", "角色部位没存下", {
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

  // 角色卡（T2.7）：只改 card.json / pack.json 的人设与显示名，不动立绘 / 部位 / 音色
  ipcMain.handle(
    IPC_CHANNELS.packSaveCard,
    async (_event, request: PackSaveCardRequest): Promise<PackSaveResponse> => {
      const result = await saveCharacterCard(deps.charactersDir, request);
      if (result.ok) {
        deps.logger.info("ipc.pack_save_card", "角色卡已保存", {
          char_id: result.char_id,
          files: result.files.length,
        });
        broadcastCharactersChanged(result.char_id);
      } else {
        deps.logger.warn("ipc.pack_save_card_failed", "角色卡没存下", {
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
  ipcMain.handle(
    IPC_CHANNELS.packExport,
    async (event, request: PackExportRequest): Promise<PackExportResponse> => {
      const charId = request.char_id.trim();
      const loaded = await loadCharacterPack(deps.charactersDir, charId);
      if (!loaded.ok) {
        return {
          ok: false,
          canceled: false,
          char_id: charId,
          path: "",
          files: 0,
          error: loaded.error || "角色包无法读取",
        };
      }
      const parent = BrowserWindow.fromWebContents(event.sender);
      const safeName = (loaded.display_name || charId).replace(/[\\/:*?"<>|]/g, "_");
      const saveOptions = {
        title: "导出角色包",
        defaultPath: join(app.getPath("documents"), safeName + "-" + charId + ".zip"),
        filters: [{ name: "deskpet 角色包", extensions: ["zip"] }],
      };
      const picked =
        parent === null
          ? await dialog.showSaveDialog(saveOptions)
          : await dialog.showSaveDialog(parent, saveOptions);
      if (picked.canceled || picked.filePath === undefined) {
        return {
          ok: false,
          canceled: true,
          char_id: charId,
          path: "",
          files: 0,
          error: "",
        };
      }
      const result = await exportPackArchive(deps.charactersDir, charId, picked.filePath, {
        includeVoice: request.include_voice !== false,
        includeModel: request.include_model !== false,
      });
      deps.logger.info("ipc.pack_export", "角色包已导出", {
        char_id: charId,
        files: result.files,
        ok: result.ok,
      });
      return {
        ok: result.ok,
        canceled: false,
        char_id: result.charId,
        path: result.path,
        files: result.files,
        error: result.error,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.packImport,
    async (event, request: PackImportRequest): Promise<PackImportResponse> => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const dropped = request.path?.trim() ?? "";
      let file = dropped;
      if (dropped === "") {
        const openOptions: OpenDialogOptions = {
          title: "导入 deskpet 角色包",
          properties: ["openFile"],
          filters: [{ name: "deskpet 角色包", extensions: ["zip"] }],
        };
        const picked =
          parent === null
            ? await dialog.showOpenDialog(openOptions)
            : await dialog.showOpenDialog(parent, openOptions);
        file = picked.filePaths[0] ?? "";
        if (picked.canceled || file === "") {
          return {
            ok: false,
            canceled: true,
            char_id: "",
            display_name: "",
            renamed_from: "",
            warnings: [],
            error: "",
          };
        }
      } else if (!file.toLowerCase().endsWith(".zip")) {
        return {
          ok: false,
          canceled: false,
          char_id: "",
          display_name: "",
          renamed_from: "",
          warnings: [],
          error: "拖入的文件不是 zip 角色包",
        };
      }
      const preview: PackImportPreview = await inspectPackArchive(file);
      if (!preview.ok) {
        return {
          ok: false,
          canceled: false,
          char_id: "",
          display_name: "",
          renamed_from: "",
          warnings: [],
          error: preview.error,
        };
      }
      let overwrite = false;
      let targetExists = false;
      try {
        targetExists = (await stat(join(deps.charactersDir, preview.charId))).isDirectory();
      } catch {
        targetExists = false;
      }
      if (targetExists) {
        const warningText = preview.warnings.length > 0 ? "\n\n" + preview.warnings.join("\n") : "";
        const conflictOptions = {
          type: "question" as const,
          title: "角色 ID 已存在",
          message: `角色 ${preview.displayName}（${preview.charId}）已经存在。`,
          detail:
            "默认保留两者，会自动生成新的 char_id；选「覆盖原角色」只会替换角色包，旧记忆不会被删除。" +
            warningText,
          buttons: ["保留两者（默认）", "覆盖原角色", "取消"],
          defaultId: 0,
          cancelId: 2,
        };
        const choice =
          parent === null
            ? await dialog.showMessageBox(conflictOptions)
            : await dialog.showMessageBox(parent, conflictOptions);
        if (choice.response === 2) {
          await rm(preview.tempRoot, { recursive: true, force: true }).catch(() => undefined);
          return {
            ok: false,
            canceled: true,
            char_id: preview.charId,
            display_name: preview.displayName,
            renamed_from: "",
            warnings: preview.warnings,
            error: "",
          };
        }
        overwrite = choice.response === 1;
      }
      const result = await commitPackImport(
        preview,
        deps.charactersDir,
        {
          includeVoice: request.include_voice !== false,
          includeModel: request.include_model !== false,
        },
        overwrite,
      );
      if (result.ok) {
        broadcastCharactersChanged(result.charId);
        deps.logger.info("ipc.pack_import", "角色包已导入", {
          char_id: result.charId,
          renamed_from: result.renamedFrom,
          overwrite,
        });
      } else {
        deps.logger.warn("ipc.pack_import_failed", "角色包导入失败", {
          error: result.error,
        });
      }
      return {
        ok: result.ok,
        canceled: false,
        char_id: result.charId,
        display_name: result.displayName,
        renamed_from: result.renamedFrom,
        warnings: result.warnings,
        error: result.error,
      };
    },
  );

  const unsubscribe = deps.engine.onHealthChanged((view) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.healthChanged, view);
      }
    }
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
    ipcMain.removeHandler(IPC_CHANNELS.voiceMicStatus);
    ipcMain.removeHandler(IPC_CHANNELS.voiceOpenMicSettings);
    ipcMain.removeHandler(IPC_CHANNELS.voiceOpenSoundSettings);
    ipcMain.removeHandler(IPC_CHANNELS.voiceNativeStart);
    ipcMain.removeHandler(IPC_CHANNELS.voiceNativeStop);
    ipcMain.removeAllListeners(IPC_CHANNELS.voiceBegin);
    ipcMain.removeAllListeners(IPC_CHANNELS.voiceAudio);
    ipcMain.removeAllListeners(IPC_CHANNELS.voiceEnd);
    ipcMain.removeAllListeners(IPC_CHANNELS.voiceCancel);
    ipcMain.removeHandler(IPC_CHANNELS.uiGetState);
    ipcMain.removeHandler(IPC_CHANNELS.uiSetState);
    ipcMain.removeHandler(IPC_CHANNELS.settingsOpen);
    ipcMain.removeHandler(IPC_CHANNELS.charList);
    ipcMain.removeHandler(IPC_CHANNELS.charPortrait);
    ipcMain.removeHandler(IPC_CHANNELS.charHits);
    ipcMain.removeHandler(IPC_CHANNELS.charAppearance);
    ipcMain.removeHandler(IPC_CHANNELS.providersGet);
    ipcMain.removeHandler(IPC_CHANNELS.providersSet);
    ipcMain.removeHandler(IPC_CHANNELS.providersTest);
    ipcMain.removeHandler(IPC_CHANNELS.usageStats);
    ipcMain.removeHandler(IPC_CHANNELS.usageSetRecording);
    ipcMain.removeHandler(IPC_CHANNELS.usageClear);
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
    ipcMain.removeHandler(IPC_CHANNELS.packLoad);
    ipcMain.removeHandler(IPC_CHANNELS.packSaveRegions);
    ipcMain.removeHandler(IPC_CHANNELS.packSaveCard);
    ipcMain.removeHandler(IPC_CHANNELS.packExport);
    ipcMain.removeHandler(IPC_CHANNELS.packImport);
    ipcMain.removeHandler(IPC_CHANNELS.modelsList);
    ipcMain.removeHandler(IPC_CHANNELS.modelsInstall);
    ipcMain.removeHandler(IPC_CHANNELS.modelsRemove);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiPointer);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiMetrics);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiDrag);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiInputMode);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiTouchIntent);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiMinimize);
    ipcMain.removeAllListeners(IPC_CHANNELS.uiCharHit);
    unsubscribeTurn();
    clearTouchWaiting();
  };
}
