/**
 * 文件职责：桌宠主窗渲染层——立绘 + 聊天条，把主进程推来的状态画上去（F11 / §6.11）。
 *
 * 为什么没有标题栏与状态面板：F11 规定桌面只有人和一条输入栏，模块健康收成聊天条旁的小圆点；
 * 端口 / pid / 模块明细都搬进设置窗，这里只负责「能聊天、能打断、能换角色、能开设置」。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 * 写入一律用 textContent / createElement，不用 innerHTML（注入防线，需求 §7.4）。
 */
import type { HealthView } from "../shared/contracts/ipc";
import type {
  CharacterSummary,
  ChatEventEnvelope,
  ErrorDetail,
  TouchGateState,
  TouchGesture,
  TouchRegion,
  UiGestureSettings,
  UiInputMode,
  UiStatePayload,
  VoiceStreamEvent,
} from "../shared/contracts/ipc";
import { UI_FPS_DEFAULT } from "../shared/defaults";
import type { DeskpetApi } from "../preload/api";
import { ASR_SAMPLE_RATE } from "./audio-codec";
import { bannerAction, renderEngineGuide, renderSetupGuide, showBanner } from "./banner";
import { CharacterMenu } from "./character-menu";
import { ChatStream } from "./chat-stream";
import { byId, mustById } from "./dom";
import { buildErrorReport } from "./error-report";
import { ExpressionHold } from "./expression-hold";
import { nextIdleDelay, pickIdleAct } from "./idle-composer";
import { createStage, type StageAdapter, type StageHost } from "./stage";
import { StageEffects } from "./stage-fx";
import { TOUCH_STROKE_MIN_PX, TouchTracker, isGestureEnabled } from "./touch";
import { classifyZone, reactionFor } from "./touch-reaction";
import { VoiceEngine } from "./voice-engine";
import { initVoiceWave, updateVoiceWave } from "./voice-wave";

declare global {
  interface Window {
    readonly deskpet: DeskpetApi;
  }
}

/** 心跳灯颜色只由状态决定：绿 = 在线，黄 = 正在启动，红 = 现在不在线（离线 / 重启中 / 失败）。 */
const HEALTH_TITLES: Record<HealthView["state"], string> = {
  starting: "后台引擎：正在启动",
  online: "后台引擎：在线",
  offline: "后台引擎：离线（等待自动重启）",
  restarting: "后台引擎：正在重启",
  failed: "后台引擎：启动失败（已达到自动重启上限）",
};

const VOICE_LABELS: Record<string, string> = {
  idle: "空闲",
  listening: "在听",
  thinking: "在想",
  speaking: "在说",
  cancelling: "打断中",
};

/** 输入框自动换行的高度区间（F11：输入框随内容变高，聊天条跟着变高，窗口再跟着变）。 */
const CHAT_INPUT_MIN_HEIGHT = 40;
const CHAT_INPUT_MAX_HEIGHT = 120;

/**
 * 思考中气泡：发出去到第一句台词回来之间，气泡里只循环 1→2→3 个「·」（T2.2 真机反馈）。
 *
 * 为什么不写「正在思考…」这类字：那是假台词，用户会当成角色真在说话；而且冒烟脚本用气泡
 * 文字判「首句实义」，占位文字必须能和真台词区分（scripts/lib/cdp.mjs: REPLY_BUBBLE）。
 */
const THINKING_DOTS = ["·", "··", "···"] as const;
const THINKING_TICK_MS = 400;

const api = window.deskpet;

/**
 * 形象舞台与主进程的桥（T2.4）：素材怎么读、尺寸变了通知谁，一次注入给 Stage 抽象层。
 *
 * 舞台本身不 import window.deskpet，便于单测与复用；这里把 IPC 调用包成它要的回调。
 */
const stageHost: StageHost = {
  portrait: async (charId) => (await api.characters.portrait({ char_id: charId })).data_url,
  hits: async (charId) => await api.characters.hits({ char_id: charId }),
  appearance: async (charId) => (await api.characters.appearance({ char_id: charId })).appearance,
  onSizeChanged: () => reportMetrics(),
};

let sessionId = "";
let activeCharId: string | null = null;
let activeCharName = "角色";
/** 角色 id → 显示名；拖动把手上的名字随角色切换更新（F11：窗口没有标题栏）。 */
const characterNames = new Map<string, string>();
let turnActive = false;
let voiceStateName = "idle";
/** 输入模式（T2.6）：文字 / 语音 / 互动三选一；默认文字，不记忆上次。 */
let inputMode: UiInputMode = "text";
/** 当前是否有一句语音正在说（speech_start 到 utterance 结束）：切模式时据此取消未提交的语音轮。 */
let voiceUtteranceActive = false;
/** 文字输入行最近的高度：切到语音 / 互动时用同高提示区替换，避免窗口跳动。 */
let lastTextPanelHeight = CHAT_INPUT_MIN_HEIGHT;
/** 语音输出开关（麦克风旁）：关掉只显示文字，不播 TTS。 */
let ttsEnabled = true;
let companionEnabled = true;
/** 当前窗口层级：true = 置顶（在所有应用上显示），false = 只在桌面显示（普通层）。 */
let alwaysOnTop = true;
let pointerInside = false;
/**
 * 是否正在拖动窗口（T2.2 用户反馈第五轮）。
 *
 * 为什么不用 -webkit-app-region：那是浏览器侧的窗口拖动，CDP 合成鼠标事件验证不到，而且只能
 * 盖在画出来的像素上；现在只报「按下 / 松开」两个时刻，位移由主进程读系统光标算（见 ui-controller）。
 */
let dragging = false;
/** 拖动中指针短暂出窗的宽限；非空表示正在等窗口追上来。 */
let leaveTimer: number | null = null;
/** 拖动中指针出窗后多久仍没回来就认定松手丢了（毫秒）。 */
const DRAG_LEAVE_GRACE_MS = 300;

/** 互动模式（T2.3-C2c）：默认关，用户在聊天条按「互动」或在立绘上滑动才打开。 */
let interactMode = false;
/** 手势开关：设置窗「手势」菜单写进 data/ui.json，主进程启动与变更时推给这里。 */
let gestureSettings: UiGestureSettings = {
  triggers: ["button"],
  enabled: ["tap", "stroke", "hold", "knead", "pat"],
};
/** 每 250ms 收一次静默的触摸串（与 touch.ts 的会话聚合一拍）。 */
const TOUCH_FLUSH_MS = 250;
/** 触摸轨迹聚合器：把连点 / 揉 / 拍合成「一串」，再交给主进程（方案 §4.3）。 */
const touchTracker = new TouchTracker();
/** 主进程推来的互动闸门快照 + 本地倒计时终点。 */
let touchGateState: TouchGateState | null = null;
let touchCooldownUntil = 0;
/** 一次按下到松开的现场；tracked 为假表示这次按下还没被当成触摸。 */
let touchStart: { x: number; y: number; at: number; tracked: boolean } | null = null;
/** 触摸反馈层（涟漪 / 轨迹）：与舞台同生命周期，PNG 与 Live2D 共用（T2.41）。 */
let stageFx: StageEffects | null = null;
/** 本地触摸表情的短持有：模型情绪到达时让位。 */
let localExpression: ExpressionHold | null = null;
/** 本次按下的累计位移：到 stroke 阈值才开始画轨迹（与 touch.ts 同一条线）。 */
let touchTravel = 0;
/** 上一个指针位置：只用来累加位移，按下点另存（tap 判定要用）。 */
let touchLastPoint: { x: number; y: number } | null = null;
/** 这次按下是否已经开始画轨迹。 */
let trailActive = false;
/** 待机编排的定时器。 */
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** 光标出窗后还保持注意的时间（毫秒）：太快回正会显得没在看人（T2.41）。 */
const GLANCE_HOLD_MS = 1500;
/** 当前形象舞台（PNG / Live2D 由 Stage 抽象层决定，T2.4）；换角色时整体重建。 */
let stage: StageAdapter | null = null;
/** 渲染帧率上限（T2.43）：设置窗改、舞台建好后应用；PNG 舞台忽略它。 */
let stageFps: number = UI_FPS_DEFAULT;
/** 立绘加载代次：只允许最后一次切换提交，避免快速切角色时多张图叠在舞台上 */
let stageLoadToken = 0;
/** 音频设备层：采集与播放共用，第一次真正用到时才建（T2.4 / T1.12b）。 */
let voiceEngine: VoiceEngine | null = null;
/** 原生 WDM-KS 会独占麦克风：窗口失焦时暂停，回到窗口再恢复。 */
let nativeSuspended = false;
/** 兼容模式：默认关；只有设置窗显式打开才允许 Chromium 失败后走 WDM-KS。 */
let nativeFallbackEnabled = false;
/** 窗口是否在前台；避免“刚点语音就切走”时 helper 仍把麦克风占住。 */
let windowFocused = true;

