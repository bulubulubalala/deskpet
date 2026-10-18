/**
 * 文件职责：桌宠主窗渲染层——立绘 + 聊天条，把主进程推来的状态画上去（F11 / §6.11）。
 *
 * 为什么没有标题栏与状态面板：F11 规定桌面只有人和一条输入栏，模块健康收成聊天条旁的小圆点；
 * 端口 / pid / 模块明细都搬进设置窗，这里只负责「能聊天、能打断、能换角色、能开设置」。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 * 写入一律用 textContent / createElement，不用 innerHTML（注入防线，需求 §7.4）。
 */
import type { HealthView } from "../main/engine";
import type {
  CharHitRegion,
  CharacterSummary,
  ChatEventEnvelope,
  TouchRegion,
  UiGestureSettings,
  UiStatePayload,
} from "../main/ipc";
import type { DeskpetApi } from "../preload/api";
import { ASR_SAMPLE_RATE } from "./audio-codec";
import { contentBox, locateRegion, toNormalizedPoint } from "./char-hit";
import { TOUCH_STROKE_MIN_PX, TouchTracker, isGestureEnabled } from "./touch";
import { VoiceEngine } from "./voice-engine";

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

/** 气泡停留时长：台词是临时的，不占版面（F11）。 */
const BUBBLE_HIDE_MS = 12000;

/** 输入框自动换行的高度区间（F11：输入框随内容变高，聊天条跟着变高，窗口再跟着变）。 */
const CHAT_INPUT_MIN_HEIGHT = 40;
const CHAT_INPUT_MAX_HEIGHT = 120;

/**
 * 思考中气泡：发出去到第一句台词回来之间，气泡里只循环 1→2→3 个「·」（T2.2 真机反馈）。
 *
 * 为什么不写「正在思考…」这类字：那是假台词，用户会当成角色真在说话；而且冒烟脚本用气泡
 * 文字判「首句实义」，占位文字必须能和真台词区分（scripts/lib/cdp.mjs: REPLY_BUBBLE）。
 */
const THINKING_DOTS = ["·", "··", "···"];
/** 元组下标在 noUncheckedIndexedAccess 下可能为 undefined，取第一个点作兜底。 */
const DOT_SAMPLE = "·";
const THINKING_TICK_MS = 400;

const api = window.deskpet;
let sessionId = "";
let activeCharId: string | null = null;
let activeCharName = "角色";
/** 角色 id → 显示名；拖动把手上的名字随角色切换更新（F11：窗口没有标题栏）。 */
const characterNames = new Map<string, string>();
let turnActive = false;
let voiceStateName = "idle";
let pointerInside = false;
let bubbleTimer: number | null = null;
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
/** 一次按下到松开的现场；tracked 为假表示这次按下还没被当成触摸。 */
let touchStart: { x: number; y: number; at: number; tracked: boolean } | null = null;
/** 当前角色包的部位定义；空数组 = 这个包还没画部位，点击不响应（也不记账）。 */
let hitRegions: readonly CharHitRegion[] = [];
/** 是否正在免提收音（D20 常开麦）；麦克风按钮据此点亮。 */
let micOn = false;
/** 音频设备层：采集与播放共用，第一次真正用到时才建（T2.4 / T1.12b）。 */
let voiceEngine: VoiceEngine | null = null;

