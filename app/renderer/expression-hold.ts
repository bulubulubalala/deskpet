/**
 * 文件职责：本地触摸表情的「短持有」——先亮一下，到点自动撤；模型情绪到达时立刻让位。
 *
 * 为什么单独一个类：触摸反应是本地即时反馈（500–700ms），台词情绪来自模型，
 * 两者会撞车。裸 setTimeout 的问题是它会把后来模型设的表情也清掉，
 * 所以这里用代次（token）保证「只有我那次 hold 的定时器才有权撤表情」。
 * 谁调用：app/renderer/index.ts。
 */

export class ExpressionHold {
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly apply: (tag: string | null, intensity?: number) => void) {}

  /** 亮一个表情，ttlMs 后自动撤（期间没有新的 hold / cancel 才撤）。 */
  hold(tag: string, ttlMs: number, intensity = 0.6): void {
    this.clearTimer();
    this.token += 1;
    const token = this.token;
    this.apply(tag, intensity);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.token !== token) {
        return;
      }
      this.apply(null);
    }, ttlMs);
  }

  /**
   * 让位给模型情绪：只撤定时器，不清表情——
   * 调用方紧接着就要 setExpression(模型情绪)，这里再清一次只会多闪一帧。
   */
  cancel(): void {
    this.token += 1;
    this.clearTimer();
  }

  dispose(): void {
    this.cancel();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
