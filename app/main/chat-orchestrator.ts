/**
 * 文件职责：主进程的会话编排（T1.6b）——一条输入走完「LLM 流 → 逐句合成 → 推音频」，
 * 外加打断、语音状态镜像与 ASR 往返。
 *
 * 为什么需要它：sidecar 只管自己的状态机与 HTTP 契约；「播放什么时候开始/停止」只有主进程知道，
 * 所以 UI 看到的语音状态由这里维护（sidecar 的 /health.voice 是另一视角，两者不冲突）。
 * 打断的语义（§6.12）：主进程把 generation 一加，在途的 LLM 流与合成结果立刻作废，
 * 真正 <200ms 的静音发生在渲染层停播——我们不等引擎把算力付完。
 * 依赖方向：main -> ./ipc（类型）+ ./sidecar-client + ./character-voice + ./logger；不 import electron。
 * 谁调用：app/main/ipc-handlers.ts 把 IPC 通道接到这里。
 */
import {
  emotionVectorFor,
  type CharacterVoiceLoader,
  type CharacterVoiceProfile,
} from "./character-voice";
import { toErrorMessage } from "./errors";
import type {
  ChatCancelRequest,
  ChatCancelResponse,
  ChatEvent,
  ChatEventEnvelope,
  ChatSendRequest,
  ChatSendResponse,
  ChatSentenceEvent,
  TtsAudioMessage,
  VoiceState,
  VoiceStatePayload,
  VoiceStopRequest,
  VoiceStopResponse,
} from "./ipc";
import type { MainLogger } from "./logger";
import { SidecarCancelledError, SidecarHttpError, type SidecarClient } from "./sidecar-client";

/** 后台引擎不可用时的错误码：与 sidecar 的 DP-SYS 域同形（§6.7 错误码只出现在边界层）。 */
export const CODE_SYS_UNAVAILABLE = "DP-SYS-503";
/** 合成失败但引擎没给具体错误码时的兜底（保持 DP-域-三位 的形状）。 */
export const CODE_TTS_FAILED = "DP-TTS-500";
/** 连续几句合成失败才提示用户：网络抖一下就报「语音引擎异常」属于打扰（§6.7 A 级）。 */
export const TTS_FAILURE_ALERT_AFTER = 3;

export interface ChatOrchestratorDeps {
  readonly client: SidecarClient;
  readonly voice: CharacterVoiceLoader;
  readonly logger: MainLogger;
  readonly emitChatEvent: (envelope: ChatEventEnvelope) => void;
  readonly emitVoiceState: (payload: VoiceStatePayload) => void;
  readonly emitAudio: (message: TtsAudioMessage) => void;
}

export class ChatOrchestrator {
  /** 当前这一轮的取消把手；非 null 表示有在途对话。 */
  private active: AbortController | null = null;
  private sessionId = "";
  private seq = 0;
  /** 每加一次就把在途的流与合成都变成过期货（打断的唯一开关）。 */
  private generation = 0;
  /** 合成串行链：既保证音频顺序，也让「等这轮说完」有得等。 */
  private pending: Promise<void> = Promise.resolve();
  private currentRequestId: string | null = null;
  private voice: VoiceStatePayload = { state: "idle" };
  private ttsFailures = 0;

  constructor(private readonly deps: ChatOrchestratorDeps) {}

  /** 当前会话 id：热键打断时没有显式会话，用它。 */
  get session(): string {
    return this.sessionId;
  }

  getVoiceState(): VoiceStatePayload {
    return { ...this.voice };
  }

  /**
   * 发一句话：立刻返回「接没接下来」，台词与音频都走事件推送。
   * 同一时间只允许一轮，避免两轮音频交错（要连发就先打断）。
   */
  async send(request: ChatSendRequest): Promise<ChatSendResponse> {
    if (this.active !== null) {
      return {
        accepted: false,
        session_id: request.session_id,
        reason: "上一轮还没说完；先打断再发新的一句",
      };
    }
    const controller = new AbortController();
    this.active = controller;
    this.sessionId = request.session_id;
    this.seq = 0;
    this.ttsFailures = 0;
    this.pending = Promise.resolve();
    const generation = ++this.generation;
    this.setState("thinking", "正在想");
    try {
      await this.deps.client.streamChat(request, {
        signal: controller.signal,
        onEvent: (event) => {
          this.onStreamEvent(generation, request.char_id, event);
        },
      });
    } catch (error) {
      this.reportStreamFailure(error, generation);
    }
    if (generation === this.generation) {
      // 等最后一句音频推完再回 idle：否则界面先亮空闲、音频还在播（状态就不诚实了）
      await this.pending;
      this.setState("idle", "");
    }
    // active 要留到「最后一句也合成完」才清：合成期间界面仍显示在说，此时打断必须有效
    if (this.active === controller) {
      this.active = null;
    }
    return { accepted: true, session_id: request.session_id };
  }

