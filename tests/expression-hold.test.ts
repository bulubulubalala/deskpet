/**
 * 文件职责：本地触摸表情的短持有单测（T2.31）。
 *
 * 关键回归：到点必须撤；模型情绪到达（cancel）之后，旧定时器不许再把表情清掉。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExpressionHold } from "../app/renderer/expression-hold";

afterEach(() => {
  vi.useRealTimers();
});

describe("ExpressionHold", () => {
  it("立刻亮表情，到点自动撤", () => {
    vi.useFakeTimers();
    const calls: (string | null)[] = [];
    const hold = new ExpressionHold((tag) => calls.push(tag));
    hold.hold("喜", 600);
    expect(calls).toEqual(["喜"]);
    vi.advanceTimersByTime(599);
    expect(calls).toEqual(["喜"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["喜", null]);
    hold.dispose();
  });

  it("cancel 之后定时器不再撤（模型表情要留着）", () => {
    vi.useFakeTimers();
    const calls: (string | null)[] = [];
    const hold = new ExpressionHold((tag) => calls.push(tag));
    hold.hold("喜", 600);
    hold.cancel();
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(["喜"]);
    hold.dispose();
  });

  it("新的 hold 覆盖旧的：只撤最新那次", () => {
    vi.useFakeTimers();
    const calls: (string | null)[] = [];
    const hold = new ExpressionHold((tag) => calls.push(tag));
    hold.hold("喜", 600);
    vi.advanceTimersByTime(300);
    hold.hold("惊喜", 600);
    vi.advanceTimersByTime(400);
    expect(calls).toEqual(["喜", "惊喜"]);
    vi.advanceTimersByTime(200);
    expect(calls).toEqual(["喜", "惊喜", null]);
    hold.dispose();
  });

  it("dispose 之后不会再回调", () => {
    vi.useFakeTimers();
    const calls: (string | null)[] = [];
    const hold = new ExpressionHold((tag) => calls.push(tag));
    hold.hold("喜", 600);
    hold.dispose();
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(["喜"]);
  });
});