/** 这些控件要真正点击 / 输入，按在它们身上不拖窗口；其余位置（立绘、聊天条边框）都能拖。 */
const DRAG_EXCLUDE = "button, input, textarea, select, a, .popup, .chat-stream";
/** 这一轮是否已经收到过真台词——防止迟到的思考气泡把先到的那句盖掉（T2.2）。 */
let turnSentenceSeen = false;

/** 最近一次带详情的错误：互动模式下聊天记录被隐藏，靠角色旁的警示按钮把它再打开。 */
let lastErrorDetail: ErrorDetail | null = null;
let lastErrorHint = "";
let lastErrorCode = "";
let lastErrorSeen = true;
let errorCopyStatusTimer: number | null = null;

/** 微信式聊天记录（T2.27）：用户右侧、角色左侧；最新一条仍带 #bubble，冒烟脚本兼容。 */
const chatStream = new ChatStream(mustById("chat-stream"), mustById("chat-stream-list"), {
  onShowErrorDetail: (detail, hint, code) => {
    openErrorDetail(detail, hint, code);
  },
  onChanged: () => {
    updateScrollHint();
  },
});

/** 角色菜单（T2.7）：谁被选中、菜单里有哪些编辑入口，都由它自己回答。 */
const characterMenu = new CharacterMenu({
  api,
  getActiveId: () => activeCharId,
  getActiveName: () => activeCharName,
  onSelect: (character) => {
    void selectCharacter(character);
  },
  onOpen: () => setWindowPopupOpen(false),
});

/**
 * 思考中气泡（T2.2 真机需求）：发出去之后、第一句台词回来之前，让用户看见「在想」。
 *
 * 为什么不是 showBubble 的一种：这是占位、不是台词——不能进对话记录，也不能被当成角色的回答；
 * 换台词 / 报错 / 打断 / 一轮结束都要立刻收掉（showBubble 与 renderVoiceState 各兜一次）。
 * 文字用 setInterval 真的在 1→2→3 之间变，不用 CSS 动画：内容要能被冒烟脚本读到。
 */
function startThinkingBubble(): void {
  if (turnSentenceSeen) {
    return;
  }
  chatStream.showThinking(activeCharName, THINKING_DOTS, THINKING_TICK_MS);
}

/** 收掉思考气泡：换台词、报错、打断、一轮结束都调；真实消息会自己接管位置。 */
function stopThinkingBubble(): void {
  chatStream.stopThinking();
}

/** 台词 / 系统提示：角色进左侧气泡，技术错误进系统错误气泡（§6.7）。 */
function showBubble(
  speaker: string,
  text: string,
  isError: boolean,
  extra: { detail?: ErrorDetail; code?: string } = {},
): void {
  if (speaker === "系统") {
    if (isError && extra.detail !== undefined) {
      rememberError(extra.detail, text, extra.code ?? "");
    }
    // 普通系统消息（麦克风切换等）8 秒后淡出；技术错误保留到下一轮，便于回看原因
    chatStream.appendSystem(text, {
      error: isError,
      transient: !isError,
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
      ...(extra.code === undefined ? {} : { code: extra.code }),
    });
    return;
  }
  chatStream.appendAssistant(text, speaker);
}

/** 记住最近一次带详情的错误：互动模式下聊天记录看不见，警示按钮要靠它。 */
function rememberError(detail: ErrorDetail, hint: string, code: string): void {
  lastErrorDetail = detail;
  lastErrorHint = hint;
  lastErrorCode = code;
  lastErrorSeen = false;
  updateErrorBadge();
}

function updateErrorBadge(): void {
  const badge = byId("error-badge");
  if (badge instanceof HTMLButtonElement) {
    badge.hidden = !(inputMode === "touch" && lastErrorDetail !== null && !lastErrorSeen);
  }
}

let currentErrorDetail: ErrorDetail | null = null;
let currentErrorHint = "";
let currentErrorCode = "";

function setDetailText(id: string, value: string): void {
  const node = byId(id);
  if (node !== null) {
    node.textContent = value === "" ? "—" : value;
  }
}

/** 打开错误详情弹窗；聊天记录的「详情」与互动模式的警示按钮共用它。 */
function openErrorDetail(detail: ErrorDetail, hint: string, code: string): void {
  const dialog = byId("error-detail-dialog");
  if (!(dialog instanceof HTMLDialogElement)) {
    return;
  }
  currentErrorDetail = detail;
  currentErrorHint = hint;
  currentErrorCode = code;
  lastErrorSeen = true;
  updateErrorBadge();

  setDetailText("error-detail-code", code);
  setDetailText("error-detail-hint", hint);
  setDetailText(
    "error-detail-status",
    detail.status === null || detail.status === undefined ? "" : String(detail.status),
  );
  setDetailText("error-detail-endpoint", detail.endpoint ?? "");
  setDetailText("error-detail-model", detail.model ?? "");
  setDetailText("error-detail-request", detail.request_id ?? "");
  setDetailText(
    "error-detail-attempts",
    detail.attempts === undefined || detail.attempts <= 0 ? "" : String(detail.attempts),
  );
  setDetailText("error-detail-message", detail.message ?? "");
  setDetailText("error-detail-body", detail.body ?? "");
  const status = byId("error-detail-copy-status");
  if (status !== null) {
    status.textContent = "";
  }
  if (!dialog.open) {
    dialog.showModal();
  }
}

function closeErrorDetail(): void {
  const dialog = byId("error-detail-dialog");
  if (dialog instanceof HTMLDialogElement && dialog.open) {
    dialog.close();
  }
}

/** 复制当前错误详情：版本从主进程取，内容只含这一次错误，不带日志。 */
async function copyErrorDetail(): Promise<void> {
  const detail = currentErrorDetail;
  if (detail === null) {
    return;
  }
  const status = byId("error-detail-copy-status");
  if (status !== null) {
    status.textContent = "正在复制…";
  }
  try {
    const [info, health] = await Promise.all([
      api.app.getInfo(),
      api.health.get().catch(() => null),
    ]);
    const report = buildErrorReport({
      at: new Date().toISOString(),
      appVersion: info.app_version,
      engineVersion: health?.version ?? "",
      code: currentErrorCode,
      hint: currentErrorHint,
      detail,
    });
    await api.app.copyText(report);
    if (status !== null) {
      status.textContent = "已复制";
    }
  } catch (error: unknown) {
    if (status !== null) {
      status.textContent = "复制失败：" + String(error);
    }
  }
  if (errorCopyStatusTimer !== null) {
    window.clearTimeout(errorCopyStatusTimer);
  }
  errorCopyStatusTimer = window.setTimeout(() => {
    errorCopyStatusTimer = null;
    if (status !== null) {
      status.textContent = "";
    }
  }, 2500);
}

