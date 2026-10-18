/**
 * 文件职责：部位点击闸门的纯逻辑单测（T2.3-C2b）——去抖聚合、冷却、每分钟上限、太欠吞掉。
 *
 * 为什么不用假计时器：闸门只吃 (streak, now)，喂一条手写的时间轴就能覆盖全部分支；
 * setTimeout 那半段（到点回来调 flush）由真机冒烟覆盖。
 * 依赖方向：tests -> app/main/char-hit-gate（纯逻辑，不碰 Electron / 网络 / 定时器）。
 */

import { describe, expect, it } from "vitest";

import {
  CharHitGate,
  HIT_COOLDOWN_MS,
  HIT_DEBOUNCE_MS,
  HIT_FLUSH_TOLERANCE_MS,
  HIT_IGNORE_STREAK,
  HIT_RATE_MAX,
  HIT_RATE_WINDOW_MS,
  clampStreak,
} from "../app/main/char-hit-gate";

const T0 = 1_700_000_000_000;

describe("clampStreak", () => {
  it("非法值当 1，小数截断、超限夹到上限", () => {
    expect(clampStreak(Number.NaN)).toBe(1);
    expect(clampStreak(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampStreak(-5)).toBe(1);
    expect(clampStreak(0)).toBe(1);
    expect(clampStreak(3.9)).toBe(3);
    expect(clampStreak(100_000)).toBe(999);
  });
});

describe("CharHitGate", () => {
  it("一串点击只排一次，flush 带整串的条数", () => {
    const gate = new CharHitGate();
    expect(gate.onHit(1, T0)).toEqual({ kind: "pending", delayMs: HIT_DEBOUNCE_MS });
    // 同一串里继续戳：只是把截止时间往后挪（最后一击 + 去抖），一口气 5 下仍然只花一次 LLM
    expect(gate.onHit(2, T0 + 100)).toEqual({ kind: "pending", delayMs: HIT_DEBOUNCE_MS });
    expect(gate.onHit(5, T0 + 300)).toEqual({ kind: "pending", delayMs: HIT_DEBOUNCE_MS });
    // 没到点不能发（截止时间已挪到 T0 + 900）
    expect(gate.flush(T0 + 800)).toBeNull();
    expect(gate.flush(T0 + 900)).toEqual({ streak: 5 });
    // 发过之后队列清空，重复 flush 不会再发一次
    expect(gate.flush(T0 + 1000)).toBeNull();
  });

  it("冷却期内的点击只记账，不补发", () => {
    const gate = new CharHitGate();
    expect(gate.onHit(1, T0)).toMatchObject({ kind: "pending" });
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS)).toEqual({ streak: 1 });
    const inside = T0 + HIT_DEBOUNCE_MS + HIT_COOLDOWN_MS - 1;
    expect(gate.onHit(1, inside)).toEqual({ kind: "ignored", reason: "cooling" });
    // 冷却一到就恢复（此时冷却与去抖都满足）
    expect(gate.onHit(1, inside + 1)).toEqual({ kind: "pending", delayMs: HIT_DEBOUNCE_MS });
  });

  it("每分钟最多 HIT_RATE_MAX 次，超出的直接吞掉", () => {
    const gate = new CharHitGate();
    for (let index = 0; index < HIT_RATE_MAX; index += 1) {
      const now = T0 + index * HIT_COOLDOWN_MS * 2;
      expect(gate.onHit(1, now)).toMatchObject({ kind: "pending" });
      expect(gate.flush(now + HIT_DEBOUNCE_MS)).toEqual({ streak: 1 });
    }
    const now = T0 + (HIT_RATE_MAX - 1) * HIT_COOLDOWN_MS * 2 + HIT_DEBOUNCE_MS + HIT_COOLDOWN_MS;
    expect(now - T0).toBeLessThan(HIT_RATE_WINDOW_MS);
    expect(gate.onHit(1, now)).toEqual({ kind: "ignored", reason: "rate_limited" });
  });

  it("条数达到阈值直接吞掉，并取消已经排上的那一次", () => {
    const gate = new CharHitGate();
    expect(gate.onHit(2, T0)).toMatchObject({ kind: "pending" });
    expect(gate.onHit(HIT_IGNORE_STREAK, T0 + 100)).toEqual({
      kind: "ignored",
      reason: "overloaded",
    });
    expect(gate.flush(T0 + 5000)).toBeNull();
  });

  it("定时器早回来几毫秒不吞掉，但早太多仍然不发（T2.3-C2b 真机踩到的静默丢回合）", () => {
    const gate = new CharHitGate();
    expect(gate.onHit(2, T0)).toMatchObject({ kind: "pending" });
    expect(gate.hasPending()).toBe(true);
    expect(gate.remainingMs(T0 + 100)).toBe(HIT_DEBOUNCE_MS - 100);
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS - HIT_FLUSH_TOLERANCE_MS)).toEqual({ streak: 2 });

    const other = new CharHitGate();
    expect(other.onHit(3, T0)).toMatchObject({ kind: "pending" });
    expect(other.flush(T0 + HIT_DEBOUNCE_MS - HIT_FLUSH_TOLERANCE_MS - 1)).toBeNull();
    expect(other.remainingMs(T0)).toBe(HIT_DEBOUNCE_MS);
    expect(other.flush(T0 + HIT_DEBOUNCE_MS)).toEqual({ streak: 3 });
    expect(other.remainingMs(T0 + HIT_DEBOUNCE_MS * 2)).toBe(0);
    expect(other.hasPending()).toBe(false);
  });

  it("被吞掉的那一串 hasPending 为假：调用方据此停手，不再空转重排", () => {
    const gate = new CharHitGate();
    expect(gate.onHit(2, T0)).toMatchObject({ kind: "pending" });
    expect(gate.onHit(HIT_IGNORE_STREAK, T0 + 100)).toEqual({
      kind: "ignored",
      reason: "overloaded",
    });
    expect(gate.hasPending()).toBe(false);
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS)).toBeNull();
    expect(gate.remainingMs(T0 + HIT_DEBOUNCE_MS)).toBe(0);
  });

  it("reset 清掉待发事实，不泄漏到下一次注册", () => {
    const gate = new CharHitGate();
    gate.onHit(3, T0);
    gate.reset();
    expect(gate.flush(T0 + HIT_DEBOUNCE_MS)).toBeNull();
  });
});
