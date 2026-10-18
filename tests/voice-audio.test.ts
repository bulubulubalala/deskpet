/**
 * 文件职责：音频采集纯逻辑的单测（T1.12b）——重采样 / PCM16 / 能量 / 端点检测。
 *
 * 为什么先钉这些：真机听不出声时，分不清是「麦克风没采到」「重采样错了」还是「VAD 没断句」；
 * 把换算与端点判定在这里钉死，真机只剩「音频设备与打断时延」两个变量。
 * 依赖方向：tests -> app/renderer/{audio-codec,voice-vad}（纯函数，不碰 DOM / WebAudio）。
 */

import { describe, expect, it } from "vitest";

import {
  ASR_SAMPLE_RATE,
  concatSamples,
  downsampleTo16k,
  durationMsOf,
  floatToPcm16,
  frameRms,
} from "../app/renderer/audio-codec";
import { DEFAULT_VAD, UtteranceSegmenter } from "../app/renderer/voice-vad";

function tone(length: number, amplitude: number, rate: number = ASR_SAMPLE_RATE): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / rate);
  }
  return out;
}

/** 毫秒 → 16 kHz 采样数；独立算式，不抄实现里的换算。 */
function samplesOf(ms: number): number {
  return Math.round((ms / 1000) * ASR_SAMPLE_RATE);
}

describe("downsampleTo16k", () => {
  it("48 kHz 降到 16 kHz 后长度是三分之一", () => {
    const input = tone(4800, 0.5, 48000);
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(1600);
    expect(Math.abs((out[100] ?? 0) - (input[300] ?? 0))).toBeLessThan(0.05);
  });

  it("本来就是 16 kHz 时原样复制，不动输入", () => {
    const input = tone(160, 0.5);
    const out = downsampleTo16k(input, ASR_SAMPLE_RATE);
    expect(Array.from(out)).toEqual(Array.from(input));
    out[0] = 9;
    expect(input[0]).not.toBe(9);
  });

  it("空输入或非法采样率给空数组，不做除零", () => {
    expect(downsampleTo16k(new Float32Array(0), 48000).length).toBe(0);
    expect(downsampleTo16k(tone(10, 0.5), 0).length).toBe(0);
  });
});

describe("floatToPcm16", () => {
  it("写 16bit 小端：0.5 映射到 0x4000", () => {
    const bytes = floatToPcm16(new Float32Array([0.5]));
    expect(bytes.length).toBe(2);
    expect(new DataView(bytes.buffer).getInt16(0, true)).toBe(16384);
  });

  it("超出 [-1,1] 的值夹紧，不绕回", () => {
    const bytes = floatToPcm16(new Float32Array([2, -2]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32767);
  });
});

describe("durationMsOf / frameRms / concatSamples", () => {
  it("采样数换算成毫秒", () => {
    expect(durationMsOf(16000)).toBe(1000);
    expect(durationMsOf(8000)).toBe(500);
  });

  it("全静音能量为 0，声音越大能量越高", () => {
    expect(frameRms(new Float32Array(100))).toBe(0);
    expect(frameRms(tone(1000, 0.5))).toBeGreaterThan(frameRms(tone(1000, 0.05)));
  });

  it("拼接保留顺序", () => {
    const joined = concatSamples([new Float32Array([1]), new Float32Array([2, 3])]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });
});

describe("UtteranceSegmenter", () => {
  it("全静音不产生任何事件", () => {
    const seg = new UtteranceSegmenter();
    expect(seg.push(new Float32Array(samplesOf(1000)))).toEqual([]);
    expect(seg.isSpeaking).toBe(false);
  });

  it("太短的响声按丢弃处理，不算说话", () => {
    const seg = new UtteranceSegmenter();
    const events = [
      ...seg.push(tone(samplesOf(100), 0.5)),
      ...seg.push(new Float32Array(samplesOf(600))),
    ];
    expect(events.map((event) => event.kind)).toEqual(["speech_start", "speech_dropped"]);
    expect(seg.isSpeaking).toBe(false);
  });

  it("说话 + 静音 → 一句话，且带上开口前的预滚", () => {
    const seg = new UtteranceSegmenter();
    const events = [
      ...seg.push(new Float32Array(samplesOf(200))), // 开口前 200ms 静音（正好是预滚上限）
      ...seg.push(tone(samplesOf(300), 0.5)),
      ...seg.push(new Float32Array(samplesOf(600))),
    ];
    expect(events.map((event) => event.kind)).toEqual(["speech_start", "utterance"]);
    const utterance = events[1];
    if (utterance === undefined || utterance.kind !== "utterance") {
      throw new Error("没有拿到 utterance");
    }
    // 200 预滚 + 300 人声 + 600 尾部静音，尾部裁到 250ms → 750ms
    expect(utterance.durationMs).toBeCloseTo(750, 6);
    expect(utterance.samples.length).toBe(samplesOf(750));
  });

  it("一直说不停时按上限强制断句", () => {
    const seg = new UtteranceSegmenter();
    const events: ReturnType<UtteranceSegmenter["push"]> = [];
    const chunk = tone(samplesOf(500), 0.5);
    for (let i = 0; i < 30; i += 1) {
      events.push(...seg.push(chunk));
    }
    expect(events.map((event) => event.kind)).toEqual(["speech_start", "utterance"]);
    const utterance = events[1];
    if (utterance === undefined || utterance.kind !== "utterance") {
      throw new Error("没有拿到 utterance");
    }
    expect(utterance.durationMs).toBeCloseTo(DEFAULT_VAD.maxUtteranceMs, 6);
    expect(seg.isSpeaking).toBe(false);
  });

  it("reset 清掉说话状态与缓冲", () => {
    const seg = new UtteranceSegmenter();
    seg.push(tone(samplesOf(300), 0.5));
    expect(seg.isSpeaking).toBe(true);
    seg.reset();
    expect(seg.isSpeaking).toBe(false);
    expect(seg.push(tone(samplesOf(300), 0.5)).map((event) => event.kind)).toEqual([
      "speech_start",
    ]);
  });
});
