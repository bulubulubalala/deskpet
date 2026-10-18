/**
 * 文件职责：常开麦的端点检测（VAD）——只判断「开始说话 / 说完了」，不判断说了什么（D20）。
 *
 * 为什么放在渲染层：常开麦时每 40 ms 就有一块音频，全发给 sidecar 既费 IPC 又费 CPU；
 * 端点检测是纯算术，就地丢静音、只把一整句 PCM 送过去。打断的实时性也靠它——
 * `speech_start` 一响编排层就停播 + 作废在途生成（<200 ms）。
 * 依赖方向：renderer 内部纯逻辑，不 import DOM / WebAudio；默认参数见 DEFAULT_VAD。
 */
import { ASR_SAMPLE_RATE, concatSamples, durationMsOf, frameRms } from "./audio-codec";

export interface VadConfig {
  /** 采样率：端点判定与毫秒换算都用它（固定 16 kHz，与 /asr 一致）。 */
  sampleRate: number;
  /** 短时能量阈值：高于它算有人声。 */
  speechRms: number;
  /** 一次说话至少这么长才算话，否则当咳嗽 / 敲桌子丢掉。 */
  minSpeechMs: number;
  /** 人声之后连续这么久的静音就认为说完了。 */
  endSilenceMs: number;
  /** 单次说话上限，超了强制断句（避免一直说把内存撑爆）。 */
  maxUtteranceMs: number;
  /** 起手留一点「开口之前」的音频，否则第一个音节常被切掉。 */
  preRollMs: number;
  /** 断句时保留的尾部静音：留一点给 ASR 收尾，多余的丢掉。 */
  keepSilenceMs: number;
}

/** 默认档：阈值偏向「宁可多送一句，也别漏掉半句」，误触发由侧车的幻觉过滤兜底（T1.4）。 */
export const DEFAULT_VAD: VadConfig = {
  sampleRate: ASR_SAMPLE_RATE,
  speechRms: 0.012,
  minSpeechMs: 250,
  endSilenceMs: 600,
  maxUtteranceMs: 15000,
  preRollMs: 200,
  keepSilenceMs: 250,
};

export type VadEvent =
  | { kind: "speech_start" }
  | { kind: "utterance"; samples: Float32Array; durationMs: number }
  | { kind: "speech_dropped"; durationMs: number };

export class UtteranceSegmenter {
  private readonly config: VadConfig;
  private speaking = false;
  private buffer: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  private bufferedSamples = 0;
  private voicedSamples = 0;
  private trailingSilence = 0;

  constructor(config: VadConfig = DEFAULT_VAD) {
    this.config = config;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** 喂一块 16 kHz 单声道浮点；只有事件发生的那一块才返回非空数组。 */
  push(chunk: Float32Array): VadEvent[] {
    if (chunk.length === 0) {
      return [];
    }
    const loud = frameRms(chunk) >= this.config.speechRms;
    if (!this.speaking) {
      if (!loud) {
        this.pushPreRoll(chunk);
        return [];
      }
      // 预滚只装「开口之前」的声音，开口这一块单独拼在后面：
      // 否则大块音频会把预滚整个顶掉，第一个音节就被切了（单测抓到过一次）
      this.speaking = true;
      this.buffer = [...this.preRoll, chunk];
      this.bufferedSamples = this.preRollSamples + chunk.length;
      this.preRoll = [];
      this.preRollSamples = 0;
      this.voicedSamples = chunk.length;
      this.trailingSilence = 0;
      return [{ kind: "speech_start" }];
    }
    this.buffer.push(chunk);
    this.bufferedSamples += chunk.length;
    if (loud) {
      this.voicedSamples += chunk.length;
      this.trailingSilence = 0;
    } else {
      this.trailingSilence += chunk.length;
    }
    const totalMs = durationMsOf(this.bufferedSamples, this.config.sampleRate);
    if (
      totalMs >= this.config.maxUtteranceMs ||
      this.trailingSilence >= this.msToSamples(this.config.endSilenceMs)
    ) {
      return [this.flush()];
    }
    return [];
  }

  reset(): void {
    this.speaking = false;
    this.buffer = [];
    this.preRoll = [];
    this.preRollSamples = 0;
    this.bufferedSamples = 0;
    this.voicedSamples = 0;
    this.trailingSilence = 0;
  }

  private flush(): VadEvent {
    const all = concatSamples(this.buffer);
    const keep = Math.min(this.trailingSilence, this.msToSamples(this.config.keepSilenceMs));
    const trim = this.trailingSilence - keep;
    const samples = trim > 0 ? all.subarray(0, all.length - trim) : all;
    const voiced = this.voicedSamples;
    const durationMs = durationMsOf(samples.length, this.config.sampleRate);
    this.reset();
    if (voiced < this.msToSamples(this.config.minSpeechMs)) {
      return { kind: "speech_dropped", durationMs };
    }
    return { kind: "utterance", samples, durationMs };
  }

  private pushPreRoll(chunk: Float32Array): void {
    const limit = this.msToSamples(this.config.preRollMs);
    // 先腾地方再放新块：预滚里只留最近 limit 个采样，开口那一刻整段带走
    while (this.preRollSamples + chunk.length > limit && this.preRoll.length > 0) {
      const dropped = this.preRoll.shift();
      this.preRollSamples -= dropped?.length ?? 0;
    }
    if (chunk.length >= limit) {
      // 单块就超过预滚上限（超大缓冲）：只留它自己，宁可少留也别切声音
      this.preRoll = [chunk];
      this.preRollSamples = chunk.length;
      return;
    }
    this.preRoll.push(chunk);
    this.preRollSamples += chunk.length;
  }

  private msToSamples(ms: number): number {
    return Math.max(1, Math.round((ms / 1000) * this.config.sampleRate));
  }
}
