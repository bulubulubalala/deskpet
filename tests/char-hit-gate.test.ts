/**
 * 文件职责：触摸闸门的纯逻辑单测（T2.3-C2c，count 制）——去抖聚合、冷却、每分钟上限、太欠吞掉。
 *
 * 为什么不用假计时器：闸门只吃 (count, now)，喂一条手写的时间轴就能覆盖全部分支；
 * setTimeout 那半段（到点回来调 flush）由真机取证覆盖。
 * 依赖方向：tests -> app/main/char-hit-gate（纯逻辑，不碰 Electron / 网络 / 定时器）。
 */

import { describe, expect, it } from "vitest";

import {
  CharHitGate,
  HIT_COOLDOWN_MS,
  HIT_DEBOUNCE_MS,
  HIT_FLUSH_TOLERANCE_MS,
  HIT_IGNORE_COUNT,
  HIT_RATE_MAX,
  clampTouchCount,
} from "../app/main/char-hit-gate";

const T0 = 1_000_000;

describe("clampTouchCount", () => {
  it("非有限数与小于 1 都当 1，小数截断，封顶 999", () => {
    expect(clampTouchCount(Number.NaN)).toBe(1);
    expect(clampTouchCount(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampTouchCount(0)).toBe(1);
    expect(clampTouchCount(-3)).toBe(1);
    expect(clampTouchCount(2.9)).toBe(2);
    expect(clampTouchCount(5000)).toBe(999);
  });
});

describe("CharHitGate", () => {
  it("一串触摸只在最后一击之后 600ms 发起一次，带整串力度", () => {
    const gate = new CharHitGate();
    expect(gate.onHit(1, T0).kind).toBe("pending");
    expect(gate.onHit(2, T0 + 100).kind).toBe("pending");
    expect(gate.onHit(5, T0 + 200).kind).toBe("pending");
    expect(gate.hasPending()).toBe(true);
    expect(gate.flush(T0 + 700)).toBeNull();
    expect(gate.flush(T0 + 200 + HIT_DEBOUNCE_MS)).toEqual({ count: 5 });
    expect(gate.hasPending()).toBe(false);
    expect(gate.flush(T0 + 9_000)).toBeNull();
  });

  it("定时器早回来几毫秒不吞掉，早太多仍然不发", () => {
    const gate = new CharHitGate();
    gate.onHit(2, T0);
    expect(gate.remainingMs(T0 + 100)).toBe(HIT_DEBOUNCE_MS - 100);
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS - HIT_FLUSH_TOLERANCE_MS)).toEqual({ count: 2 });
    const late = new CharHitGate();
    late.onHit(3, T0);
    expect(late.flush(T0 + HIT_DEBOUNCE_MS - HIT_FLUSH_TOLERANCE_MS - 1)).toBeNull();
    expect(late.remainingMs(T0)).toBe(HIT_DEBOUNCE_MS);
    expect(late.hasPending()).toBe(true);
    expect(late.flush(T0 + HIT_DEBOUNCE_MS)).toEqual({ count: 3 });
    expect(late.remainingMs(T0 + HIT_DEBOUNCE_MS * 2)).toBe(0);
  });

  it("真实发起后 8 秒内只记账，冷却过了才重新排队", () => {
    const gate = new CharHitGate();
    gate.onHit(1, T0);
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS)).toEqual({ count: 1 });
    expect(gate.onHit(2, T0 + HIT_DEBOUNCE_MS + 100)).toEqual({
      kind: "ignored",
      reason: "cooling",
    });
    expect(gate.hasPending()).toBe(false);
    const again = gate.onHit(2, T0 + HIT_DEBOUNCE_MS + HIT_COOLDOWN_MS);
    expect(again.kind).toBe("pending");
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS + HIT_COOLDOWN_MS + HIT_DEBOUNCE_MS)).toEqual({
      count: 2,
    });
  });

  it("每分钟最多 4 次，第 5 次直接吞掉", () => {
    const gate = new CharHitGate();
    expect(gate.remainingCalls(T0)).toBe(HIT_RATE_MAX);
    for (let index = 0; index < HIT_RATE_MAX; index += 1) {
      const at = T0 + index * 10_000;
      expect(gate.onHit(1, at).kind).toBe("pending");
      expect(gate.flush(at + HIT_DEBOUNCE_MS)).toEqual({ count: 1 });
    }
    expect(gate.remainingCalls(T0 + 40_000)).toBe(0);
    expect(gate.onHit(1, T0 + 40_000)).toEqual({
      kind: "ignored",
      reason: "rate_limited",
    });
    expect(gate.hasPending()).toBe(false);
    expect(gate.remainingCalls(T0 + 91_000)).toBe(HIT_RATE_MAX);
  });

  it("一串 ≥10 下直接吞掉，并取消已经排上的那一次", () => {
    const gate = new CharHitGate();
    gate.onHit(3, T0);
    expect(gate.onHit(HIT_IGNORE_COUNT, T0 + 100)).toEqual({
      kind: "ignored",
      reason: "overloaded",
    });
    expect(gate.hasPending()).toBe(false);
    expect(gate.flush(T0 + 5_000)).toBeNull();
  });

  it("reset 清掉待发的一次", () => {
    const gate = new CharHitGate();
    gate.onHit(2, T0);
    gate.reset();
    expect(gate.hasPending()).toBe(false);
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS)).toBeNull();
  });

  it("demand 可以跳过去抖；冷却结束点与 cooling / rate-limited 可查询", () => {
    const gate = new CharHitGate();
    expect(gate.onHit(3, T0, 0)).toEqual({ kind: "pending", delayMs: 0 });
    expect(gate.flush(T0)).toEqual({ count: 3 });
    expect(gate.isCooling(T0 + 100)).toBe(true);
    expect(gate.cooldownEndsAt(T0 + 100)).toBe(T0 + HIT_COOLDOWN_MS);
    expect(gate.isCooling(T0 + HIT_COOLDOWN_MS)).toBe(false);
    expect(gate.isRateLimited(T0)).toBe(false);
  });

  it("每分钟上限满了：cooldownEndsAt 返回 Infinity，排队也没意义", () => {
    const gate = new CharHitGate();
    for (let index = 0; index < HIT_RATE_MAX; index += 1) {
      const at = T0 + index * 10_000;
      gate.onHit(1, at);
      gate.flush(at + HIT_DEBOUNCE_MS);
    }
    expect(gate.isRateLimited(T0 + 40_000)).toBe(true);
    expect(gate.cooldownEndsAt(T0 + 40_000)).toBe(Number.POSITIVE_INFINITY);
  });
});
