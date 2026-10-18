/**
 * 文件职责：语音链路的纯数据换算——重采样到 16 kHz、封成 16bit 小端 PCM、短时能量。
 *
 * 为什么采样率定死 16 kHz：sidecar 的 /asr 收裸 PCM（不带 wav 头，§3.4 不依赖 ffmpeg），
 * 浏览器 AudioContext 通常是 48 kHz；换算放在渲染层，主进程与 sidecar 都不用碰音频格式。
 * 依赖方向：renderer 内部纯函数，不 import DOM / WebAudio / window.deskpet，可直接单测。
 */

/** sidecar /asr 与 faster-whisper 用的采样率。 */
export const ASR_SAMPLE_RATE = 16000;

/**
 * 线性插值重采样到 16 kHz。
 *
 * 为什么不用 OfflineAudioContext：那是浏览器 API，而这段换算要能单测；ASR 也不挑音质。
 */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (!(inputRate > 0) || input.length === 0) {
    return new Float32Array(0);
  }
  if (inputRate === ASR_SAMPLE_RATE) {
    return input.slice();
  }
  const ratio = inputRate / ASR_SAMPLE_RATE;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const a = input[left] ?? 0;
    const b = input[right] ?? 0;
    out[i] = a + (b - a) * (position - left);
  }
  return out;
}

/** 浮点 [-1,1] → 16bit 小端 PCM；越界夹紧（浏览器给的浮点可能略超 1）。 */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(value * 32767), true);
  }
  return bytes;
}

/** 采样数 → 毫秒；日志、验收脚本与 VAD 断句都用它。 */
export function durationMsOf(sampleCount: number, sampleRate: number = ASR_SAMPLE_RATE): number {
  return sampleRate > 0 ? (sampleCount / sampleRate) * 1000 : 0;
}

/** 短时能量（RMS）：VAD 的唯一判据，全静音是 0。 */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / frame.length);
}

/** 把若干块拼成一段（VAD 攒完整句后一次成段）。 */
export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