/** 这些控件要真正点击 / 输入，按在它们身上不拖窗口；其余位置（立绘、聊天条边框）都能拖。 */
const DRAG_EXCLUDE = "button, input, textarea, select, a, .popup";
/** 思考气泡的循环计时器；非空表示气泡正处于「在想」状态（T2.2）。 */
let thinkingTimer: number | null = null;
/** 这一轮是否已经收到过真台词——防止迟到的思考气泡把先到的那句盖掉（T2.2）。 */
let turnSentenceSeen = false;

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function showBanner(message: string): void {
  const banner = byId("banner");
  if (banner !== null) {
    banner.hidden = false;
    banner.textContent = message;
  }
}

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
  const bubble = byId("bubble");
  const textNode = byId("bubble-text");
  if (bubble === null || textNode === null) {
    return;
  }
  stopThinkingBubble();
  bubble.hidden = false;
  bubble.className = "bubble thinking";
  const speakerNode = byId("bubble-speaker");
  if (speakerNode !== null) {
    speakerNode.textContent = activeCharName;
  }
  // 思考气泡不自动消失：等一句台词可能要十几秒，12 秒的隐藏定时器会让窗口突然空掉
  if (bubbleTimer !== null) {
    window.clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  let step = 0;
  textNode.textContent = THINKING_DOTS[step] ?? DOT_SAMPLE;
  thinkingTimer = window.setInterval(() => {
    step = (step + 1) % THINKING_DOTS.length;
    textNode.textContent = THINKING_DOTS[step] ?? DOT_SAMPLE;
  }, THINKING_TICK_MS);
}

/** 收掉思考气泡：换台词、报错、打断、一轮结束都调；hide 为真时连气泡一起藏掉。 */
function stopThinkingBubble(hide = false): void {
  const wasThinking = thinkingTimer !== null;
  if (thinkingTimer !== null) {
    window.clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  if (wasThinking && hide) {
    const bubble = byId("bubble");
    if (bubble !== null) {
      bubble.hidden = true;
    }
  }
}

/** 台词气泡：角色说话用普通样式，技术错误用错误样式，两者永远是两块不同的文字（§6.7）。 */
function showBubble(speaker: string, text: string, isError: boolean): void {
  // 真台词 / 系统提示来了：占位气泡让位（计时器在这里统一收掉）
  stopThinkingBubble();
  const bubble = byId("bubble");
  if (bubble === null) {
    return;
  }
  bubble.hidden = false;
  bubble.className = isError ? "bubble error" : "bubble";
  const speakerNode = byId("bubble-speaker");
  if (speakerNode !== null) {
    speakerNode.textContent = speaker;
  }
  const textNode = byId("bubble-text");
  if (textNode !== null) {
    textNode.textContent = text;
  }
  if (bubbleTimer !== null) {
    window.clearTimeout(bubbleTimer);
  }
  bubbleTimer = window.setTimeout(() => {
    bubble.hidden = true;
  }, BUBBLE_HIDE_MS);
}

function setTurnActive(active: boolean): void {
  turnActive = active;
  const button = byId("interrupt-button");
  if (button instanceof HTMLButtonElement) {
    button.disabled = !active;
  }
}

function renderHealth(view: HealthView): void {
  const dot = byId("health-dot");
  if (dot !== null) {
    dot.className = "health-dot " + view.state;
    dot.title = HEALTH_TITLES[view.state];
  }
}

function renderVoiceState(state: string, detail?: string): void {
  const node = byId("voice-state");
  if (node !== null) {
    node.textContent = VOICE_LABELS[state] ?? state;
    node.title = detail ?? VOICE_LABELS[state] ?? state;
  }
  const wasIdle = voiceStateName === "idle";
  voiceStateName = state;
  // 打断或一轮结束：思考气泡还没等到台词就直接收掉（T2.2 真机需求）
  if (!wasIdle && (state === "cancelling" || state === "idle")) {
    stopThinkingBubble(true);
  }
  // 一轮真正结束以「主进程说空闲」为准，而不是流结束：合成收尾期间主进程仍会拒绝新的一句，
  // 界面若提前把打断按钮灰掉，用户按 Enter 只会收到「上一轮还没说完」（T1.13a 冒烟发现的问题）。
  // 主进程也能自己起一轮（部位点击 T2.3-C2b）：只要不是空闲，界面就算「在忙」；
  // 否则用户在这期间按 Enter 只会被主进程拒掉（「上一轮还没说完」）。
  if (state !== "idle" && !turnActive) {
    setTurnActive(true);
  }
  if (state === "idle" && !wasIdle) {
    setTurnActive(false);
  }
  if (state === "idle" && micOn) {
    // 免提常开麦：一轮结束后把「在听」重新挂上（sidecar 按活动集合推导状态，D20）
    void api.voice.start();
  }
}

/** 角色切换弹出层：只列 characters/ 下真实存在的角色包（char_list 由主进程扫目录）。 */
function renderCharacterPopup(characters: readonly CharacterSummary[]): void {
  const popup = byId("char-popup");
  if (popup === null) {
    return;
  }
  popup.replaceChildren();
  if (characters.length === 0) {
    const empty = document.createElement("p");
    empty.className = "popup-empty";
    empty.textContent = "还没有角色包：把角色包目录放进 characters/ 后重启。";
    popup.append(empty);
    return;
  }
  for (const character of characters) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = character.char_id === activeCharId ? "popup-item current" : "popup-item";
    item.textContent = character.display_name;
    item.title = character.char_id;
    item.addEventListener("click", () => {
      void selectCharacter(character);
    });
    popup.append(item);
  }
}