/** 绑定错误弹窗的关闭 / 复制 / 遮罩点击，以及互动模式警示按钮。 */
function bindErrorDetail(): void {
  byId("error-detail-close")?.addEventListener("click", closeErrorDetail);
  byId("error-detail-copy")?.addEventListener("click", () => {
    void copyErrorDetail();
  });
  byId("error-badge")?.addEventListener("click", () => {
    if (lastErrorDetail !== null) {
      openErrorDetail(lastErrorDetail, lastErrorHint, lastErrorCode);
    }
  });
  const dialog = byId("error-detail-dialog");
  if (dialog instanceof HTMLDialogElement) {
    dialog.addEventListener("click", (event) => {
      // 点在 dialog 本体（而不是内容）上才算点遮罩
      if (event.target === dialog) {
        dialog.close();
      }
    });
  }
  updateErrorBadge();
}

/** 聊天记录滚离底部时露出「最新」；没有溢出或已经在底部就收起来。 */
function updateScrollHint(): void {
  const root = byId("chat-stream");
  const button = byId("chat-scroll-latest");
  if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    return;
  }
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight <= 48;
  button.hidden = root.hidden || root.scrollHeight <= root.clientHeight + 4 || nearBottom;
}

function bindChatScroll(): void {
  const root = byId("chat-stream");
  const button = byId("chat-scroll-latest");
  if (root !== null) {
    root.addEventListener("scroll", updateScrollHint, { passive: true });
  }
  button?.addEventListener("click", () => {
    chatStream.scrollToLatest();
    button.hidden = true;
  });
  updateScrollHint();
}

function setTurnActive(active: boolean): void {
  turnActive = active;
  const button = byId("interrupt-button");
  if (button instanceof HTMLButtonElement) {
    button.disabled = !active;
    button.title = active ? "打断当前回复" : "当前没有可打断的回复（空闲时不可点）";
    button.setAttribute("aria-label", active ? "打断当前回复" : "当前没有可打断的回复");
  }
}

