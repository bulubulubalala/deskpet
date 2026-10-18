/**
 * 文件职责：把主进程推来的 WAV 排队播出来，并且能立刻全停（播放侧打断，<200 ms）。
 *
 * 为什么「立刻没声音」要在渲染层做：TTS 合成晚到不如不播，用户开口时最要紧的是马上静音；
 * sidecar 那边合到哪了由主进程去作废（§6.7）。队列本身就是那层「立刻没声音」。
 * 依赖方向：纯逻辑 + 注入的 AudioSink（WebAudio 实现在 voice-engine），单测里换假实现。
 */

/** 真正的播放器；由调用方注入。 */
export interface AudioSink {
  /** 播一段 WAV；返回的 Promise 在播完后 resolve。 */
  play(wav: Uint8Array): Promise<void>;
  /** 立刻停掉当前这段（没有在播就什么都不做）。 */
  stop(): void;
}

export interface PlaybackHooks {
  /** 播放失败不让整条链断掉（一句坏了，后面还要能播）。 */
  onError?: (error: unknown) => void;
}

export class PlaybackQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private queued = 0;

  constructor(
    private readonly sink: AudioSink,
    private readonly hooks: PlaybackHooks = {},
  ) {}

  /** 排队播放：同一时刻只有一段在响，串行接下去。 */
  enqueue(wav: Uint8Array): void {
    const generation = this.generation;
    this.queued += 1;
    this.tail = this.tail
      .then(async () => {
        if (generation === this.generation) {
          await this.sink.play(wav);
        }
      })
      .catch((error: unknown) => {
        this.hooks.onError?.(error);
      })
      .finally(() => {
        // 打断过的那些条目由 interrupt() 统一清零，这里不能再减成负数
        if (generation === this.generation) {
          this.queued -= 1;
        }
      });
  }

  /** 打断：正在播的立刻停、排着的全作废；返回丢掉的数量（含正在播的那段）。 */
  interrupt(): number {
    const dropped = this.queued;
    this.generation += 1;
    this.queued = 0;
    this.sink.stop();
    this.tail = Promise.resolve();
    return dropped;
  }

  get pending(): number {
    return this.queued;
  }
}