/**
 * 换角色：把立绘（data URL）与部位定义一起换掉（T2.3-C2）。
 *
 * 立绘走 data URL 而不是 file://：渲染层的 CSP 只放行 img-src 'self' data:，主进程读到字节后
 * 编码成 base64 递过来，界面不必放宽安全策略。没有立绘 / 读失败就退回内置占位图。
 */
async function loadCharacterArt(charId: string): Promise<void> {
  const node = byId("character");
  if (node instanceof HTMLImageElement) {
    try {
      const { data_url: dataUrl } = await api.characters.portrait({ char_id: charId });
      node.src = dataUrl ?? "assets/placeholder.png";
    } catch {
      node.src = "assets/placeholder.png";
    }
  }
  try {
    const { regions } = await api.characters.hits({ char_id: charId });
    hitRegions = regions;
  } catch {
    hitRegions = [];
  }
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
  const node = byId("character");
  if (!(node instanceof HTMLImageElement)) {
    return;
  }
  const rect = node.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    return;
  }
  const at = Date.now();
  touchStart = { x: event.clientX, y: event.clientY, at, tracked: false };
  if (interactMode) {
    startTouchTracking(event.clientX, event.clientY, at);
  }
}

/** 归一化坐标 → 命中的部位；没画部位、点在框外、立绘没加载都返回 null。 */
function regionAt(node: HTMLImageElement, clientX: number, clientY: number): TouchRegion | null {
  if (hitRegions.length === 0) {
    return null;
  }
  const box = contentBox(node.getBoundingClientRect(), node.naturalWidth, node.naturalHeight);
  if (box === null) {
    return null;
  }
  const point = toNormalizedPoint(box, clientX, clientY);
  if (point === null) {
    return null;
  }
  const region = locateRegion(hitRegions, point.x, point.y);
  return region === null ? null : { id: region.id, name: region.name };
}

/** 记下这一串轨迹的起点；之后 move / up 都往同一个 TouchTracker 里塞。 */
function startTouchTracking(x: number, y: number, at: number): void {
  const node = byId("character");
  touchTracker.down(x, y, at, node instanceof HTMLImageElement ? regionAt(node, x, y) : null);
  if (touchStart !== null) {
    touchStart.tracked = true;
  }
}

/** 拖动轨迹：互动模式关着时，按住后在立绘上滑够距离也算「到处摸」（设置里的 triggers）。 */
function moveTouch(event: MouseEvent): void {
  const start = touchStart;
  if (start === null) {
    return;
  }
  if (!start.tracked) {
    if (!gestureSettings.triggers.includes("stroke")) {
      return;
    }
    const moved = Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y);
    if (moved < TOUCH_STROKE_MIN_PX) {
      return;
    }
    setInteractMode(true);
    startTouchTracking(start.x, start.y, start.at);
  }
  const node = byId("character");
  touchTracker.move(
    event.clientX,
    event.clientY,
    Date.now(),
    node instanceof HTMLImageElement ? regionAt(node, event.clientX, event.clientY) : null,
  );
}