/** 把三种输入模式画到聊天条：高亮当前按钮，文字输入行与提示区二选一。 */
function renderInputMode(): void {
  for (const mode of ["text", "voice", "touch"] as const) {
    const button = byId("mode-" + mode);
    if (button !== null) {
      const active = inputMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }
  document.body.dataset.inputMode = inputMode;
  const textRow = byId("text-input-row");
  const hint = byId("mode-hint");
  const panel = byId("mode-panel");
  if (textRow !== null) {
    textRow.hidden = inputMode !== "text";
  }
  const wave = byId("voice-wave");
  if (wave !== null) {
    wave.hidden = inputMode !== "voice";
  }
  updateTouchMeter();
  if (hint !== null) {
    hint.hidden = inputMode === "text";
    if (inputMode === "voice") {
      hint.textContent = voiceEngine?.listening
        ? "语音模式：正在听…说完自动发送"
        : nativeSuspended
          ? "语音模式：已暂停（回到窗口继续）"
          : "语音模式：直接说话；切走会停止收音";
    } else if (inputMode === "touch") {
      hint.textContent =
        stage !== null && !stage.hasRegions()
          ? "这个角色还没有部位框：去角色包编辑器补上；现在点 / 摸仍可用，但不区分部位。"
          : "互动模式：在立绘上点、摸、按住";
    } else {
      hint.textContent = "";
    }
  }
  if (panel !== null) {
    if (inputMode === "text") {
      panel.style.height = "";
    } else {
      panel.style.height = lastTextPanelHeight + "px";
    }
  }
  updateErrorBadge();
  updateScrollHint();
}

function updateTouchMeter(): void {
  const meter = byId("touch-meter");
  if (meter === null) {
    return;
  }
  meter.hidden = inputMode !== "touch";
  if (meter.hidden || touchGateState === null) {
    return;
  }
  const total = Math.max(1, touchGateState.cooldown_total_ms);
  const remaining = Math.max(0, touchCooldownUntil - Date.now());
  const fill = byId("touch-cooldown-fill");
  if (fill !== null) {
    fill.style.transform = "scaleX(" + (remaining > 0 ? remaining / total : 1).toFixed(3) + ")";
    fill.style.background = remaining > 0 ? "" : "var(--ok)";
  }
  const label = byId("touch-quota-label");
  if (label !== null) {
    label.textContent =
      touchGateState.rate_remaining <= 0
        ? "本分钟已用完"
        : "可回应 " +
          String(touchGateState.rate_remaining) +
          " / " +
          String(touchGateState.rate_max);
  }
  const dots = byId("touch-quota-dots");
  if (dots !== null && dots.childElementCount !== touchGateState.rate_max) {
    dots.replaceChildren();
    for (let i = 0; i < touchGateState.rate_max; i += 1) {
      dots.append(document.createElement("span"));
    }
  }
  if (dots !== null) {
    for (let i = 0; i < dots.children.length; i += 1) {
      dots.children[i]?.classList.toggle("filled", i < touchGateState.rate_remaining);
    }
  }
}

function renderTouchGate(state: TouchGateState): void {
  touchGateState = state;
  touchCooldownUntil = Date.now() + state.cooldown_remaining_ms;
  updateTouchMeter();
}

/**
 * 切换输入模式（T2.6）：只停旧模式的输入采集，不打断已提交的回复。
 *
 * - 语音 -> 别的：stopCapture()（不停播）；如果这句还没说完，voice.cancel() 取消未提交的语音轮；
 * - 互动 -> 别的：关触摸并清掉还没结算的手势；
 * - 进入语音：自动开麦；权限失败退回文字；
 * - 进入互动：打开触摸；进入文字：聚焦输入框（草稿保留）。
 */
function setInputMode(mode: UiInputMode): void {
  if (inputMode === mode) {
    if (mode === "text") {
      const input = byId("chat-input");
      if (input instanceof HTMLTextAreaElement) {
        input.focus();
      }
    }
    return;
  }
  const previous = inputMode;
  const panel = byId("mode-panel");
  if (panel !== null) {
    lastTextPanelHeight = Math.max(CHAT_INPUT_MIN_HEIGHT, panel.offsetHeight);
  }
  if (previous === "voice") {
    if (voiceUtteranceActive) {
      voiceUtteranceActive = false;
      api.voice.cancel();
    }
    voiceEngine?.stopCapture();
  }
  if (previous === "touch") {
    setInteractMode(false);
  }

  inputMode = mode;
  if (mode !== "voice") {
    nativeSuspended = false;
  }
  api.ui.setInputMode({ mode });
  renderInputMode();

  if (mode === "voice") {
    const engine = ensureVoiceEngine();
    engine.unlockAudio();
    void engine
      .start()
      .then(() => {
        if (inputMode !== "voice") {
          engine.stopCapture();
          return;
        }
        if (!engine.listening) {
          // start() 内部已经通过 onError 给出原因；这里把模式退回文字，避免停在「语音模式但没麦」
          setInputMode("text");
          return;
        }
        renderInputMode();
      })
      .catch((error: unknown) => {
        if (inputMode !== "voice") {
          return;
        }
        showBubble("系统", "麦克风打不开：" + String(error), true);
        setInputMode("text");
      });
  } else if (mode === "touch") {
    setInteractMode(true);
    if (stage !== null && !stage.hasRegions()) {
      showBubble(
        "系统",
        "这个角色还没有部位框：点 / 摸仍可用，但不会区分身体部位。去角色包编辑器补上后，互动会更准确。",
        true,
      );
    }
  } else {
    const input = byId("chat-input");
    if (input instanceof HTMLTextAreaElement) {
      input.focus();
      autoGrowInput();
    }
  }
  reportMetrics();
}

function renderHealth(view: HealthView): void {
  const dot = byId("health-dot");
  if (dot !== null) {
    dot.className = "health-dot " + view.state;
    dot.title = HEALTH_TITLES[view.state];
  }
  renderEngineGuide(view);
  renderSetupGuide(view);
}

function renderVoiceState(state: string, detail?: string): void {
  const node = byId("voice-state");
  if (node !== null) {
    node.textContent = VOICE_LABELS[state] ?? state;
    node.title = detail ?? VOICE_LABELS[state] ?? state;
  }
  // 状态点颜色 / 呼吸动画由 CSS 按 data-state 决定
  const status = byId("chat-status");
  if (status !== null) {
    status.dataset["state"] = state;
  }
  const wasIdle = voiceStateName === "idle";
  const wasThinking = voiceStateName === "thinking";
  voiceStateName = state;
  // 主进程自己起的一轮（主动陪伴 / 部位回应）也要按新轮处理：重置首句标记并新建气泡
  if (state === "thinking" && !wasThinking) {
    turnSentenceSeen = false;
  }
  // 打断：立刻停播放队列（T2.6 文字 / demand 触摸抢话筒时也会走 cancelling）
  if (state === "cancelling") {
    voiceEngine?.interrupt();
  }
  // 打断或一轮结束：思考气泡还没等到台词就直接收掉（T2.2 真机需求）
  if (!wasIdle && (state === "cancelling" || state === "idle")) {
    stopThinkingBubble();
    chatStream.setStreaming(false);
  }
  // 主进程取消旧轮再起新轮时，中间会有一帧 idle；新轮进入 thinking 时把占位气泡补回来
  if (state === "thinking" && !turnSentenceSeen) {
    startThinkingBubble();
  }
  // 一轮真正结束以「主进程说空闲」为准，而不是流结束：合成收尾期间主进程仍会拒绝新的一句，
  // 界面若提前把打断按钮灰掉，用户按 Enter 只会收到「上一轮还没说完」（T1.13a 冒烟发现的问题）。
  // 主进程也能自己起一轮（部位点击 T2.3-C2b）：只要不是空闲，界面就算「在忙」；
  // 否则用户在这期间按 Enter 只会被主进程拒掉（「上一轮还没说完」）。
  if (state !== "idle" && !turnActive) {
    setTurnActive(true);
  }
  if (state === "idle" && !wasIdle) {
    voiceUtteranceActive = false;
    setTurnActive(false);
    // 被打断 / 异常收尾时也要把 partial 清掉，避免残留上一句的识别文字
    clearVoicePartial();
  }
}

/**
 * 换角色：重建形象舞台（T2.4）。
 *
 * 立绘 / 部位 / appearance 都由主进程读好，Stage 抽象层按 appearance.stage 决定用 PNG 还是
 * Live2D（M3）；没有可用角色时 stage 保持 null，触摸与尺寸上报都会安全跳过。
 */
async function loadCharacterArt(charId: string): Promise<void> {
  const token = ++stageLoadToken;
  stage?.destroy();
  stage = null;
  // 换舞台期间先停追踪：旧 Live2D 已经拆掉，新舞台建好后再按类型打开（T2.27）
  api.ui.setCursorTracking(false);
  const mount = byId("stage-mount");
  if (mount === null) {
    return;
  }
  mount.replaceChildren();
  const next = await createStage(stageHost, mount, charId);
  if (token !== stageLoadToken || activeCharId !== charId) {
    next.destroy();
    return;
  }
  stage = next;
  stage.setMaxFps(stageFps);
  // 触摸反馈层跟着舞台重建：PNG 与 Live2D 共用同一块 overlay（T2.41）
  stageFx?.destroy();
  stageFx = StageEffects.attach(mount);
  localExpression?.dispose();
  localExpression = new ExpressionHold((tag, intensity) => stage?.setExpression(tag, intensity));
  resetTouchFx();
  scheduleIdle();
  api.ui.setCursorTracking(next.kind === "live2d");
  reportMetrics();
  renderInputMode();
}

/**
 * 互动模式下按下：必须落在立绘矩形里、且不在按钮 / 输入框上（T2.3-C2c）。
 *
 * 判定只看按下位置；这一下到底算点 / 摸 / 揉 / 拍由 TouchTracker 按轨迹与时间算。
 */
function beginTouch(event: MouseEvent): void {
  touchStart = null;
  if (event.button !== 0) {
    return;
  }
  const target = event.target;
  if (target instanceof Element && target.closest(DRAG_EXCLUDE) !== null) {
    return;
  }
  if (stage === null || !stage.containsPoint(event.clientX, event.clientY)) {
    return;
  }
  const at = Date.now();
  touchStart = { x: event.clientX, y: event.clientY, at, tracked: false };
  touchTravel = 0;
  touchLastPoint = { x: event.clientX, y: event.clientY };
  if (interactMode) {
    startTouchTracking(event.clientX, event.clientY, at);
  }
}

/** 把当前舞台当作坐标换算来源；没有舞台时报 null（不碰还没加载出来的立绘）。 */
function stageRegionAt(clientX: number, clientY: number): TouchRegion | null {
  return stage?.regionAt(clientX, clientY) ?? null;
}

/** 记下这一串轨迹的起点；之后 move / up 都往同一个 TouchTracker 里塞。 */
function startTouchTracking(x: number, y: number, at: number): void {
  touchTracker.down(x, y, at, stageRegionAt(x, y));
  touchTravel = 0;
  touchLastPoint = { x, y };
  trailActive = false;
  stageFx?.endTrail();
  if (touchStart !== null) {
    touchStart.tracked = true;
  }
}

/** 拖动轨迹：互动模式关着时，按住后在立绘上滑够距离也算「到处摸」（设置里的 triggers）。 */
function moveTouch(event: MouseEvent): void {
  const start = touchStart;
  if (start === null || !start.tracked) {
    return;
  }
  touchTracker.move(
    event.clientX,
    event.clientY,
    Date.now(),
    stageRegionAt(event.clientX, event.clientY),
  );
  trackTrail(event.clientX, event.clientY);
}

/** 累计位移够一键的距离后开始画轨迹（摸 / 揉）；点与按住不画线（T2.41）。 */
function trackTrail(clientX: number, clientY: number): void {
  const last = touchLastPoint;
  touchLastPoint = { x: clientX, y: clientY };
  if (last === null || stage === null) {
    return;
  }
  if (!stage.containsPoint(clientX, clientY)) {
    // 划出立绘就收笔：不然线会画到聊天条上
    if (trailActive) {
      trailActive = false;
      stageFx?.endTrail();
    }
    return;
  }
  touchTravel += Math.hypot(clientX - last.x, clientY - last.y);
  if (!trailActive) {
    if (touchTravel < TOUCH_STROKE_MIN_PX) {
      return;
    }
    const region = stageRegionAt(clientX, clientY);
    stageFx?.beginTrail(region === null ? null : stage.regionColor(region.id));
    trailActive = true;
  }
  stageFx?.pushTrail(clientX, clientY);
}

/** 松手后的本地即时反应：身体先动一下，台词反应随后覆盖（T2.41）。 */
function reactToTouch(gesture: TouchGesture | null, region: TouchRegion | null): void {
  if (gesture === null) {
    return;
  }
  const reaction = reactionFor(gesture, classifyZone(region?.id, region?.name));
  if (reaction.expression !== null) {
    localExpression?.hold(reaction.expression, reaction.expressionMs);
  }
  if (reaction.motion !== null) {
    stage?.playAct(reaction.motion);
  }
  for (const bone of reaction.bones) {
    stage?.nudgeBone(bone.id, bone.value, bone.ms);
  }
}

/** 换角色 / 关互动：把没画完的特效与位移累计清掉。 */
function resetTouchFx(): void {
  stageFx?.clear();
  touchTravel = 0;
  touchLastPoint = null;
  trailActive = false;
}

/** 待机编排：静默 8–25s 随机动一下；正在说话 / 互动中不插嘴（T2.41）。 */
function scheduleIdle(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!turnActive && !interactMode) {
      stage?.playAct(pickIdleAct(Math.random));
    }
    scheduleIdle();
  }, nextIdleDelay(Math.random));
}

