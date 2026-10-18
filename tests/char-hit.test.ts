/**
 * 文件职责：立绘部位点击的纯逻辑单测（T2.3-C2）——几何换算、命中、连击分档、本地台词。
 *
 * 为什么先测这里：真机点不准时说不清是画错框还是算错坐标；把算法钉死之后，真机只剩
 * 「框的位置对不对」这一个变量。
 * 依赖方向：tests -> app/renderer/char-hit（纯函数，不碰 DOM）+ app/main/ipc 的类型。
 */

import { describe, expect, it } from "vitest";

import type { CharHitRegion } from "../app/main/ipc";
import {
  HIT_DOUBLE_GAP_MS,
  HIT_HOLD_MS,
  HIT_STREAK_GAP_MS,
  HitStreakTracker,
  contentBox,
  kindOf,
  localReaction,
  locateRegion,
  toNormalizedPoint,
} from "../app/renderer/char-hit";

function region(id: string, rect: readonly [number, number, number, number]): CharHitRegion {
  return { id, name: id, rect, color: "#ffb347", reactions: ["一", "二"], act: "wave" };
}

describe("contentBox", () => {
  it("contain：元素比素材窄时左右铺满、上下留白", () => {
    const box = contentBox({ left: 10, top: 20, width: 400, height: 600 }, 512, 724);
    expect(box).not.toBeNull();
    expect(box?.width).toBeCloseTo(400, 6);
    expect(box?.height).toBeCloseTo((400 * 724) / 512, 6);
    expect(box?.left).toBeCloseTo(10, 6);
    expect(box?.top).toBeCloseTo(20 + (600 - (400 * 724) / 512) / 2, 6);
  });

  it("尺寸非法时返回 null，不做除零", () => {
    expect(contentBox({ left: 0, top: 0, width: 0, height: 100 }, 512, 724)).toBeNull();
    expect(contentBox({ left: 0, top: 0, width: 100, height: 100 }, 0, 724)).toBeNull();
  });
});

describe("toNormalizedPoint", () => {
  const box = { left: 100, top: 50, width: 200, height: 400 };

  it("把客户端坐标换算成 0–1 素材坐标", () => {
    expect(toNormalizedPoint(box, 200, 250)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("落在画面外返回 null（宁可不算，也不要错算到边缘）", () => {
    expect(toNormalizedPoint(box, 99, 250)).toBeNull();
    expect(toNormalizedPoint(box, 200, 451)).toBeNull();
  });
});

describe("locateRegion", () => {
  const regions = [region("head", [0, 0, 0.5, 0.5]), region("hat", [0.2, 0.1, 0.4, 0.2])];

  it("后定义的框盖住先定义的框", () => {
    expect(locateRegion(regions, 0.3, 0.2)?.id).toBe("hat");
    expect(locateRegion(regions, 0.1, 0.4)?.id).toBe("head");
  });

  it("哪个都不中返回 null", () => {
    expect(locateRegion(regions, 0.9, 0.9)).toBeNull();
    expect(locateRegion([], 0.5, 0.5)).toBeNull();
  });
});

describe("HitStreakTracker", () => {
  it("间隔内连点算同一串，超时归零", () => {
    const tracker = new HitStreakTracker();
    expect(tracker.next(1000, 10).streak).toBe(1);
    expect(tracker.next(1000 + HIT_STREAK_GAP_MS, 10).streak).toBe(2);
    expect(tracker.next(1000 + HIT_STREAK_GAP_MS * 2 + 1, 10).streak).toBe(1);
  });

  it("按间隔 / 按住时长分档", () => {
    const tracker = new HitStreakTracker();
    expect(tracker.next(1000, 10).kind).toBe("single");
    expect(tracker.next(1000 + HIT_DOUBLE_GAP_MS, 10).kind).toBe("double");
    expect(kindOf(2000, HIT_HOLD_MS + 1)).toBe("hold");
    expect(kindOf(-1, 10)).toBe("single");
  });

  it("reset 之后重新算", () => {
    const tracker = new HitStreakTracker();
    tracker.next(1000, 10);
    tracker.reset();
    expect(tracker.next(2000, 10).streak).toBe(1);
  });
});

describe("localReaction", () => {
  it("第 N 串取第 N 句，越界取最后一句", () => {
    const head = region("head", [0, 0, 1, 1]);
    expect(localReaction(head, 1)).toBe("一");
    expect(localReaction(head, 2)).toBe("二");
    expect(localReaction(head, 9)).toBe("二");
  });

  it("没有兜底台词时返回空串（界面就不冒泡）", () => {
    expect(localReaction({ ...region("head", [0, 0, 1, 1]), reactions: [] }, 1)).toBe("");
  });
});