/** 松手：不立刻发消息（一串动作要等静默），只给一下视觉反馈。 */
function endTouch(event: MouseEvent): void {
  const start = touchStart;
  touchStart = null;
  if (start === null || !start.tracked) {
    return;
  }
  const node = byId("character");
  touchTracker.up(
    event.clientX,
    event.clientY,
    Date.now(),
    node instanceof HTMLImageElement ? regionAt(node, event.clientX, event.clientY) : null,
  );
  pulseTouch();
}

/** 摸一下的视觉反馈：300ms 的回弹 + 光晕（替代原来的本地预制台词，方案 §4.3）。 */
function pulseTouch(): void {
  const node = byId("character");
  if (node === null) {
    return;
  }
  node.classList.remove("touch-pulse");
  void node.offsetWidth;
  node.classList.add("touch-pulse");
  window.setTimeout(() => node.classList.remove("touch-pulse"), 320);
}

/**
 * 每 250ms 收一次静默的触摸串：够静了就发出去（设置里禁掉的手势直接丢）。
 *
 * 为什么不松手就发：连点 / 揉 / 拍要合成「一串」再交给模型，否则一次揉会被拆成几十下点击。
 */
function flushTouches(): void {
  const message = touchTracker.closeIfIdle(Date.now());
  if (message === null) {
    return;
  }
  if (!isGestureEnabled(gestureSettings.enabled, message.gesture)) {
    return;
  }
  api.ui.touch(message);
}

