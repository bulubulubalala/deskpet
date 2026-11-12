/**
 * 文件职责：微信式聊天记录面板——用户 / 角色 / 系统气泡、淡入淡出、自动滚动与互动模式隐藏（T2.27）。
 *
 * 为什么单独一个模块：气泡的增删、合并、裁剪和动画都在这里；index.ts 只关心「什么时候说了一句」。
 * 兼容性：最新一条非用户气泡仍带 id `bubble` / `bubble-text` / `bubble-speaker`，
 * 现有冒烟脚本（scripts/lib/cdp.mjs）不用改判据。
 * 依赖方向：renderer 内部；chat-log（纯数据）+ DOM。
 */
import type { ErrorDetail } from "../shared/contracts/ipc";
import { ChatLog, type ChatEntry } from "./chat-log";

const LEAVE_MS = 180;
const TRANSIENT_MS = 8000;
/** 离底部这么近时新消息自动滚到底；用户翻看历史时不打断（px）。 */
const NEAR_BOTTOM_PX = 48;

interface MessageNode {
  readonly node: HTMLElement;
  readonly text: HTMLElement;
  readonly speaker: HTMLElement | null;
}

export interface ChatStreamOptions {
  readonly maxEntries?: number;
  readonly transientMs?: number;
  /** 错误气泡上的「详情」按钮：由 index.ts 打开弹窗，聊天记录本身不认识弹窗。 */
  readonly onShowErrorDetail?: (detail: ErrorDetail, hint: string, code: string) => void;
  /** 消息增删 / 清空后触发，供主窗更新「回到底部」提示。 */
  readonly onChanged?: () => void;
}

