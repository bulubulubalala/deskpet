/**
 * 文件职责：触摸互动的三条通道（uiCharHit / uiTouchIntent / uiInputMode）与它们背后的闸门状态。
 *
 * 为什么单独一个文件：这里有一整套带定时器的可变状态——待发的这一下、冷却期的排队、
 * 提前 intent 的兜底计时器。它们只在触摸这条链路上被读写，跟其他通道没有交集；
 * 放一处才能保证注销时（窗口重建 / 引擎重启）把定时器一起清干净，不会留下回调打到旧窗口。
 * 依赖方向：ipc/* -> 本文件 -> char-hit-gate / touch-arbiter / turn-coordinator（经 deps）。
 */
import { randomUUID } from "node:crypto";

import {
  IPC_CHANNELS,
  type TouchGateState,
  type TouchIntentMessage,
  type TouchMessage,
  type UiInputModeMessage,
} from "../../shared/contracts/ipc";
import { CharHitGate, HIT_COOLDOWN_MS, HIT_RATE_MAX } from "../char-hit-gate";
import type { IpcRegistry } from "../ipc-registry";
import { classifyTouchIntent, mergeTouches, type TouchIntent } from "../touch-arbiter";
import type { IpcContext } from "./context";
import type { IpcHandlerDeps } from "./deps";

/**
 * 注册触摸相关通道。
 * @returns 注销函数：退订 phase 变化 + 清掉所有触摸定时器。
 */
export function registerTouchHandlers(
  registry: IpcRegistry,
  deps: IpcHandlerDeps,
  ctx: IpcContext,
): () => void {
  // 触摸（T2.3-C2c / T2.6）：闸门、提前 intent、冷却排队三类状态都放在这个闭包里，
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
    ctx.push(IPC_CHANNELS.uiTouchGate, state);
  };

  /** 冷却期排队上限：超过 10s 还没发出去就丢（用户早就忘了这一下）。 */
  const TOUCH_QUEUE_TTL_MS = 10_000;
  /** 提前 intent 后迟迟没有完整会话（手势被取消 / 模式切走）时，清掉待发标记。 */
  const TOUCH_INTENT_FALLBACK_MS = 2_500;

  /** 发起一轮互动回应：复用聊天链路，interaction 字段会变成本轮的用户消息（core/prompt.py）。 */
  const startInteractionTurn = async (message: TouchMessage, count: number): Promise<void> => {
    const charId = deps.ui.getState().char_id ?? "";
    if (charId === "") {
      return;
    }
    try {
      const session = deps.chatTurns.session;
      const response = await deps.chatTurns.send({
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

  // 输入模式（T2.6）：三选一。切走语音且正在听 -> 取消未提交的语音轮；切走触摸 -> 清排队。
  registry.on(IPC_CHANNELS.uiInputMode, (_event, message: UiInputModeMessage): void => {
    const previous = deps.turn.getMode();
    deps.turn.setMode(message.mode);
    if (previous !== message.mode) {
      const label = message.mode === "text" ? "文字" : message.mode === "voice" ? "语音" : "互动";
      ctx.recordActivity("用户切到了" + label + "模式。");
    }
    deps.logger.debug("ui.input_mode", "输入模式切换", {
      from: previous,
      to: message.mode,
    });
    pushTouchGate();
    if (previous === "voice" && message.mode !== "voice" && deps.turn.getPhase() === "listening") {
      void deps.turn.cancelAll();
    }
    if (message.mode !== "touch") {
      clearTouchWaiting();
    }
  });

  // demand 手势刚成立：只停播 + cancel，完整事实稍后仍走 uiCharHit（T2.6 两阶段）
  registry.on(IPC_CHANNELS.uiTouchIntent, (_event, message: TouchIntentMessage): void => {
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
      }, TOUCH_INTENT_FALLBACK_MS);
    })();
  });

  // 触摸（T2.3-C2c / T2.6）：渲染层只报事实（手势、摸过哪些部位、这一串几下、按了多久），
  // 记账每次都要；发起回应要先过意图分类与闸门。三模式互斥后，只有 touch 模式会走到这里。
  registry.on(IPC_CHANNELS.uiCharHit, (_event, message: TouchMessage): void => {
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

  return () => {
    unsubscribeTurn();
    clearTouchWaiting();
  };
}