/** 松手：不立刻发消息（一串动作要等静默），只给一下视觉反馈。 */
function endTouch(event: MouseEvent): void {
  const start = touchStart;
  touchStart = null;
  if (start === null || !start.tracked) {
    return;
  }
  touchTracker.up(
    event.clientX,
    event.clientY,
    Date.now(),
    stageRegionAt(event.clientX, event.clientY),
  );
  const gesture = touchTracker.lastGesture;
  const region = stageRegionAt(event.clientX, event.clientY);
  const color = region === null ? null : (stage?.regionColor(region.id) ?? null);
  stageFx?.endTrail();
  if (gesture === "tap" || gesture === "pat") {
    // 全画布缩放（原来的 pulse）降级成触点涟漪：动的是光，不是整张立绘（T2.41）
    stageFx?.ripple(event.clientX, event.clientY, color);
  }
  reactToTouch(gesture, region);
  touchLastPoint = null;
}

/**
 * 每 250ms 收一次静默的触摸串：够静了就发出去（设置里禁掉的手势直接丢）。
 *
 * 为什么不松手就发：连点 / 揉 / 拍要合成「一串」再交给模型，否则一次揉会被拆成几十下点击。
 */
function flushTouches(): void {
  if (inputMode !== "touch") {
    return;
  }
  updateTouchMeter();
  const now = Date.now();
  // T2.6 两阶段：手势一成立就先报 demand，让主进程立刻停播；完整事实等会话结束再发。
  const intent = touchTracker.liveIntent(now);
  if (intent !== null && isGestureEnabled(gestureSettings.enabled, intent)) {
    api.ui.touchIntent({ gesture: intent });
  }
  const message = touchTracker.closeIfIdle(now);
  if (message === null) {
    return;
  }
  if (!isGestureEnabled(gestureSettings.enabled, message.gesture)) {
    return;
  }
  api.ui.touch(message);
}

/** 开关触摸：立绘光标变抓取；关掉时把还没结算的那串丢掉（模式按钮负责高亮）。 */
function setInteractMode(on: boolean): void {
  if (interactMode === on) {
    return;
  }
  interactMode = on;
  touchTracker.reset();
  touchStart = null;
  document.body.classList.toggle("interacting", on);
  if (!on) {
    endDrag();
    resetTouchFx();
  }
}

async function selectCharacter(character: CharacterSummary): Promise<void> {
  activeCharId = character.char_id;
  activeCharName = character.display_name;
  renderGrip(character.display_name);
  characterMenu.markCurrent();
  characterMenu.hide();
  // 会话内聊天记录属于当前角色：换人就淡出清空（T2.27）
  chatStream.clear();
  await api.ui.setState({ char_id: character.char_id });
  touchTracker.reset();
  await loadCharacterArt(character.char_id);
  chatStream.appendSystem("已切换到 " + character.display_name, { transient: true });
}

/**
 * 窗口显示方式菜单：「只在桌面显示 / 在所有应用上显示 / 隐藏窗口」。
 *
 * 前两项就是 data/ui.json 的 always_on_top（普通层 vs 置顶），第三项走既有的最小化到托盘。
 * 做成菜单而不是三个并排按钮：聊天条本来就挤，而且这三项是互斥的状态选择。
 */
function renderWindowPopup(): void {
  byId("window-desktop")?.classList.toggle("current", !alwaysOnTop);
  byId("window-top")?.classList.toggle("current", alwaysOnTop);
  const button = byId("window-button");
  if (button !== null) {
    button.title = alwaysOnTop ? "窗口：在所有应用上显示" : "窗口：只在桌面显示";
  }
}

function setWindowPopupOpen(open: boolean): void {
  const popup = byId("window-popup");
  if (popup !== null) {
    popup.hidden = !open;
  }
  if (open) {
    // 两个弹层互斥：同时开着会互相遮挡，也分不清点的是哪一个
    characterMenu.hide();
  }
}

/** Chromium 的 WASAPI 采集失败时，切到 sidecar 的 Windows 原生采集。 */
async function startNativeVoice(hint: string, announce = true): Promise<void> {
  const engine = voiceEngine;
  if (engine === null || inputMode !== "voice") {
    return;
  }
  try {
    const result = await api.voice.startNative();
    if (!result.ok) {
      showBubble("系统", "原生麦克风也打不开：" + (result.error || hint), true);
      return;
    }
    if (inputMode !== "voice" || !windowFocused) {
      await api.voice.stopNative();
      return;
    }
    engine.beginNativeCapture();
    if (announce) {
      showBubble("系统", "Chromium 麦克风不可用，已切换到 Windows 原生采集。", false);
    }
  } catch (error: unknown) {
    showBubble("系统", "原生麦克风也打不开：" + String(error), true);
  }
}

/** 切到微信等应用时释放 WDM-KS 独占麦克风；回到 deskpet 再恢复。 */
function suspendNativeOnBlur(): void {
  windowFocused = false;
  if (inputMode !== "voice" || voiceEngine === null || !voiceEngine.nativeCapture) {
    return;
  }
  nativeSuspended = true;
  voiceEngine.suspendNativeCapture();
  void api.voice.stopNative();
}

function resumeNativeOnFocus(): void {
  windowFocused = true;
  if (!nativeSuspended || inputMode !== "voice") {
    return;
  }
  nativeSuspended = false;
  void startNativeVoice("", false);
}

/** 懒建音频引擎：第一次播放或开麦时才创建 AudioContext。 */
function ensureVoiceEngine(): VoiceEngine {
  if (voiceEngine === null) {
    voiceEngine = new VoiceEngine({
      onSpeechStart: handleSpeechStart,
      onUtterance: () => {
        finishUtterance();
      },
      onAudioChunk: (pcm) => {
        // 全双工（P2）：一句之内的音频块连续送往 sidecar（先音频、后 audio.end）
        if (activeCharId !== null) {
          api.voice.audio({ pcm });
        }
      },
      onDiscarded: () => {
        // 太短的响声不是说话（咳嗽 / 敲桌子），静默丢掉
      },
      onError: (hint) => {
        showBubble("系统", hint, true);
      },
      onCaptureFallback: (hint) => {
        if (!nativeFallbackEnabled) {
          showBubble(
            "系统",
            hint + "（如果 Chromium 麦克风确实不可用，可在设置 → 后台引擎打开兼容模式。）",
            true,
          );
          return;
        }
        return startNativeVoice(hint);
      },
      onNativeStop: () => {
        void api.voice.stopNative();
      },
      onLevel: (rms) => updateVoiceWave(rms),
      onListening: (active) => {
        if (!active) {
          voiceUtteranceActive = false;
          // 关麦只停止采集：不 cancel 在途回复（用户可能只是不想继续说话）
          clearVoicePartial();
          updateVoiceWave(0);
        }
        renderInputMode();
      },
    });
  }
  return voiceEngine;
}

/** 语音输出按钮：开 = 会念台词；关 = 只显示文字。 */
function renderCompanionButton(): void {
  const button = byId("companion-button");
  if (button === null) {
    return;
  }
  button.classList.toggle("active", companionEnabled);
  button.classList.toggle("paused", !companionEnabled);
  button.title = companionEnabled ? "主动陪伴：开（点开设置）" : "主动陪伴：已暂停（点开设置）";
  const label = button.querySelector("span");
  if (label !== null) {
    label.textContent = companionEnabled ? "陪伴中" : "陪伴";
  }
}

function renderTtsButton(): void {
  const button = byId("tts-button");
  if (button === null) {
    return;
  }
  button.classList.toggle("active", ttsEnabled);
  button.setAttribute("aria-pressed", ttsEnabled ? "true" : "false");
  button.title = ttsEnabled
    ? "语音输出：开（点一下关掉，只显示文字）"
    : "语音输出：关（点一下开启）";
}

/**
 * 用户开口：立刻停播（<200ms 的播放侧打断），并把这一句的上下文告诉 sidecar。
 *
 * audio.start 在 sidecar 侧会抬 generation，本身就作废了上一轮在途的识别 / 生成 / 合成，
 * 所以这里不再额外发 cancel——少一条消息，也少一个竞态。
 */
