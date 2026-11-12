/**
 * 文件职责：文字轮的收发（D1 第二期）——把一句话塞进 /ws/voice，再把 sidecar 的事件翻成界面事件。
 *
 * 为什么需要它：D1 第二期之后文字轮与语音轮共用 sidecar 的同一条编排，主进程不再自己
 * 拼 TTS、也不再自己维护语音状态；这里只做两件事：
 * 1) 文字 → 一条 `{t:"text"}` 帧（字段与 sidecar contracts/voice_ws.py 的 TextInput 对齐）；
 * 2) sidecar 的 llm.* / error → 界面一直在用的 chatEvent 信封（seq 单调递增）。
 *
 * 为什么 socket 用闭包（isOpen / sendText）而不是直接持有 VoiceSocketClient：
 * 组合根里 WS 客户端要回调到这里、这里又要把帧发回 WS 客户端，直接互相持有会形成构造顺序环。
 * 依赖方向：main -> ../shared/contracts/ipc（类型）+ ./logger + ./turn-coordinator（类型）。
 */
import type {
  ChatEvent,
  ChatEventEnvelope,
  ChatMemoryEvent,
  ChatSendRequest,
  ChatSendResponse,
  VoiceStreamEvent,
  VoiceTextInput,
} from "../shared/contracts/ipc";
import type { MainLogger } from "./logger";
import type { TurnCoordinator } from "./turn-coordinator";

/** 后台引擎不可用（与 sidecar 的 DP-SYS 域同形，§6.7 错误码只出现在边界层）。 */
export const CODE_SYS_UNAVAILABLE = "DP-SYS-503";

/** 只要「能不能发」与「发一条文字帧」，测试里给假对象即可。 */
export interface ChatTurnSocketPort {
  isOpen(): boolean;
  sendText(frame: VoiceTextInput): boolean;
}

export interface ChatTurnsDeps {
  readonly socket: ChatTurnSocketPort;
  /** 起新轮之前先取消旧轮（发 WS cancel），语义在 TurnCoordinator。 */
  readonly turn: Pick<TurnCoordinator, "startText">;
  readonly logger: MainLogger;
  readonly emitChatEvent: (envelope: ChatEventEnvelope) => void;
}

/** 文字轮是否在跑：在跑时 llm.* 归这里翻成 chatEvent，语音轮的事件照旧走 voiceEvent。 */
export class ChatTurns {
  private active = false;
  private sessionId = "";
  private seq = 0;
  /** 语音输出开关（聊天条麦克风旁）：false 时 sidecar 只出文字事件，不合成。 */
  private ttsEnabled = true;

  constructor(private readonly deps: ChatTurnsDeps) {}

  /** 当前（或最近一轮）会话 id：主动陪伴 / 截屏热键没有显式会话时沿用它。 */
  get session(): string {
    return this.sessionId;
  }

  get busy(): boolean {
    return this.active;
  }

  setTtsEnabled(enabled: boolean): void {
    this.ttsEnabled = enabled;
  }

  /**
   * 发一句话：立刻回答「接没接下来」，台词与音频走事件推送。
   *
   * 先 startText（忙时发 cancel）再发帧：sidecar 在一条连接上按顺序处理，所以旧轮一定先停，
   * 不会出现两轮音频交错。
   */
  async send(request: ChatSendRequest): Promise<ChatSendResponse> {
    if (!this.deps.socket.isOpen()) {
      this.deps.logger.debug("chat.socket_closed", "文字消息没发出去：语音长连接还没连上");
      return {
        accepted: false,
        session_id: request.session_id,
        reason: "后台引擎还没连上，等状态点变绿再发",
      };
    }
    await this.deps.turn.startText();
    this.active = true;
    this.sessionId = request.session_id;
    this.seq = 0;
    const frame: VoiceTextInput = {
      t: "text",
      session_id: request.session_id,
      char_id: request.char_id,
      text: request.text,
      tts_enabled: this.ttsEnabled,
      input_mode: request.input_mode ?? "text",
      client_ts: request.client_ts ?? Date.now(),
    };
    if (request.screen_text !== undefined) {
      frame.screen_text = request.screen_text;
    }
    if (request.interaction !== undefined) {
      frame.interaction = request.interaction;
    }
    if (request.proactive !== undefined) {
      frame.proactive = request.proactive;
    }
    if (request.proactive_kind !== undefined) {
      frame.proactive_kind = request.proactive_kind;
    }
    if (request.app_context !== undefined) {
      frame.app_context = request.app_context;
    }
    if (!this.deps.socket.sendText(frame)) {
      this.active = false;
      this.deps.logger.warn("chat.send_failed", "文字帧没写进连接：" + request.session_id);
      return {
        accepted: false,
        session_id: request.session_id,
        reason: "和后台引擎的连接断了，等状态点变绿再发",
      };
    }
    return { accepted: true, session_id: request.session_id };
  }

  /**
   * sidecar 事件进这里：是文字轮的事件就翻成 chatEvent 并返回 true（调用方别再转发 voiceEvent），
   * 否则返回 false 让语音轮照旧走 voiceEvent。
   */
  handleEvent(event: VoiceStreamEvent): boolean {
    if (!this.active) {
      return false;
    }
    switch (event.t) {
      case "llm.s":
        this.emit({
          t: "s",
          i: event.i,
          text: event.text,
          ...(event.emotion === null || event.emotion === undefined
            ? {}
            : { emotion: event.emotion }),
          intensity: event.intensity,
          ...(event.act === null || event.act === undefined ? {} : { act: event.act }),
        });
        return true;
      case "llm.m":
        this.emit({
          t: "m",
          kind: memoryKind(event.kind),
          text: event.text,
          // sidecar 的记忆事件不带重要度（由它自己算），界面也不用；这里给契约一个稳定值
          importance: 0,
        });
        return true;
      case "llm.a":
        this.emit({ t: "a", act: event.act });
        return true;
      case "llm.end":
        this.finish();
        return true;
      case "error":
        this.emit({
          t: "e",
          code: event.code,
          user_hint: event.user_hint,
          recoverable: event.recoverable ?? true,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        });
        this.finish();
        return true;
      default:
        return false;
    }
  }

  /** 取消 / 换轮：这一轮不再认领后续事件（状态仍由 sidecar 如实汇报）。 */
  abandon(): void {
    this.active = false;
  }

  /** 连接断了：这一轮不会再有事件，给界面一个明确的收尾（错误 + end）。 */
  onSocketClosed(): void {
    if (!this.active) {
      return;
    }
    this.deps.logger.warn("chat.socket_lost", "文字轮中途断线：" + this.sessionId);
    this.emit({
      t: "e",
      code: CODE_SYS_UNAVAILABLE,
      user_hint: "和后台引擎的连接断了；这一轮没说完，再发一次。",
      recoverable: true,
      detail: {
        message: "本轮进行中，主进程与 sidecar 的 WebSocket 已断开",
        attempts: 0,
      },
    });
    this.finish();
  }

  /** 一轮以 end 收尾（§6.2）：否则界面会一直以为还在说。 */
  private finish(): void {
    if (!this.active) {
      return;
    }
    this.emit({ t: "end" });
    this.active = false;
  }

  private emit(event: ChatEvent): void {
    this.seq += 1;
    this.deps.emitChatEvent({ session_id: this.sessionId, seq: this.seq, event });
  }
}

/** sidecar 的记忆 kind 是开放字符串，界面契约只认三种；其余按「事实」处理。 */
function memoryKind(kind: string): ChatMemoryEvent["kind"] {
  return kind === "preference" || kind === "event" ? kind : "fact";
}
