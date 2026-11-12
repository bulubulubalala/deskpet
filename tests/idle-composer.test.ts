/**
 * 文件职责：待机编排的随机决策单测（T2.41）。
 *
 * 关键回归：间隔落在 8–25s；random 越界 / NaN 也不能给出荒唐的定时器。
 */
import { describe, expect, it } from "vitest";

import {
  IDLE_MAX_MS,
  IDLE_MIN_MS,
  nextIdleDelay,
  pickIdleAct,
} from "../app/renderer/idle-composer";

describe("nextIdleDelay", () => {
  it("两端与中点", () => {
    expect(nextIdleDelay(() => 0)).toBe(IDLE_MIN_MS);
    expect(nextIdleDelay(() => 1)).toBe(IDLE_MAX_MS);
    expect(nextIdleDelay(() => 0.5)).toBe((IDLE_MIN_MS + IDLE_MAX_MS) / 2);
  });

  it("random 越界 / NaN 时夹到区间内", () => {
    expect(nextIdleDelay(() => 5)).toBe(IDLE_MAX_MS);
    expect(nextIdleDelay(() => -3)).toBe(IDLE_MIN_MS);
    expect(nextIdleDelay(() => Number.NaN)).toBe(IDLE_MIN_MS);
  });
});

describe("pickIdleAct", () => {
  it("按权重分段抽样", () => {
    expect(pickIdleAct(() => 0)).toBe("idle");
    expect(pickIdleAct(() => 0.49)).toBe("idle");
    expect(pickIdleAct(() => 0.5)).toBe("blink");
    expect(pickIdleAct(() => 0.79)).toBe("blink");
    expect(pickIdleAct(() => 0.9)).toBe("nod");
  });

  it("random 恰好为 1 时落在最后一个动作上，不会返回 undefined", () => {
    expect(pickIdleAct(() => 1)).toBe("nod");
    expect(pickIdleAct(() => Number.NaN)).toBe("idle");
  });
});