  /** 打断：作废在途结果 + 取消未完成的合成 + 状态回 idle（§6.7 不允许停在 speaking）。 */
  async cancel(request: ChatCancelRequest): Promise<ChatCancelResponse> {
    const controller = this.active;
    if (controller === null) {
      return { cancelled: false, reason: "当前没有进行中的回复" };
    }
    this.generation += 1;
    this.pending = Promise.resolve();
    const requestId = this.currentRequestId;
    this.currentRequestId = null;
    this.active = null;
    this.setState("cancelling", "打断中");
    // 记下是谁要求打断的：多会话（角色切换）时靠它回溯是哪一路在取消
    this.deps.logger.info("chat.cancelled", "打断当前回复：" + this.sessionId, {
      module: "llm",
      fields: { session_id: request.session_id, request_id: request.request_id ?? "" },
    });
    controller.abort();
    if (requestId !== null) {
      try {
        const result = await this.deps.client.cancelTts(requestId);
        this.deps.logger.info("tts.cancelled", "已请求取消合成：" + requestId, {
          module: "tts",
          fields: { requestId, cancelled: result.cancelled },
        });
      } catch (error) {
        this.deps.logger.debug(
          "tts.cancel_failed",
          "取消合成没成功（不影响打断）：" + toErrorMessage(error),
        );
      }
    }
    this.setState("idle", "");
    return { cancelled: true };
  }

  /** 没有会话参数的打断（热键 / 托盘）：作用在当前会话上。 */
  async interrupt(): Promise<ChatCancelResponse> {
    return await this.cancel({ session_id: this.sessionId });
  }

  /** 开始收音：用户开口即打断（在途合成作废，状态显示「在听」）。 */
  async startListening(): Promise<VoiceStatePayload> {
    if (this.active !== null) {
      await this.cancel({ session_id: this.sessionId });
    }
    this.setState("listening", "正在听");
    return this.getVoiceState();
  }

  /** 结束收音：送 ASR；没听清就只回 heard=false，绝不把空文本喂给模型（§6.7）。 */
  async stopListening(request: VoiceStopRequest): Promise<VoiceStopResponse> {
    if (request.pcm.length === 0) {
      // 空 PCM = 关麦收尾：没有话要识别，但要把「在听」收回去（T2.4 常开麦，D20）
      this.setState("idle", "");
      this.deps.logger.info("voice.mic_off", "麦克风已关闭，收起在听状态");
      return { text: "", confidence: 0, heard: false };
    }
    this.setState("thinking", "正在识别");
    try {
      const result = await this.deps.client.transcribe({
        pcm: Buffer.from(request.pcm),
        sampleRate: request.sample_rate,
        requestId: request.session_id + ":asr:" + String(Date.now()),
      });
      const text = result.text.trim();
      const heard = text !== "" && result.confidence > 0;
      this.setState("idle", "");
      if (!heard) {
        this.deps.logger.info("asr.empty", "没听清：空文本或零置信度，不送模型");
      }
      return {
        text,
        confidence: result.confidence,
        heard,
        ...(result.language === null ? {} : { language: result.language }),
      };
    } catch (error) {
      this.setState("idle", "");
      this.deps.logger.warn("asr.failed", "识别失败，按没听清处理：" + toErrorMessage(error));
      return { text: "", confidence: 0, heard: false };
    }
  }

  // ---- 内部 ----

  private onStreamEvent(generation: number, charId: string, event: ChatEvent): void {
    if (generation !== this.generation) {
      return;
    }
    this.emit(event);
    if (event.t === "s") {
      this.setState("speaking", "正在说");
      const sentence: ChatSentenceEvent = event;
      this.pending = this.pending
        .then(() => this.synthesize(generation, charId, sentence))
        .catch(() => undefined);
    }
  }

