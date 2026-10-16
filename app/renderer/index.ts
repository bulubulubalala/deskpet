/**
 * 文件职责：桌宠主窗渲染层——立绘 + 聊天条，把主进程推来的状态画上去（F11 / §6.11）。
 *
 * 为什么没有标题栏与状态面板：F11 规定桌面只有人和一条输入栏，模块健康收成聊天条旁的小圆点；
 * 端口 / pid / 模块明细都搬进设置窗，这里只负责「能聊天、能打断、能换角色、能开设置」。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 * 写入一律用 textContent / createElement，不用 innerHTML（注入防线，需求 §7.4）。
 */
import type { HealthView } from "../main/engine";
import type { CharacterSummary, ChatEventEnvelope, UiStatePayload } from "../main/ipc";
import type { DeskpetApi } from "../preload/api";

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

/** 台词气泡：角色说话用普通样式，技术错误用错误样式，两者永远是两块不同的文字（§6.7）。 */
function showBubble(speaker: string, text: string, isError: boolean): void {
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
  // 一轮真正结束以「主进程说空闲」为准，而不是流结束：合成收尾期间主进程仍会拒绝新的一句，
  // 界面若提前把打断按钮灰掉，用户按 Enter 只会收到「上一轮还没说完」（T1.13a 冒烟发现的问题）。
  if (state === "idle" && !wasIdle) {
    setTurnActive(false);
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

async function selectCharacter(character: CharacterSummary): Promise<void> {
  activeCharId = character.char_id;
  activeCharName = character.display_name;
  hideCharacterPopup();
  await api.ui.setState({ char_id: character.char_id });
  showBubble("系统", "已切换到 " + character.display_name, true);
}

function hideCharacterPopup(): void {
  const popup = byId("char-popup");
  if (popup !== null) {
    popup.hidden = true;
  }
}

async function sendCurrentLine(): Promise<void> {
  const input = byId("chat-input");
  if (!(input instanceof HTMLInputElement)) {
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
  setTurnActive(true);
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
  }
}

function handleChatEvent(envelope: ChatEventEnvelope): void {
  const event = envelope.event;
  switch (event.t) {
    case "s": {
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
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const inside = target !== null && target.closest("[data-interactive]") !== null;
  if (inside === pointerInside) {
    return;
  }
  pointerInside = inside;
  api.ui.pointer({ inside });
}

/** 拖动把手上的角色名：窗口没标题栏，这条把手是唯一的窗口标识（F11）。 */
function renderGrip(name: string): void {
  const node = byId("grip-name");
  if (node !== null) {
    node.textContent = name;
  }
}

function applyUiState(state: UiStatePayload): void {
  if (state.char_id !== null && state.char_id !== activeCharId) {
    activeCharId = state.char_id;
    const name = characterNames.get(state.char_id);
    if (name !== undefined) {
      activeCharName = name;
      renderGrip(name);
    }
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
    const current =
      characters.find((character) => character.char_id === state.char_id) ?? characters[0];
    if (current !== undefined) {
      activeCharId = current.char_id;
      activeCharName = current.display_name;
      renderGrip(activeCharName);
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

  const input = byId("chat-input");
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void sendCurrentLine();
    }
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

  document.addEventListener("mousemove", trackPointer);
  document.addEventListener("mouseleave", () => {
    if (pointerInside) {
      pointerInside = false;
      api.ui.pointer({ inside: false });
    }
  });

  // 就绪标记：上面的监听器挂完才算「能收输入」。冒烟脚本靠它避免
  // 在监听器挂上之前发消息（T1.13a 踩过的竞态：心跳先亮绿，监听器后挂）。
  document.body.dataset.ready = "1";
}

void main();
