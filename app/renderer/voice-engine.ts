/**
 * 文件职责：渲染层的音频设备层——常开麦采集（getUserMedia + AEC）、端点检测、WAV 播放（D20）。
 *
 * 这一层只管「声音进 / 声音出」：整句说话交给回调，播放请求排队；ASR、聊天、状态机全在
 * index.ts 的编排里（这里不 import window.deskpet，方便替换与单测）。
 * 为什么用 ScriptProcessorNode：AudioWorklet 需要额外的 worklet 文件与构建产物，而本项目
 * 的 esbuild 只打三个入口；这里只在 16 kHz 上做算术，2048 帧 ≈ 43 ms 一次，主线程足够。
 * 依赖方向：renderer 内部；audio-codec / voice-vad / voice-playback 是纯逻辑。
 */
import { downsampleTo16k, floatToPcm16 } from "./audio-codec";
import { DEFAULT_VAD, UtteranceSegmenter } from "./voice-vad";
import { PlaybackQueue, type AudioSink } from "./voice-playback";

export interface VoiceEngineCallbacks {
  /** 检测到用户开口：编排层据此立刻停播 + 作废在途生成（<200 ms 的打断入口）。 */
  onSpeechStart(): void;
  /** 一整句说完了（16 kHz / 16bit / 小端 / 单声道裸 PCM）。 */
  onUtterance(pcm: Uint8Array, durationMs: number): void;
  /** 太短的响声被丢掉了（咳嗽 / 敲桌子），不是错误。 */
  onDiscarded(durationMs: number): void;
  /** 出错了：消息是给用户看的中文提示。 */
  onError(userHint: string): void;
  /** 收音开关变化（界面据此点亮麦克风按钮）。 */
  onListening(active: boolean): void;
}

/** ScriptProcessor 的缓冲：2048 帧 @48 kHz ≈ 43 ms，够快也不至于把主线程打满。 */
const CAPTURE_BUFFER_SIZE = 2048;

/** WebAudio 播放器：一段一段播，stop() 立刻掐断。 */
class WebAudioSink implements AudioSink {
  private current: AudioBufferSourceNode | null = null;

  constructor(private readonly context: () => AudioContext) {}

  async play(wav: Uint8Array): Promise<void> {
    const ctx = this.context();
    // decodeAudioData 会「拿走」这块 buffer，复制一份免得动到 IPC 送来的原始数据
    const copy = new ArrayBuffer(wav.byteLength);
    new Uint8Array(copy).set(wav);
    const buffer = await ctx.decodeAudioData(copy);
    await new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (this.current === source) {
          this.current = null;
        }
        resolve();
      };
      this.current = source;
      source.start();
    });
  }

  stop(): void {
    const source = this.current;
    this.current = null;
    if (source !== null) {
      try {
        source.stop();
      } catch {
        // 已经自己播完了：stop() 会抛 InvalidStateError，忽略
      }
    }
  }
}

/** 麦克风打不开时的中文提示：权限 / 没设备 / 被占用三种最常见。 */
function captureHint(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "麦克风权限被拒绝：在系统设置里允许 deskpet 使用麦克风，或者先用打字。";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "没有找到可用的麦克风设备。";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "麦克风被别的程序占用了（会议 / 录音软件），关掉再用。";
  }
  return "打不开麦克风：" + String(error);
}

export class VoiceEngine {
  private readonly segmenter = new UtteranceSegmenter(DEFAULT_VAD);
  private readonly queue: PlaybackQueue;
  private readonly sink: WebAudioSink;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private gain: GainNode | null = null;

  constructor(private readonly callbacks: VoiceEngineCallbacks) {
    this.sink = new WebAudioSink(() => this.ensureContext());
    this.queue = new PlaybackQueue(this.sink, {
      onError: (error: unknown) => this.callbacks.onError("播放语音失败：" + String(error)),
    });
  }

  get listening(): boolean {
    return this.stream !== null;
  }

  get pendingAudio(): number {
    return this.queue.pending;
  }

  /** 音频上下文要用户手势才能出声：任一次点击 / 按键都调它（幂等）。 */
  unlockAudio(): void {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
  }

  enqueueAudio(wav: Uint8Array): void {
    this.queue.enqueue(wav);
  }

  /** 停播并丢掉排队的音频；返回丢掉的数量（含正在播的那段）。 */
  interrupt(): number {
    return this.queue.interrupt();
  }

  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
      this.callbacks.onError("这个运行环境拿不到麦克风（mediaDevices 不可用），只能用打字。");
      return;
    }
    let stream: MediaStream;
    try {
      // AEC / 降噪 / 自动增益交给 Chromium（D1 选 Electron 的原因，D20 常开麦的前提）
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error: unknown) {
      this.callbacks.onError(captureHint(error));
      return;
    }
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // 录音不需要出声，resume 失败不拦
      }
    }
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
    const gain = ctx.createGain();
    gain.gain.value = 0; // 必须连到 destination 才会被驱动，但绝不能把麦克风原声放出来
    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      this.handleChunk(event.inputBuffer.getChannelData(0), ctx.sampleRate);
    };
    this.source.connect(processor);
    processor.connect(gain);
    gain.connect(ctx.destination);
    this.processor = processor;
    this.gain = gain;
    this.segmenter.reset();
    this.callbacks.onListening(true);
  }

  stop(): void {
    if (!this.listening) {
      return;
    }
    if (this.processor !== null) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.gain?.disconnect();
    this.gain = null;
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
    this.segmenter.reset();
    this.interrupt();
    this.callbacks.onListening(false);
  }

  private ensureContext(): AudioContext {
    if (this.context === null) {
      this.context = new AudioContext();
    }
    return this.context;
  }

  private handleChunk(input: Float32Array, sampleRate: number): void {
    const chunk = downsampleTo16k(input, sampleRate);
    for (const event of this.segmenter.push(chunk)) {
      if (event.kind === "speech_start") {
        this.callbacks.onSpeechStart();
      } else if (event.kind === "utterance") {
        this.callbacks.onUtterance(floatToPcm16(event.samples), event.durationMs);
      } else {
        this.callbacks.onDiscarded(event.durationMs);
      }
    }
  }
}