  /** 逐句合成：串行排队，被打断就整条丢掉（音频晚了不如不播）。 */
  private async synthesize(
    generation: number,
    charId: string,
    sentence: ChatSentenceEvent,
  ): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    let profile: CharacterVoiceProfile;
    try {
      profile = await this.deps.voice.load(charId);
    } catch (error) {
      this.deps.logger.warn(
        "tts.profile_failed",
        "读角色音色失败，这轮按纯文字：" + toErrorMessage(error),
      );
      return;
    }
    if (profile.voiceMissing) {
      this.deps.logger.debug("tts.no_voice", "角色没有可用参考音，纯文字继续：" + charId);
      return;
    }
    const requestId = this.sessionId + ":" + String(sentence.i) + ":" + String(generation);
    this.currentRequestId = requestId;
    try {
      const result = await this.deps.client.synthesize({
        text: sentence.text,
        voiceId: profile.voiceId,
        lang: profile.lang,
        emoVector: emotionVectorFor(profile, sentence.emotion, sentence.intensity),
        requestId,
      });
      if (generation !== this.generation) {
        this.deps.logger.debug("tts.dropped", "这句在合成期间被打了断，音频丢掉：" + requestId);
        return;
      }
      this.ttsFailures = 0;
      this.deps.emitAudio({
        session_id: this.sessionId,
        request_id: result.requestId,
        text: sentence.text,
        format: "wav",
        audio: new Uint8Array(result.audio),
        gen_ms: result.genMs,
        audio_ms: result.audioMs,
        rtf: result.rtf,
      });
    } catch (error) {
      if (generation !== this.generation || error instanceof SidecarCancelledError) {
        return;
      }
      this.reportTtsFailure(error);
    } finally {
      if (this.currentRequestId === requestId) {
        this.currentRequestId = null;
      }
    }
  }

  private reportTtsFailure(error: unknown): void {
    this.ttsFailures += 1;
    const code =
      error instanceof SidecarHttpError && error.code !== "" ? error.code : CODE_TTS_FAILED;
    const hint =
      error instanceof SidecarHttpError && error.userHint !== undefined
        ? error.userHint
        : "语音引擎没出声，这一句先用文字看";
    this.deps.logger.warn(
      "tts.failed",
      "合成失败（连续第 " + String(this.ttsFailures) + " 次）：" + toErrorMessage(error),
      { module: "tts", fields: { consecutive: this.ttsFailures, code } },
    );
    // 只在第 3 次时提示一次：TTS 掉链子不该打断纯文字聊天
    if (this.ttsFailures === TTS_FAILURE_ALERT_AFTER) {
      this.emit({ t: "e", code, user_hint: hint, recoverable: true });
    }
  }

  private reportStreamFailure(error: unknown, generation: number): void {
    if (generation !== this.generation || error instanceof SidecarCancelledError) {
      return;
    }
    if (error instanceof SidecarHttpError) {
      const code = error.code === "" ? CODE_SYS_UNAVAILABLE : error.code;
      const hint = error.userHint ?? error.message;
      this.deps.logger.warn("chat.failed", "这轮对话失败：" + error.message, {
        fields: { code, status: error.status },
      });
      this.emit({ t: "e", code, user_hint: hint, recoverable: true });
    } else {
      this.deps.logger.warn("chat.unavailable", "后台引擎不可用：" + toErrorMessage(error));
      this.emit({
        t: "e",
        code: CODE_SYS_UNAVAILABLE,
        user_hint: "后台引擎当前不可用，等状态点变绿再说一句；这轮不重播",
        recoverable: true,
      });
    }
    // 一轮必须以 end 收尾（§6.2），否则渲染层会一直以为还在说
    this.emit({ t: "end" });
  }

  private emit(event: ChatEvent): void {
    this.seq += 1;
    this.deps.emitChatEvent({ session_id: this.sessionId, seq: this.seq, event });
  }

  private setState(state: VoiceState, detail: string): void {
    const next: VoiceStatePayload = detail === "" ? { state } : { state, detail };
    if (next.state === this.voice.state && next.detail === this.voice.detail) {
      return;
    }
    this.voice = next;
    this.deps.emitVoiceState(next);
  }
}
