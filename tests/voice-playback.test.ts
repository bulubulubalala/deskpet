/**
 * 文件职责：播放队列的单测（T1.12b）——串行播放、打断丢弃、单句失败不断链。
 *
 * 为什么用假 sink：真机验的是「有没有声音」，这里验的是「队列还对不对」；
 * 打断后还能不能接着播，是常开麦下最容易出错的一环。
 * 依赖方向：tests -> app/renderer/voice-playback（只依赖注入的 AudioSink 接口）。
 */

import { describe, expect, it } from "vitest";

import { PlaybackQueue, type AudioSink } from "../app/renderer/voice-playback";

/** 假播放器：记录播过的字节、可以停在「正在播」，由测试手动结束。 */
class FakeSink implements AudioSink {
  readonly played: number[] = [];
  stops = 0;
  failNext: Error | null = null;
  private resolvers: (() => void)[] = [];

  async play(wav: Uint8Array): Promise<void> {
    this.played.push(wav[0] ?? 0);
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  stop(): void {
    this.stops += 1;
    this.finishAll();
  }

  finishAll(): void {
    const pending = this.resolvers;
    this.resolvers = [];
    for (const resolve of pending) {
      resolve();
    }
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function wav(marker: number): Uint8Array {
  return new Uint8Array([marker]);
}

describe("PlaybackQueue", () => {
  it("排队串行播放：上一句播完才开下一句", async () => {
    const sink = new FakeSink();
    const queue = new PlaybackQueue(sink);
    queue.enqueue(wav(1));
    queue.enqueue(wav(2));
    await settle();
    expect(sink.played).toEqual([1]);
    expect(queue.pending).toBe(2);

    sink.finishAll();
    await settle();
    expect(sink.played).toEqual([1, 2]);
    sink.finishAll();
    await settle();
    expect(queue.pending).toBe(0);
  });

  it("打断：停掉在播的那段，排队的全部作废", async () => {
    const sink = new FakeSink();
    const queue = new PlaybackQueue(sink);
    queue.enqueue(wav(1));
    queue.enqueue(wav(2));
    queue.enqueue(wav(3));
    await settle();
    expect(sink.played).toEqual([1]);

    expect(queue.interrupt()).toBe(3);
    expect(sink.stops).toBe(1);
    sink.finishAll();
    await settle();
    expect(sink.played).toEqual([1]);
    expect(queue.pending).toBe(0);
  });

  it("打断之后还能继续播新的一句", async () => {
    const sink = new FakeSink();
    const queue = new PlaybackQueue(sink);
    queue.enqueue(wav(1));
    await settle();
    queue.interrupt();
    queue.enqueue(wav(4));
    await settle();
    expect(sink.played).toEqual([1, 4]);
    sink.finishAll();
  });

  it("单句播放失败只上报，不挡后面的句子", async () => {
    const sink = new FakeSink();
    const errors: unknown[] = [];
    const queue = new PlaybackQueue(sink, {
      onError: (error: unknown) => errors.push(error),
    });
    sink.failNext = new Error("坏音频");
    queue.enqueue(wav(7));
    await settle();
    expect(errors).toHaveLength(1);

    queue.enqueue(wav(8));
    await settle();
    expect(sink.played).toEqual([7, 8]);
    sink.finishAll();
    await settle();
    expect(queue.pending).toBe(0);
  });
});