function handleSpeechStart(): void {
  if (inputMode !== "voice") {
    return;
  }
  ensureVoiceEngine().interrupt();
  clearVoicePartial();
  voiceUtteranceActive = true;
  setTurnActive(true);
  renderInputMode();
  if (activeCharId === null) {
    return;
  }
  api.voice.begin({
    session_id: sessionId,
    char_id: activeCharId,
    sample_rate: ASR_SAMPLE_RATE,
    tts_enabled: ttsEnabled,
  });
}

/** 流式识别 partial（P2）：显示在聊天条的小字里；说过 / 出错就清掉。 */
function showVoicePartial(text: string): void {
  const node = byId("voice-partial");
  if (node === null) {
    return;
  }
  const trimmed = text.trim();
  node.textContent = trimmed;
  node.hidden = trimmed === "";
}

function clearVoicePartial(): void {
  const node = byId("voice-partial");
  if (node !== null) {
    node.textContent = "";
    node.hidden = true;
  }
}

/** 一句话说完：音频块已经流上去了，这里只发 audio.end 让 sidecar 开始识别。 */
function finishUtterance(): void {
  if (inputMode !== "voice") {
    voiceUtteranceActive = false;
    return;
  }
  voiceUtteranceActive = false;
  if (activeCharId === null) {
    showBubble("系统", "还没有可用角色，先把角色包放进 characters/。", true);
    return;
  }
  api.voice.end({ session_id: sessionId, char_id: activeCharId });
  turnSentenceSeen = false;
  setTurnActive(true);
  // 与打字同一条路径：先亮「在想」，第一句台词回来时 showBubble 会把它换掉
  startThinkingBubble();
}

async function sendCurrentLine(): Promise<void> {
  const input = byId("chat-input");
  if (!(input instanceof HTMLTextAreaElement) || inputMode !== "text") {
    return;
  }
  const text = input.value.trim();
  if (text === "") {
    return;
  }
  if (activeCharId === null) {
    showBubble("系统", "还没有可用角色，先把角色包放进 characters/。", true);
    return;
  }
  input.value = "";
  // 发完把输入框收回一行，窗口也跟着缩回去（T2.2）
  autoGrowInput();
  chatStream.appendUser(text);
  turnSentenceSeen = false;
  setTurnActive(true);
  // 先放「在想」气泡，不等主进程回话：orchestrator.send 要等整轮（含合成收尾）结束才 resolve，
  // 等它回来第一句台词早到了，占位气泡就永远错过（T2.2 冒烟实测 thinking_ms=0 的原因）。
  startThinkingBubble();
  // 忙时由主进程先停播 + cancel 旧轮（T2.6：文字发送和语音开口一样可以抢话筒）
  const response = await api.chat.send({
    session_id: sessionId,
    char_id: activeCharId,
    text,
    input_mode: "text",
    client_ts: Date.now(),
  });
  if (!response.accepted) {
    showBubble("系统", response.reason ?? "上一轮还没结束，先打断再说。", true);
    setTurnActive(false);
    return;
  }
  // accepted=true 时占位气泡已经在跑了；第一句台词回来时 showBubble 会把它换掉
}

function handleChatEvent(envelope: ChatEventEnvelope): void {
  const event = envelope.event;
  switch (event.t) {
    case "s": {
      // 第一句真台词到了：思考气泡让位（showBubble 里会收掉计时器）
      if (!turnSentenceSeen) {
        chatStream.startAssistantTurn();
      }
      turnSentenceSeen = true;
      showBubble(activeCharName, event.text, false);
      // 这句的情绪与动作交给形象舞台（T2.4）：PNG 实现把 act 放成 CSS 动画，表情留给 M3
      localExpression?.cancel();
      stage?.setExpression(event.emotion ?? null, event.intensity);
      stage?.playAct(event.act ?? null);
      break;
    }
    case "m":
      // 记忆写入（M2）暂时没有界面，事件照收不报错
      break;
    case "a":
      // 纯动作事件：只驱动形象，聊天条不做反应（T2.4 起不再被忽略）
      stage?.playAct(event.act);
      break;
    case "e": {
      chatStream.setStreaming(false);
      showBubble("系统", event.user_hint, true, {
        code: event.code,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      });
      // 不在这里解锁输入：错误之后主进程还要收尾（pending 合成链），
      // 统一等 voice state 回 idle 才放开（见 renderVoiceState）。
      break;
    }
    case "end":
      // 流结束不等于这一轮结束，但文字已经不再增长，先收回光标。
      chatStream.setStreaming(false);
      break;
    default:
      break;
  }
}

/**
 * 全双工事件（P2）：sidecar 在 WS 上推来的 ASR / LLM / 错误事件。
 *
 * 与文字路径的 handleChatEvent 保持同一套界面行为：台词进气泡、act 驱动舞台、错误单独一条。
 * `state` 走 voiceState 通道（renderVoiceState），`tts.audio` 走 ttsAudio 通道（播放队列）。
 */
function handleVoiceEvent(event: VoiceStreamEvent): void {
  switch (event.t) {
    case "asr.partial":
      showVoicePartial(event.text);
      break;
    case "asr.final":
      clearVoicePartial();
      // 用户说的话也要进聊天记录；appendUser 会收掉旧思考气泡，随后补一个新的
      chatStream.appendUser(event.text);
      startThinkingBubble();
      break;
    case "asr.empty":
      voiceUtteranceActive = false;
      clearVoicePartial();
      stopThinkingBubble();
      showBubble("系统", "没听清，再说一次。", true);
      setTurnActive(false);
      break;
    case "llm.s":
      clearVoicePartial();
      if (!turnSentenceSeen) {
        chatStream.startAssistantTurn();
      }
      turnSentenceSeen = true;
      showBubble(activeCharName, event.text, false);
      localExpression?.cancel();
      stage?.setExpression(event.emotion ?? null, event.intensity);
      stage?.playAct(event.act ?? null);
      break;
    case "llm.a":
      stage?.playAct(event.act);
      break;
    case "llm.m":
      // 记忆写入在 M2 没有界面
      break;
    case "llm.end":
      // 等 state 回 idle 再解锁（与文字路径一致：流结束不等于这一轮结束）
      chatStream.setStreaming(false);
      break;
    case "error":
      voiceUtteranceActive = false;
      chatStream.setStreaming(false);
      clearVoicePartial();
      showBubble("系统", event.user_hint, true, {
        code: event.code,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      });
      break;
    default:
      break;
  }
}

