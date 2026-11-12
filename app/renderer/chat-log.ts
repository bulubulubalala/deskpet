/**
 * 文件职责：聊天记录的数据模型——用户 / 角色 / 系统消息、同一轮角色多句合并、超出上限的裁剪（T2.27）。
 *
 * 为什么单独一层：气泡 DOM、淡入淡出、滚动都在 chat-stream.ts；这一层不碰 DOM，能单测
 * 「一轮多句是不是合成一个气泡」「切角色清空」「超上限先淘汰谁」这些容易回归的规则。
 * 依赖方向：renderer 内部纯逻辑。
 */

import type { ErrorDetail } from "../shared/contracts/ipc";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatEntry {
  readonly id: number;
  readonly role: ChatRole;
  readonly speaker: string;
  text: string;
  readonly error: boolean;
  /** 技术错误的可排查现场；普通系统提示没有。 */
  readonly detail?: ErrorDetail;
  /** 错误码（弹窗标题与复制用）；普通提示为空。 */
  readonly code?: string;
}

export interface ChatLogOptions {
  /** 最多保留多少条；超出后从最旧开始淘汰（T2.27 会话内保留并可滚动）。 */
  readonly maxEntries?: number;
}

export const DEFAULT_CHAT_MAX_ENTRIES = 40;

export class ChatLog {
  private nextId = 1;
  private items: ChatEntry[] = [];
  /** 当前正在追加的角色气泡；null 表示下一句要新建气泡。 */
  private currentAssistantId: number | null = null;
  private readonly maxEntries: number;

  constructor(options: ChatLogOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CHAT_MAX_ENTRIES);
  }

  get entries(): readonly ChatEntry[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  /** 用户发一句：同时结束上一轮角色气泡，下一句角色回复一定新建气泡。 */
  appendUser(text: string): ChatEntry {
    this.currentAssistantId = null;
    return this.push("user", "", text, false);
  }

  /** 新一轮开始（发出去 / 语音断句 / 主动开口）：下一句角色回复新建气泡。 */
  startAssistantTurn(): void {
    this.currentAssistantId = null;
  }

  /** 角色台词：同一轮的多句合并进一个气泡，避免每句一个小气泡刷屏。 */
  appendAssistant(text: string, speaker: string): ChatEntry {
    if (this.currentAssistantId !== null) {
      const current = this.items.find((entry) => entry.id === this.currentAssistantId);
      if (current !== undefined) {
        current.text += text;
        return current;
      }
    }
    const entry = this.push("assistant", speaker, text, false);
    this.currentAssistantId = entry.id;
    return entry;
  }

  /** 系统提示 / 错误：错误会结束当前角色轮，避免错误后的台词并进上一条。 */
  appendSystem(
    text: string,
    speaker = "系统",
    error = false,
    detail?: ErrorDetail,
    code?: string,
  ): ChatEntry {
    if (error) {
      this.currentAssistantId = null;
    }
    return this.push("system", speaker, text, error, detail, code);
  }

  remove(id: number): ChatEntry | null {
    const index = this.items.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return null;
    }
    const [removed] = this.items.splice(index, 1);
    if (removed !== undefined && removed.id === this.currentAssistantId) {
      this.currentAssistantId = null;
    }
    return removed ?? null;
  }

  /** 超过上限时从最旧开始淘汰；返回被淘汰的条目，供界面做淡出。 */
  prune(): ChatEntry[] {
    const removed: ChatEntry[] = [];
    while (this.items.length > this.maxEntries) {
      const oldest = this.items.shift();
      if (oldest === undefined) {
        break;
      }
      if (oldest.id === this.currentAssistantId) {
        this.currentAssistantId = null;
      }
      removed.push(oldest);
    }
    return removed;
  }

  clear(): void {
    this.items = [];
    this.currentAssistantId = null;
  }

  private push(
    role: ChatRole,
    speaker: string,
    text: string,
    error: boolean,
    detail?: ErrorDetail,
    code?: string,
  ): ChatEntry {
    const entry: ChatEntry = {
      id: this.nextId++,
      role,
      speaker,
      text,
      error,
      ...(detail === undefined ? {} : { detail }),
      ...(code === undefined ? {} : { code }),
    };
    this.items.push(entry);
    return entry;
  }
}