/** 开关互动模式：立绘光标变抓取、按钮高亮；关掉时把还没结算的那串丢掉。 */
function setInteractMode(on: boolean): void {
  if (interactMode === on) {
    return;
  }
  interactMode = on;
  touchTracker.reset();
  touchStart = null;
  document.body.classList.toggle("interacting", on);
  const button = byId("interact-button");
  if (button !== null) {
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (!on) {
    endDrag();
  }
}

async function selectCharacter(character: CharacterSummary): Promise<void> {
  activeCharId = character.char_id;
  activeCharName = character.display_name;
  hideCharacterPopup();
  await api.ui.setState({ char_id: character.char_id });
  touchTracker.reset();
  await loadCharacterArt(character.char_id);
  showBubble("系统", "已切换到 " + character.display_name, true);
}

function hideCharacterPopup(): void {
  const popup = byId("char-popup");
  if (popup !== null) {
    popup.hidden = true;
  }
}

/** 懒建音频引擎：第一次播放或开麦时才创建 AudioContext。 */
function ensureVoiceEngine(): VoiceEngine {
  if (voiceEngine === null) {
    voiceEngine = new VoiceEngine({
      onSpeechStart: handleSpeechStart,
      onUtterance: (pcm) => {
        void finishUtterance(pcm);
      },
      onDiscarded: () => {
        // 太短的响声不是说话（咳嗽 / 敲桌子），静默丢掉
      },
      onError: (hint) => {
        showBubble("系统", hint, true);
      },
      onListening: (active) => {
        setMicIndicator(active);
        if (!active) {
          // 关麦：空 PCM 让主进程把「在听」收回去（见 chat-orchestrator.stopListening）
          void api.voice.stop({
            session_id: sessionId,
            sample_rate: ASR_SAMPLE_RATE,
            pcm: new Uint8Array(0),
          });
        }
      },
    });
  }
  return voiceEngine;
}

/** 麦克风按钮的亮 / 灭与 tooltip；开麦状态一变就调它。 */
function setMicIndicator(on: boolean): void {
  micOn = on;
  const button = byId("mic-button");
  if (button !== null) {
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.title = on ? "免提（常开麦）：正在听，点一下关掉" : "免提（常开麦）：点一下开始听";
  }
}

/**
 * 用户开口：立刻停播 + 作废在途生成，这就是 <200ms 的播放侧打断（D20 / §6.7）。
 *
 * 停播在渲染层就地做（voiceEngine.interrupt），作废在途交给主进程：
 * api.voice.start() 会让编排层先 cancel 当前会话，再进入「在听」。
 */
function handleSpeechStart(): void {
  ensureVoiceEngine().interrupt();
  void api.voice.start();
}

/** 一句话说完：送 ASR；没听清就提示重说，听清了就当一次语音输入发出去。 */
async function finishUtterance(pcm: Uint8Array): Promise<void> {
  if (activeCharId === null) {
    showBubble("系统", "还没有可用角色，先把角色包放进 characters/。", true);
    return;
  }
  const result = await api.voice.stop({
    session_id: sessionId,
    sample_rate: ASR_SAMPLE_RATE,
    pcm,
  });
  if (!result.heard) {
    showBubble("系统", "没听清，再说一次。", true);
    return;
  }
  turnSentenceSeen = false;
  setTurnActive(true);
  // 与打字同一条路径：先亮「在想」，第一句台词回来时 showBubble 会把它换掉
  startThinkingBubble();
  const response = await api.chat.send({
    session_id: sessionId,
    char_id: activeCharId,
    text: result.text,
    input_mode: "voice",
    client_ts: Date.now(),
  });
  if (!response.accepted) {
    showBubble("系统", response.reason ?? "上一轮还没结束，先打断再说。", true);
    setTurnActive(false);
  }
}

/** 麦克风按钮：开 / 关免提（常开麦）。 */
async function toggleMic(): Promise<void> {
  const engine = ensureVoiceEngine();
  if (engine.listening) {
    engine.stop();
    return;
  }
  engine.unlockAudio();
  await engine.start();
  if (engine.listening) {
    void api.voice.start();
  }
}

async function sendCurrentLine(): Promise<void> {
  const input = byId("chat-input");
  if (!(input instanceof HTMLTextAreaElement)) {
    return;
  }
  const text = input.value.trim();
  if (text === "" || turnActive) {
    return;
  }
  if (activeCharId === null) {
    showBubble("系统", "还没有可用角色，先把角色包放进 characters/。", true);
    return;
  }
  input.value = "";
  // 发完把输入框收回一行，窗口也跟着缩回去（T2.2）
  autoGrowInput();
  turnSentenceSeen = false;
  setTurnActive(true);
  // 先放「在想」气泡，不等主进程回话：orchestrator.send 要等整轮（含合成收尾）结束才 resolve，
  // 等它回来第一句台词早到了，占位气泡就永远错过（T2.2 冒烟实测 thinking_ms=0 的原因）。
  startThinkingBubble();
  const response = await api.chat.send({
    session_id: sessionId,
    char_id: activeCharId,
    text,
    input_mode: "text",
    client_ts: Date.now(),
  });
  if (!response.accepted) {
    // accepted=false 只表示上一轮还在跑，不是网络故障（§6.10）
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
      turnSentenceSeen = true;
      showBubble(activeCharName, event.text, false);
      break;
    }
    case "m":
      // 记忆写入（M2）暂时没有界面，事件照收不报错
      break;
    case "a":
      // 纯动作事件（M3 驱动形象），聊天条不做反应
      break;
    case "e": {
      showBubble("系统", event.user_hint, true);
      // 不在这里解锁输入：错误之后主进程还要收尾（pending 合成链），
      // 统一等 voice state 回 idle 才放开（见 renderVoiceState）。
      break;
    }
    case "end":
      // 同上：流结束不等于这一轮结束。
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
  input.style.height = "auto";
  const height = Math.min(
    Math.max(input.scrollHeight, CHAT_INPUT_MIN_HEIGHT),
    CHAT_INPUT_MAX_HEIGHT,
  );
  input.style.height = height + "px";
  reportMetrics();
}

/**
 * 把量到的立绘包围盒与聊天条高度报给主进程（T2.2：窗口尺寸 = 包围盒 × 缩放 + 聊天条）。
 *
 * 为什么由渲染层量：PNG 的自然尺寸只有渲染层知道，M3 的 Live2D 更是只有画布知道；
 * 主进程只按这两个数算窗口大小（下限也由它兜）。图还没加载出来时不上报。
 */
function reportMetrics(): void {
  const character = byId("character");
  const chatbar = byId("chatbar");
  if (!(character instanceof HTMLImageElement) || chatbar === null) {
    return;
  }
  if (character.naturalWidth <= 0 || character.naturalHeight <= 0) {
    return;
  }
  api.ui.metrics({
    stage_width: character.naturalWidth,
    stage_height: character.naturalHeight,
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
    touchTracker.reset();
    // 角色可能在别处被切走（设置窗 / 另一处 UI），立绘也得跟上（T2.3-C2）
    void loadCharacterArt(state.char_id);
  }
  // 手势开关可能在设置窗改过（T2.3-C2c）；只影响之后发生的触摸
  gestureSettings = state.gestures;
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
    renderCharacterPopup(characters);
    if (characters.length > 0 && !characters.some((item) => item.char_id === activeCharId)) {
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

  try {
    const characters = await api.characters.list();
    for (const character of characters) {
      characterNames.set(character.char_id, character.display_name);
    }
    const state = await api.ui.getState();
    gestureSettings = state.gestures;
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
    renderCharacterPopup(characters);
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
  api.voice.onState((payload) => renderVoiceState(payload.state, payload.detail));
  api.chat.onEvent(handleChatEvent);
  api.chat.onAudio((message) => {
    ensureVoiceEngine().enqueueAudio(message.audio);
  });
  api.characters.onChanged(() => {
    void refreshCharacters();
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

  const character = byId("character");
  character?.addEventListener("load", () => {
    // 换素材（M3 之后还有 Live2D）时窗口要跟着变
    reportMetrics();
  });
  byId("send-button")?.addEventListener("click", () => {
    void sendCurrentLine();
  });
  byId("interrupt-button")?.addEventListener("click", () => {
    void api.chat.cancel({ session_id: sessionId });
  });
  byId("char-button")?.addEventListener("click", () => {
    const popup = byId("char-popup");
    if (popup !== null) {
      popup.hidden = !popup.hidden;
    }
  });
  byId("settings-button")?.addEventListener("click", () => {
    void api.settings.open();
  });

  byId("interact-button")?.addEventListener("click", () => {
    setInteractMode(!interactMode);
  });
  byId("mic-button")?.addEventListener("click", () => {
    void toggleMic();
  });
  // 音频上下文要用户手势才能出声 / 采音：第一次点击或按键时解锁（幂等）
  document.addEventListener("mousedown", () => ensureVoiceEngine().unlockAudio(), {
    once: true,
  });
  document.addEventListener("keydown", () => ensureVoiceEngine().unlockAudio(), {
    once: true,
  });
  byId("minimize-button")?.addEventListener("click", () => {
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
  });
  document.addEventListener("mouseleave", () => {
    if (dragging) {
      // 拖动中不改穿透状态：一旦变回穿透，松开鼠标的事件就再也收不到，窗口会一直粘着光标
      scheduleLeaveEnd();
      return;
    }
    if (pointerInside) {
      pointerInside = false;
      api.ui.pointer({ inside: false });
    }
  });

  // 首次上报：图已缓存时 load 事件不会再触发，这里主动量一次（T2.2）
  autoGrowInput();

  // 就绪标记：上面的监听器挂完才算「能收输入」。冒烟脚本靠它避免
  // 在监听器挂上之前发消息（T1.13a 踩过的竞态：心跳先亮绿，监听器后挂）。
  document.body.dataset.ready = "1";
}

void main();
