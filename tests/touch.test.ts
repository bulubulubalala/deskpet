/**
 * 文件职责：触摸手势引擎的纯逻辑单测（T2.3-C2c，方案 §4）——分档、会话聚合、部位去重。
 *
 * 为什么喂时间轴而不是点真窗口：手势判定全是几何与时间；把它钉死之后真机只剩下
 * 「坐标量得对不对」这一个变量。
 * 依赖方向：tests -> app/renderer/touch（纯逻辑）+ app/main/ipc 的类型。
 */

import { describe, expect, it } from "vitest";

import type { TouchRegion } from "../app/main/ipc";
import {
  TOUCH_DEMAND_SESSION_GAP_MS,
  TOUCH_HOLD_MS,
  TOUCH_SESSION_GAP_MS,
  TOUCH_STROKE_MIN_PX,
  TouchTracker,
  classifyStroke,
  isGestureEnabled,
  isPatGap,
} from "../app/renderer/touch";

const HEAD: TouchRegion = { id: "head", name: "头" };
const HAND: TouchRegion = { id: "hand", name: "手" };
const T0 = 1_000_000;

describe("classifyStroke", () => {
  it("先看揉，再看摸，再看按住，最后才是点", () => {
    expect(classifyStroke({ distance: 80, maxStep: 20, flips: 3, durationMs: 800 })).toBe("knead");
    expect(classifyStroke({ distance: 80, maxStep: 60, flips: 3, durationMs: 800 })).toBe("stroke");
    expect(classifyStroke({ distance: 10, maxStep: 5, flips: 0, durationMs: TOUCH_HOLD_MS })).toBe(
      "hold",
    );
    expect(classifyStroke({ distance: 2, maxStep: 2, flips: 0, durationMs: 100 })).toBe("tap");
  });
});

describe("TouchTracker", () => {
  it("原地按松是 tap，静默够久才结算成一条消息", () => {
    const tracker = new TouchTracker();
    tracker.down(100, 100, T0, HEAD);
    tracker.up(100, 100, T0 + 80, HEAD);
    expect(tracker.closeIfIdle(T0 + TOUCH_SESSION_GAP_MS - 1)).toBeNull();
    const message = tracker.closeIfIdle(T0 + 80 + TOUCH_SESSION_GAP_MS);
    expect(message).toMatchObject({ gesture: "tap", count: 1, duration_ms: 80 });
    expect(message?.regions).toEqual([HEAD]);
  });

  it("按住超过 600ms 记成 hold，力度恒为 1", () => {
    const tracker = new TouchTracker();
    tracker.down(10, 10, T0, HEAD);
    tracker.up(10, 10, T0 + TOUCH_HOLD_MS + 50, HEAD);
    const message = tracker.closeIfIdle(T0 + 5_000);
    expect(message).toMatchObject({ gesture: "hold", count: 1, duration_ms: TOUCH_HOLD_MS + 50 });
  });

  it("拖过 40px 记成 stroke，并记下摸过的部位", () => {
    const tracker = new TouchTracker();
    tracker.down(10, 10, T0, HEAD);
    tracker.move(10 + TOUCH_STROKE_MIN_PX + 10, 10, T0 + 200, HAND);
    tracker.up(10 + TOUCH_STROKE_MIN_PX + 10, 10, T0 + 260, HAND);
    const message = tracker.closeIfIdle(T0 + 5_000);
    expect(message).toMatchObject({ gesture: "stroke", count: 1 });
    expect(message?.regions).toEqual([HEAD, HAND]);
  });

  it("来回小幅度搓记成 knead", () => {
    const tracker = new TouchTracker();
    tracker.down(100, 100, T0, HEAD);
    tracker.move(120, 100, T0 + 40, HEAD);
    tracker.move(100, 100, T0 + 80, HEAD);
    tracker.move(120, 100, T0 + 120, HEAD);
    tracker.move(100, 100, T0 + 160, HEAD);
    tracker.up(100, 100, T0 + 200, HEAD);
    const message = tracker.closeIfIdle(T0 + 5_000);
    expect(message).toMatchObject({ gesture: "knead", count: 1 });
  });

  it("300ms 内连点 3 下升格为 pat，力度就是下数", () => {
    const tracker = new TouchTracker();
    for (let index = 0; index < 3; index += 1) {
      const at = T0 + index * 200;
      tracker.down(50, 50, at, HEAD);
      tracker.up(50, 50, at + 40, HEAD);
    }
    const message = tracker.closeIfIdle(T0 + 5_000);
    expect(message).toMatchObject({ gesture: "pat", count: 3 });
  });

  it("手势变了就另起一串，两条消息按发生顺序排队", () => {
    const tracker = new TouchTracker();
    tracker.down(10, 10, T0, HEAD);
    tracker.up(10, 10, T0 + 50, HEAD);
    tracker.down(10, 10, T0 + 200, HEAD);
    tracker.move(120, 10, T0 + 300, HEAD);
    tracker.up(120, 10, T0 + 350, HEAD);
    expect(tracker.closeIfIdle(T0 + 5_000)?.gesture).toBe("tap");
    expect(tracker.closeIfIdle(T0 + 5_000)?.gesture).toBe("stroke");
    expect(tracker.closeIfIdle(T0 + 6_000)).toBeNull();
  });

  it("部位去重、最多三个（模型也记不住更多）", () => {
    const tracker = new TouchTracker();
    const regions: TouchRegion[] = [
      { id: "head", name: "头" },
      { id: "chest", name: "胸" },
      { id: "hand", name: "手" },
      { id: "legs", name: "腿" },
    ];
    tracker.down(-10, 0, T0, null);
    regions.forEach((item, index) => {
      tracker.move(index * 10, 0, T0 + index, item);
    });
    tracker.up(30, 0, T0 + 100, regions[3] ?? null);
    const message = tracker.closeIfIdle(T0 + 5_000);
    expect(message?.regions.map((item) => item.id)).toEqual(["head", "chest", "hand"]);
  });

  it("reset 清掉当前串与待发消息", () => {
    const tracker = new TouchTracker();
    tracker.down(10, 10, T0, HEAD);
    tracker.up(10, 10, T0 + 50, HEAD);
    tracker.reset();
    expect(tracker.closeIfIdle(T0 + 5_000)).toBeNull();
  });
});