/** 指针进出一律报给主进程：命中区（立绘或聊天条）内可点，之外让窗口穿透（§6.11）。 */
function trackPointer(event: MouseEvent): void {
  // 指针又回到窗内，说明窗口追上了光标：取消出窗宽限（拖动继续）
  if (leaveTimer !== null) {
    window.clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const inside = target !== null && target.closest("[data-interactive]") !== null;
  if (inside === pointerInside) {
    return;
  }
  pointerInside = inside;
  api.ui.pointer({ inside });
}

/**
 * 输入框自动换行变高（F11 / T2.2 真机反馈）。
 *
 * 为什么不用 input 元素：input 永远单行，长句只能横向滚动，用户看不到自己写了什么。
 * 换成 textarea 后按内容高度撑开，超过上限改为内部滚动，聊天条高度随之变化。
 */
function autoGrowInput(): void {
  const input = byId("chat-input");
  if (!(input instanceof HTMLTextAreaElement)) {
    return;
  }
  if (inputMode !== "text") {
    return;
  }
  input.style.height = "auto";
  const height = Math.min(
    Math.max(input.scrollHeight, CHAT_INPUT_MIN_HEIGHT),
    CHAT_INPUT_MAX_HEIGHT,
  );
  input.style.height = height + "px";
  const panel = byId("mode-panel");
  lastTextPanelHeight = Math.max(CHAT_INPUT_MIN_HEIGHT, panel?.offsetHeight ?? height);
  updateSendButton();
  reportMetrics();
}

/** 输入为空 / 非文字模式时把发送按钮暗下去：视觉上就能看出「现在没东西可发」。 */
function updateSendButton(): void {
  const input = byId("chat-input");
  const button = byId("send-button");
  if (!(input instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {
    return;
  }
  button.disabled = inputMode !== "text" || input.value.trim() === "";
}

/**
 * 把量到的立绘包围盒与聊天条高度报给主进程（T2.2：窗口尺寸 = 包围盒 × 缩放 + 聊天条）。
 *
 * 为什么由渲染层量：PNG 的自然尺寸只有渲染层知道，M3 的 Live2D 更是只有画布知道；
 * 主进程只按这两个数算窗口大小（下限也由它兜）。图还没加载出来（stage.metrics() 为 null）时不上报。
 */
function reportMetrics(): void {
  const chatbar = byId("chatbar");
  const size = stage?.metrics() ?? null;
  if (chatbar === null || size === null) {
    return;
  }
  api.ui.metrics({
    stage_width: size.width,
    stage_height: size.height,
    chatbar_height: Math.round(chatbar.getBoundingClientRect().height),
  });
}

/**
 * 开始拖动：只报「按下」，位置由主进程每 12ms 读系统光标算。
 *
 * 为什么渲染层不再自己算位移：clientX 是相对本窗口的，而窗口会跟着光标一起动，两次 mousemove
 * 的差值于是趋近 0——「拖动不跟手、拖快一点就不动」的根因（T2.2 用户反馈第五轮）。命中判定仍在
 * 这里做：按钮 / 输入框 / 弹出层排除，立绘与聊天条的边框、间隙都能抓。
 */
function startDrag(event: MouseEvent): void {
  // 互动模式开着时立绘是「摸」的，拖动改用顶部把手（用户 m12028：互动模式不允许拖窗）
  if (interactMode) {
    return;
  }
  if (event.button !== 0) {
    return;
  }
  const target = event.target;
  if (target instanceof Element && target.closest(DRAG_EXCLUDE) !== null) {
    return;
  }
  if (dragging) {
    return;
  }
  if (leaveTimer !== null) {
    window.clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  dragging = true;
  document.body.classList.add("dragging");
  // 拖动期间窗口必须可点：穿透开着时第一次 mousedown 根本到不了页面
  if (!pointerInside) {
    pointerInside = true;
    api.ui.pointer({ inside: true });
  }
  api.ui.drag({ action: "start" });
}

function endDrag(): void {
  if (leaveTimer !== null) {
    window.clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  if (!dragging) {
    return;
  }
  dragging = false;
  document.body.classList.remove("dragging");
  api.ui.drag({ action: "end" });
}

/**
 * 拖动中指针跑到窗外后的宽限收尾（T2.2 用户反馈第五轮）。
 *
 * 为什么需要：拖动是主进程每 12ms 追一次光标，一记极快的甩动会出现「光标已经出窗、窗口还没跟上」
 * 的瞬间；此时若立刻结束拖动，用户的感觉就是「拖快一点就断了」。给一个短宽限，窗口追上来就取消。
 */
function scheduleLeaveEnd(): void {
  if (leaveTimer !== null) {
    window.clearTimeout(leaveTimer);
  }
  leaveTimer = window.setTimeout(() => {
    leaveTimer = null;
    endDrag();
  }, DRAG_LEAVE_GRACE_MS);
}

/** 拖动把手上的角色名：窗口没标题栏，这条把手是唯一的窗口标识（F11）。 */
function renderGrip(name: string): void {
  const node = byId("grip-name");
  if (node !== null) {
    node.textContent = name;
  }
}

function applyUiState(state: UiStatePayload): void {
  // 缩放由主进程按包围盒算窗口尺寸；素材本身由 CSS 铺满立绘区（T2.2）
  if (state.char_id !== null && state.char_id !== activeCharId) {
    activeCharId = state.char_id;
    const name = characterNames.get(state.char_id);
    if (name !== undefined) {
      activeCharName = name;
      renderGrip(name);
    }
    characterMenu.markCurrent();
    touchTracker.reset();
    // 角色可能在别处被切走（设置窗 / 另一处 UI），聊天记录也跟着清空（T2.27）
    chatStream.clear();
    // 立绘也得跟上（T2.3-C2）
    void loadCharacterArt(state.char_id);
  }
  // 手势开关可能在设置窗改过（T2.3-C2c）；只影响之后发生的触摸
  gestureSettings = state.gestures;
  // 窗口层级可能被托盘 / 设置窗改过：菜单里的「当前项」要跟着状态走
  alwaysOnTop = state.always_on_top;
  renderWindowPopup();
  // 帧率档位可能在设置窗改过（T2.43）：改完立刻生效，不用重开舞台
  stageFps = state.fps;
  stage?.setMaxFps(state.fps);
  // 语音输出开关可能在设置窗 / 另一处 UI 改过
  ttsEnabled = state.tts_enabled;
  nativeFallbackEnabled = state.native_mic_fallback;
  companionEnabled = state.companion.enabled;
  renderTtsButton();
  renderCompanionButton();
}

/**
 * 重新扫一遍 characters/（角色包编辑器保存后主进程会广播，T2.3-D）。
 *
 * 当前角色还在就什么都不切：新建角色包不该把用户正在聊的角色顶掉；当前角色被删了才退到第一个。
 */
async function refreshCharacters(): Promise<void> {
  try {
    const characters = await api.characters.list();
    characterNames.clear();
    for (const character of characters) {
      characterNames.set(character.char_id, character.display_name);
    }
    if (activeCharId !== null) {
      const name = characterNames.get(activeCharId);
      if (name !== undefined) {
        activeCharName = name;
        renderGrip(name);
      }
    }
    characterMenu.render(characters);
    characterMenu.markCurrent();
    if (activeCharId !== null && characters.some((item) => item.char_id === activeCharId)) {
      // 编辑器保存了 hits（或外部改了角色包）：重载当前角色的立绘 + 部位，但不切走角色
      await loadCharacterArt(activeCharId);
    } else if (characters.length > 0) {
      const first = characters[0];
      if (first !== undefined) {
        await selectCharacter(first);
      }
    }
  } catch (error: unknown) {
    showBanner("读取角色列表失败：" + String(error));
  }
}

async function main(): Promise<void> {
  if (api === undefined) {
    showBanner("preload 桥没有注入（window.deskpet 不存在），请检查打包产物里的 preload 路径。");
    return;
  }
  sessionId = crypto.randomUUID();
  // 先挂追踪再建舞台：首帧坐标只推一次，晚订阅会丢掉「鼠标不动」时的初始视线（T2.27）
  api.ui.onCursor((message) => {
    stage?.lookAt(message.x, message.y);
  });

  try {
    const characters = await api.characters.list();
    for (const character of characters) {
      characterNames.set(character.char_id, character.display_name);
    }
    const state = await api.ui.getState();
    gestureSettings = state.gestures;
    stageFps = state.fps;
    alwaysOnTop = state.always_on_top;
    ttsEnabled = state.tts_enabled;
    companionEnabled = state.companion.enabled;
    renderWindowPopup();
    renderTtsButton();
    renderCompanionButton();
    const current =
      characters.find((character) => character.char_id === state.char_id) ?? characters[0];
    if (current !== undefined) {
      activeCharId = current.char_id;
      activeCharName = current.display_name;
      renderGrip(activeCharName);
      await loadCharacterArt(current.char_id);
      if (state.char_id !== current.char_id) {
        // 首次运行或角色被删：把当前角色固定下来，之后聊天条与聊天请求都用它
        await api.ui.setState({ char_id: current.char_id });
      }
    }
    characterMenu.render(characters);
    characterMenu.markCurrent();
  } catch (error: unknown) {
    showBanner("读取角色列表失败：" + String(error));
  }

  try {
    renderHealth(await api.health.get());
  } catch (error: unknown) {
    showBanner("读取心跳失败：" + String(error));
  }
  api.health.onChanged(renderHealth);
  api.ui.onStateChanged(applyUiState);
  api.ui.onTouchGate(renderTouchGate);
  api.voice.onState((payload) => renderVoiceState(payload.state, payload.detail));
  api.voice.onEvent(handleVoiceEvent);
  api.voice.onNativeAudio((pcm) => {
    // 原生兜底没有 Chromium 的 AEC：助手说话期间先不听，避免把自己的 TTS 又识别一遍。
    // 说完 / 取消后自动恢复；用户仍可用文字随时打断。
    if (voiceStateName === "speaking" || voiceStateName === "cancelling") {
      return;
    }
    voiceEngine?.pushNativePcm(pcm);
  });
  api.voice.onNativeError((message) => {
    showBubble("系统", message, true);
    nativeSuspended = false;
    voiceEngine?.stopCapture();
    if (inputMode === "voice") {
      setInputMode("text");
    }
  });
  api.chat.onEvent(handleChatEvent);
  bindErrorDetail();
  bindChatScroll();
  api.chat.onAudio((message) => {
    // 语音输出关闭：主进程不会再合成，这里再兜一层（旧音频也可能在途）
    if (!ttsEnabled) {
      return;
    }
    ensureVoiceEngine().enqueueAudio(message.audio);
  });
  api.characters.onChanged(() => {
    void refreshCharacters();
  });
  // 编辑器点「按模型网格生成部位」时，主进程会来问几何（T2.44）：没有 Live2D 舞台就如实回错，
  // 让编辑器给出「先把主窗切到这个角色」的提示，而不是静默生成空列表。
  api.characters.onHitsProbe((message) => {
    const bounds = stage?.drawableBounds(message.drawables) ?? null;
    api.characters.replyHitsProbe({
      request_id: message.request_id,
      error: bounds === null ? "主窗现在显示的不是这个角色的 Live2D 模型，先切到该角色再试。" : "",
      bounds:
        bounds === null
          ? []
          : Object.entries(bounds).map(([id, rect]) => ({
              id,
              rect: [rect[0], rect[1], rect[2], rect[3]] as [number, number, number, number],
            })),
    });
  });

  const input = byId("chat-input");
  input?.addEventListener("input", autoGrowInput);
  input?.addEventListener("keydown", (event) => {
    // Enter 发送、Shift+Enter 换行：多行输入必须留出换行的走法（T2.2）
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void sendCurrentLine();
  });

  byId("send-button")?.addEventListener("click", () => {
    void sendCurrentLine();
  });
  byId("interrupt-button")?.addEventListener("click", () => {
    // 主进程的 chat.cancel 会同时取消 HTTP 与 WS；voice.cancel 只是兜底
    voiceUtteranceActive = false;
    void api.chat.cancel({ session_id: sessionId });
    api.voice.cancel();
    ensureVoiceEngine().interrupt();
  });
  byId("char-button")?.addEventListener("click", () => {
    characterMenu.toggle();
  });
  byId("companion-button")?.addEventListener("click", () => {
    void api.companion.open();
  });
  byId("settings-button")?.addEventListener("click", () => {
    void api.settings.open();
  });
  // 引擎失败横幅本身就是入口：用户看到原因后第一件事是「去哪儿改」，别让他自己找齿轮
  byId("banner")?.addEventListener("click", () => {
    const intent = bannerAction();
    if (intent === null) {
      return;
    }
    if (intent.pane === "providers") {
      void api.settings.open("providers");
      return;
    }
    void api.settings.open();
  });

  for (const mode of ["text", "voice", "touch"] as const) {
    byId("mode-" + mode)?.addEventListener("click", () => setInputMode(mode));
  }
  // 启动默认文字模式：麦克风与触摸都关，先把选择同步给主进程（T2.6）
  api.ui.setInputMode({ mode: inputMode });
  renderInputMode();
  byId("tts-button")?.addEventListener("click", () => {
    const next = !ttsEnabled;
    ttsEnabled = next;
    renderTtsButton();
    if (!next) {
      // 立刻安静：停播并丢掉排队音频
      ensureVoiceEngine().interrupt();
    }
    void api.ui.setState({ tts_enabled: next });
  });
  // 音频上下文要用户手势才能出声 / 采音：第一次点击或按键时解锁（幂等）
  document.addEventListener("mousedown", () => ensureVoiceEngine().unlockAudio(), {
    once: true,
  });
  document.addEventListener("keydown", () => ensureVoiceEngine().unlockAudio(), {
    once: true,
  });

  // 窗口显示方式菜单（用户反馈）：普通层 / 置顶 / 隐藏到托盘
  byId("window-button")?.addEventListener("click", () => {
    const popup = byId("window-popup");
    if (popup !== null) {
      setWindowPopupOpen(popup.hidden);
    }
  });
  // 点菜单外面 / Esc 收起，避免弹层一直盖着输入区
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".menu-anchor") !== null) {
      return;
    }
    characterMenu.hide();
    setWindowPopupOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      characterMenu.hide();
      setWindowPopupOpen(false);
    }
  });
  byId("window-desktop")?.addEventListener("click", () => {
    setWindowPopupOpen(false);
    void api.ui.setState({ always_on_top: false });
  });
  byId("window-top")?.addEventListener("click", () => {
    setWindowPopupOpen(false);
    void api.ui.setState({ always_on_top: true });
  });
  byId("window-hide")?.addEventListener("click", () => {
    setWindowPopupOpen(false);
    api.ui.minimize();
  });

  // 触摸互动与拖动共用按下 / 松开：互动模式关着时按下只是准备拖动（T2.3-C2c）
  document.addEventListener("mousedown", startDrag);
  document.addEventListener("mousedown", beginTouch);
  document.addEventListener("mousemove", trackPointer);
  document.addEventListener("mousemove", moveTouch);
  document.addEventListener("mouseup", endDrag);
  document.addEventListener("mouseup", endTouch);
  // 每 250ms 收一次静默的触摸串：一串动作彻底停下才交给主进程
  window.setInterval(flushTouches, TOUCH_FLUSH_MS);
  // 拖到窗口外松开也要收尾，否则指针回来会接着拖
  window.addEventListener("blur", () => {
    endDrag();
    touchStart = null;
    suspendNativeOnBlur();
  });
  window.addEventListener("focus", () => {
    resumeNativeOnFocus();
  });
  document.addEventListener("mouseleave", () => {
    if (dragging) {
      // 拖动中不改穿透状态：一旦变回穿透，松开鼠标的事件就再也收不到，窗口会一直粘着光标
      scheduleLeaveEnd();
      return;
    }
    // 光标出窗：先保持一会儿注意，再缓回正前方（T2.41 掠过注意）
    stage?.relaxLook(GLANCE_HOLD_MS);
    if (pointerInside) {
      pointerInside = false;
      api.ui.pointer({ inside: false });
    }
  });

  // 聊天条高度会随输入框 / 换行 / 窄窗变化：实时把实测高度报给主进程，窗口跟着变
  if (typeof ResizeObserver !== "undefined") {
    const chatbar = byId("chatbar");
    if (chatbar !== null) {
      const observer = new ResizeObserver(() => reportMetrics());
      observer.observe(chatbar);
    }
  }

  // 首次上报：图已缓存时 load 事件不会再触发，这里主动量一次（T2.2）
  autoGrowInput();
  initVoiceWave();

  // 就绪标记：上面的监听器挂完才算「能收输入」。冒烟脚本靠它避免
  // 在监听器挂上之前发消息（T1.13a 踩过的竞态：心跳先亮绿，监听器后挂）。
  document.body.dataset.ready = "1";
}

void main();