export class ChatStream {
  private readonly log: ChatLog;
  private readonly nodes = new Map<number, MessageNode>();
  private readonly transientTimers = new Map<number, number>();
  private readonly transientMs: number;
  private readonly onShowErrorDetail: ChatStreamOptions["onShowErrorDetail"];
  private readonly onChanged: ChatStreamOptions["onChanged"];
  private thinkingNode: HTMLElement | null = null;
  private thinkingTimer: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly list: HTMLElement,
    options: ChatStreamOptions = {},
  ) {
    this.log =
      options.maxEntries === undefined
        ? new ChatLog()
        : new ChatLog({ maxEntries: options.maxEntries });
    this.transientMs = options.transientMs ?? TRANSIENT_MS;
    this.onShowErrorDetail = options.onShowErrorDetail;
    this.onChanged = options.onChanged;
  }

  get size(): number {
    return this.log.size;
  }

  appendUser(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    this.stopThinking();
    const entry = this.log.appendUser(trimmed);
    this.render(entry);
    this.prune();
  }

  /** 新一轮角色回复：下一句一定新建气泡，不与上一轮合并。 */
  startAssistantTurn(): void {
    this.log.startAssistantTurn();
  }

  appendAssistant(text: string, speaker: string): void {
    if (text === "") {
      return;
    }
    this.stopThinking();
    const entry = this.log.appendAssistant(text, speaker);
    const existing = this.nodes.get(entry.id);
    if (existing === undefined) {
      this.render(entry);
    } else {
      existing.text.textContent = entry.text;
      // 合并多句时把 #bubble 留在角色气泡上：中途插进来的系统提示不应该抢走冒烟判据
      this.takeBubbleIds(existing.node, existing.text, existing.speaker);
      this.scrollToBottom(false);
      this.notifyChanged();
    }
    this.setStreaming(true);
    this.prune();
  }

  /**
   * 系统提示 / 错误。
   *
   * transient=true 用于「已切换到…」这类噪音，8 秒后淡出并从记录里删除；
   * error=true 用错误配色，并结束当前角色轮。
   */
  appendSystem(
    text: string,
    options: {
      speaker?: string;
      error?: boolean;
      transient?: boolean;
      detail?: ErrorDetail;
      code?: string;
    } = {},
  ): void {
    this.stopThinking();
    const entry = this.log.appendSystem(
      text,
      options.speaker ?? "系统",
      options.error ?? false,
      options.detail,
      options.code,
    );
    this.render(entry);
    this.prune();
    if (options.transient) {
      this.scheduleTransient(entry.id);
    }
  }

  /**
   * 「在想」占位气泡：只循环 1→2→3 个·，不进聊天记录；第一句真台词到达时被替换。
   * 与旧实现一样保留 `thinking` class 和 bubble 文本 id，冒烟脚本可直接读取。
   */
  showThinking(speaker: string, dots: readonly string[], tickMs: number): void {
    const sample = dots[0] ?? "·";
    if (this.thinkingNode !== null) {
      // 主进程可能在一次发送里连续推两次 thinking：复用现有点，别闪一下再重建
      if (this.thinkingTimer !== null) {
        window.clearInterval(this.thinkingTimer);
      }
      const existingSpeaker = this.thinkingNode.querySelector<HTMLElement>(".msg-speaker");
      const existingText = this.thinkingNode.querySelector<HTMLElement>(".msg-text");
      if (existingSpeaker !== null) {
        existingSpeaker.textContent = speaker;
      }
      if (existingText !== null) {
        existingText.textContent = sample;
      }
      this.startThinkingTicker(existingText, dots, sample, tickMs);
      return;
    }
    this.stopThinking();
    this.log.startAssistantTurn();
    const node = document.createElement("div");
    node.className = "msg assistant thinking msg-new";
    const speakerNode = document.createElement("span");
    speakerNode.className = "msg-speaker";
    speakerNode.textContent = speaker;
    const textNode = document.createElement("span");
    textNode.className = "msg-text";
    textNode.textContent = sample;
    node.append(speakerNode, textNode);
    this.takeBubbleIds(node, textNode, speakerNode);
    this.list.append(node);
    this.show();
    this.scrollToBottom(true);
    this.startThinkingTicker(textNode, dots, sample, tickMs);
    this.thinkingNode = node;
    this.notifyChanged();
  }

  private startThinkingTicker(
    textNode: HTMLElement | null,
    dots: readonly string[],
    sample: string,
    tickMs: number,
  ): void {
    let step = 0;
    this.thinkingTimer = window.setInterval(() => {
      step = (step + 1) % Math.max(1, dots.length);
      if (textNode !== null) {
        textNode.textContent = dots[step] ?? sample;
      }
    }, tickMs);
  }

  /** 收掉思考气泡；真实台词 / 报错 / 打断 / 一轮结束都会调。 */
  stopThinking(): void {
    if (this.thinkingTimer !== null) {
      window.clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
    if (this.thinkingNode !== null) {
      this.thinkingNode.remove();
      this.thinkingNode = null;
      this.syncLatestIds();
      this.hideIfEmpty();
      this.notifyChanged();
    }
  }

  /** 切角色：整块淡出并清空；迟到的淡出定时器不会删掉新角色的消息。 */
  clear(): void {
    this.stopThinking();
    for (const timer of this.transientTimers.values()) {
      window.clearTimeout(timer);
    }
    this.transientTimers.clear();
    const oldNodes = Array.from(this.list.children);
    this.log.clear();
    this.nodes.clear();
    if (oldNodes.length === 0) {
      this.root.hidden = true;
      this.notifyChanged();
      return;
    }
    for (const node of oldNodes) {
      node.classList.add("msg-leaving");
    }
    window.setTimeout(() => {
      for (const node of oldNodes) {
        node.remove();
      }
      this.hideIfEmpty();
      this.syncLatestIds();
      this.notifyChanged();
    }, LEAVE_MS);
  }

  private render(entry: ChatEntry): void {
    const entries = this.log.entries;
    const index = entries.findIndex((item) => item.id === entry.id);
    const previous = index > 0 ? entries[index - 1] : undefined;
    const groupStart = previous === undefined || previous.role !== entry.role;
    const node = document.createElement("div");
    const roleClass = entry.role === "user" ? "user" : entry.role;
    node.className =
      "msg " +
      roleClass +
      (entry.error ? " error" : "") +
      (groupStart ? " group-start" : "") +
      " msg-new";
    node.dataset["messageId"] = String(entry.id);

    let speakerNode: HTMLElement | null = null;
    if (entry.role !== "user" && entry.speaker !== "") {
      speakerNode = document.createElement("span");
      speakerNode.className = "msg-speaker";
      speakerNode.textContent = entry.speaker;
      node.append(speakerNode);
    }
    const textNode = document.createElement("span");
    textNode.className = "msg-text";
    textNode.textContent = entry.text;
    node.append(textNode);

    if (entry.error && entry.detail !== undefined) {
      const detail = entry.detail;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "msg-detail";
      button.textContent = "详情";
      button.title = "查看这次错误的原文与状态码";
      button.addEventListener("click", () => {
        this.onShowErrorDetail?.(detail, entry.text, entry.code ?? "");
      });
      node.append(button);
    }

    if (entry.role !== "user") {
      this.takeBubbleIds(node, textNode, speakerNode);
    }
    this.nodes.set(entry.id, { node, text: textNode, speaker: speakerNode });
    this.list.append(node);
    this.show();
    this.scrollToBottom(true);
    this.notifyChanged();
  }

  /** 当前角色气泡的流式光标；一轮结束 / 报错 / 打断时关掉。 */
  setStreaming(active: boolean): void {
    const nodes = this.list.querySelectorAll<HTMLElement>(".msg.assistant");
    const last = nodes[nodes.length - 1];
    last?.classList.toggle("streaming", active);
  }

  /** 回到底部：聊天条上的「最新」按钮用。 */
  scrollToLatest(): void {
    this.scrollToBottom(true);
    this.notifyChanged();
  }

  private notifyChanged(): void {
    this.onChanged?.();
  }

  private prune(): void {
    for (const entry of this.log.prune()) {
      this.removeEntry(entry.id, true);
    }
  }

  private scheduleTransient(id: number): void {
    const existing = this.transientTimers.get(id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.transientTimers.delete(id);
      this.removeEntry(id, true);
    }, this.transientMs);
    this.transientTimers.set(id, timer);
  }

  private removeEntry(id: number, fade: boolean): void {
    const timer = this.transientTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.transientTimers.delete(id);
    }
    this.log.remove(id);
    const entry = this.nodes.get(id);
    if (entry === undefined) {
      return;
    }
    this.nodes.delete(id);
    if (!fade) {
      entry.node.remove();
      this.syncLatestIds();
      this.hideIfEmpty();
      this.notifyChanged();
      return;
    }
    entry.node.classList.add("msg-leaving");
    window.setTimeout(() => {
      entry.node.remove();
      this.syncLatestIds();
      this.hideIfEmpty();
      this.notifyChanged();
    }, LEAVE_MS);
  }

  /** 最新一条非用户气泡继续挂旧 id：冒烟脚本只读 `#bubble` / `#bubble-text`。 */
  private takeBubbleIds(node: HTMLElement, text: HTMLElement, speaker: HTMLElement | null): void {
    this.clearBubbleIds();
    node.id = "bubble";
    text.id = "bubble-text";
    if (speaker !== null) {
      speaker.id = "bubble-speaker";
    }
  }

  private syncLatestIds(): void {
    const nodes = this.list.querySelectorAll<HTMLElement>(".msg:not(.user):not(.msg-leaving)");
    const last = nodes[nodes.length - 1];
    if (last === undefined) {
      this.clearBubbleIds();
      return;
    }
    const text = last.querySelector<HTMLElement>(".msg-text");
    const speaker = last.querySelector<HTMLElement>(".msg-speaker");
    if (text === null) {
      this.clearBubbleIds();
      return;
    }
    this.takeBubbleIds(last, text, speaker);
  }

  private clearBubbleIds(): void {
    for (const node of Array.from(
      this.list.querySelectorAll<HTMLElement>("#bubble, #bubble-text, #bubble-speaker"),
    )) {
      node.removeAttribute("id");
    }
  }

  private show(): void {
    this.root.hidden = false;
  }

  private hideIfEmpty(): void {
    if (this.list.children.length === 0) {
      this.root.hidden = true;
    }
  }

  private scrollToBottom(force: boolean): void {
    const nearBottom =
      this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight <= NEAR_BOTTOM_PX;
    if (!force && !nearBottom) {
      return;
    }
    this.root.scrollTop = this.root.scrollHeight;
  }
}