describe("liveIntent（T2.6 两阶段）", () => {
  it("按住 600ms 立刻报 hold，且每条会话只报一次", () => {
    const tracker = new TouchTracker();
    tracker.down(10, 10, T0, HEAD);
    expect(tracker.liveIntent(T0 + TOUCH_HOLD_MS - 1)).toBeNull();
    expect(tracker.liveIntent(T0 + TOUCH_HOLD_MS)).toBe("hold");
    expect(tracker.liveIntent(T0 + TOUCH_HOLD_MS + 200)).toBeNull();
    tracker.up(10, 10, T0 + 900, HEAD);
    const message = tracker.closeIfIdle(T0 + 900 + TOUCH_DEMAND_SESSION_GAP_MS);
    expect(message?.gesture).toBe("hold");
  });

  it("滑动 40px 立刻报 stroke；连续 3 下报 pat，demand 会话 600ms 就结算", () => {
    const tracker = new TouchTracker();
    tracker.down(10, 10, T0, HEAD);
    tracker.move(10 + TOUCH_STROKE_MIN_PX, 10, T0 + 100, HEAD);
    expect(tracker.liveIntent(T0 + 100)).toBe("stroke");
    tracker.up(10 + TOUCH_STROKE_MIN_PX, 10, T0 + 200, HEAD);
    expect(tracker.closeIfIdle(T0 + 200 + TOUCH_DEMAND_SESSION_GAP_MS)).not.toBeNull();
  });

  it("三下 tap 报 pat，并在 600ms 后结算（不用等 1500ms）", () => {
    const tracker = new TouchTracker();
    for (let index = 0; index < 3; index += 1) {
      const at = T0 + index * 100;
      tracker.down(10, 10, at, HEAD);
      tracker.up(10, 10, at + 40, HEAD);
    }
    expect(tracker.liveIntent(T0 + 300)).toBe("pat");
    expect(tracker.closeIfIdle(T0 + 240 + TOUCH_DEMAND_SESSION_GAP_MS - 1)).toBeNull();
    expect(tracker.closeIfIdle(T0 + 240 + TOUCH_DEMAND_SESSION_GAP_MS)).toMatchObject({
      gesture: "pat",
      count: 3,
    });
  });

  it("单点不报 live intent，仍等 1500ms 聚合", () => {
    const tracker = new TouchTracker();
    tracker.down(10, 10, T0, HEAD);
    tracker.up(10, 10, T0 + 80, HEAD);
    expect(tracker.liveIntent(T0 + 80)).toBeNull();
    expect(tracker.closeIfIdle(T0 + 80 + TOUCH_DEMAND_SESSION_GAP_MS)).toBeNull();
    expect(tracker.closeIfIdle(T0 + 80 + TOUCH_SESSION_GAP_MS)).toMatchObject({
      gesture: "tap",
      count: 1,
    });
  });
});

describe("isPatGap / isGestureEnabled", () => {
  it("连拍间隔 0–300ms 才算同一串；手势白名单只认列出来的", () => {
    expect(isPatGap(0)).toBe(true);
    expect(isPatGap(300)).toBe(true);
    expect(isPatGap(301)).toBe(false);
    expect(isPatGap(-1)).toBe(false);
    expect(isGestureEnabled(["tap", "hold"], "tap")).toBe(true);
    expect(isGestureEnabled(["tap"], "pat")).toBe(false);
  });
});
