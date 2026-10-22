/**
 * 文件职责：主进程侧的 /ws/voice 客户端（P2）——把渲染层的音频块送上去，把事件/音频接下来。
 *
 * 为什么不用 HTTP：全双工要的是「一条连接里同时有音频上行、事件下行、合成音频下行、取消」，
 * 一组一次性的 POST 做不到低延迟取消；WS 还能让 sidecar 自己把识别→生成→合成串起来。
 * 依赖方向：main -> ./logger + ./ipc（只 import 类型）；不碰 electron 窗口。
 * 谁调用：app/main/index.ts 装配，端点跟随心跳（与 SidecarClient 同一处同步）。
 *
 * token 放在查询串：WS 的浏览器/Node 客户端不能自定义请求头；sidecar 只监听回环且 token
 * 每进程随机，所以可接受。**日志里绝不打印带 token 的 URL。**
 */

import type { TtsChunkMeta, VoiceStreamEvent } from "./ipc";
import type { MainLogger } from "./logger";

/** 连接 sidecar 需要的三样东西（来自 runtime.json）。 */
export interface VoiceSocketEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

/** sidecar 推送的语音事件（state / tts.audio 之外的都在这里）。 */
export interface VoiceSocketCallbacks {
  onEvent(event: VoiceStreamEvent): void;
  onState(state: string): void;
  onAudio(meta: TtsChunkMeta, audio: Uint8Array): void;
}

/** 断线重连间隔：心跳恢复后端点会被重新 setEndpoint，这里只兜住偶发断开。 */
const RECONNECT_DELAY_MS = 1000;

export class VoiceSocketClient {
  private socket: WebSocket | null = null;
  private endpoint: VoiceSocketEndpoint | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAudio: TtsChunkMeta | null = null;
  private closed = false;

  constructor(
    private readonly logger: MainLogger,
    private readonly callbacks: VoiceSocketCallbacks,
  ) {}

  /** 心跳在线时更新端点；参数没变就不重连（避免每次心跳都抖动）。 */
  setEndpoint(endpoint: VoiceSocketEndpoint): void {
    const current = this.endpoint;
    if (
      current !== null &&
      current.host === endpoint.host &&
      current.port === endpoint.port &&
      current.token === endpoint.token
    ) {
      return;
    }
    this.endpoint = endpoint;
    this.connect();
  }

  clearEndpoint(): void {
    this.endpoint = null;
    this.disconnect();
  }

  /** 应用退出：不再重连。 */
  close(): void {
    this.closed = true;
    this.clearEndpoint();
  }

  begin(request: {
    session_id: string;
    char_id: string;
    sample_rate: number;
    tts_enabled: boolean;
  }): void {
    this.sendJson({
      t: "audio.start",
      session_id: request.session_id,
      char_id: request.char_id,
      sample_rate: request.sample_rate,
      tts_enabled: request.tts_enabled,
    });
  }

  sendAudio(pcm: Uint8Array): void {
    if (pcm.byteLength === 0) {
      return;
    }
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(pcm);
  }

  end(request: { session_id: string; char_id: string }): void {
    this.sendJson({ t: "audio.end", session_id: request.session_id, char_id: request.char_id });
  }

  cancel(): void {
    this.sendJson({ t: "cancel" });
  }

  private connect(): void {
    this.disconnect();
    const endpoint = this.endpoint;
    if (endpoint === null || this.closed) {
      return;
    }
    const url =
      "ws://" +
      endpoint.host +
      ":" +
      String(endpoint.port) +
      "/ws/voice?token=" +
      encodeURIComponent(endpoint.token);
    // 只记 host:port：URL 里带 token，绝不能进日志
    const label = endpoint.host + ":" + String(endpoint.port);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error: unknown) {
      this.logger.warn("voice.ws_connect_failed", "语音 WebSocket 建连失败：" + label, {
        error: String(error),
      });
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      this.logger.info("voice.ws_open", "语音 WebSocket 已连接：" + label);
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.logger.debug("voice.ws_closed", "语音 WebSocket 断开：" + label);
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // 具体原因通常由随后的 close 事件体现，这里只留一条
      this.logger.warn("voice.ws_error", "语音 WebSocket 出错：" + label);
    });
    this.socket = socket;
  }

  private disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.pendingAudio = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // 已经关了：忽略
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.endpoint === null || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      this.handleText(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      const meta = this.pendingAudio;
      this.pendingAudio = null;
      if (meta !== null) {
        this.callbacks.onAudio(meta, new Uint8Array(data));
      }
    }
  }

  private handleText(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const event = parsed as Record<string, unknown>;
    const kind = typeof event["t"] === "string" ? event["t"] : "";
    if (kind === "state") {
      const state = typeof event["state"] === "string" ? event["state"] : "idle";
      this.callbacks.onState(state);
      return;
    }
    if (kind === "tts.audio") {
      this.pendingAudio = toMeta(event);
      return;
    }
    if (kind === "") {
      return;
    }
    this.callbacks.onEvent(parsed as VoiceStreamEvent);
  }

  private sendJson(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }
}

/** 把服务端 tts.audio 的 JSON 收窄成类型安全的元数据（坏字段给安全默认值）。 */
function toMeta(event: Record<string, unknown>): TtsChunkMeta {
  const format = event["format"] === "mp3" ? "mp3" : "wav";
  return {
    request_id: typeof event["request_id"] === "string" ? event["request_id"] : "",
    text: typeof event["text"] === "string" ? event["text"] : "",
    format,
    seq: typeof event["seq"] === "number" ? event["seq"] : 0,
    final: event["final"] !== false,
    gen_ms: typeof event["gen_ms"] === "number" ? event["gen_ms"] : 0,
    audio_ms: typeof event["audio_ms"] === "number" ? event["audio_ms"] : 0,
    rtf: typeof event["rtf"] === "number" ? event["rtf"] : 0,
  };
}
