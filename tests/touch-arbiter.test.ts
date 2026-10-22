/**
 * 文件职责：触摸意图分类 / 合并的纯逻辑单测（T2.6）。
 */

import { describe, expect, it } from "vitest";

import { classifyTouchIntent, mergeTouches } from "../app/main/touch-arbiter";
import type { TouchMessage } from "../app/main/ipc";

function touch(patch: Partial<TouchMessage> = {}): TouchMessage {
  return {
    gesture: "tap",
    regions: [{ id: "head", name: "头" }],
    count: 1,
    duration_ms: 100,
    ...patch,
  };
}

describe("classifyTouchIntent", () => {
  it("轻点 1–2 下是 backchannel，3 下起是 demand", () => {
    expect(classifyTouchIntent(touch({ count: 1 }))).toBe("backchannel");
    expect(classifyTouchIntent(touch({ count: 2 }))).toBe("backchannel");
    expect(classifyTouchIntent(touch({ count: 3 }))).toBe("demand");
    expect(classifyTouchIntent(touch({ count: 12 }))).toBe("demand");
  });

  it("拍 / 按住 / 揉 / 摸一律 demand", () => {
    for (const gesture of ["pat", "hold", "knead", "stroke"] as const) {
      expect(classifyTouchIntent(touch({ gesture }))).toBe("demand");
    }
  });
});

describe("mergeTouches", () => {
  it("部位去重、最多 3 个，count / duration 取最大", () => {
    const older = touch({
      gesture: "tap",
      count: 2,
      duration_ms: 300,
      regions: [
        { id: "head", name: "头" },
        { id: "hand", name: "手" },
      ],
    });
    const newer = touch({
      gesture: "stroke",
      count: 5,
      duration_ms: 900,
      regions: [
        { id: "hand", name: "手" },
        { id: "legs", name: "腿" },
        { id: "tail", name: "尾巴" },
        { id: "ears", name: "耳朵" },
      ],
    });
    const merged = mergeTouches(older, newer);
    expect(merged.gesture).toBe("stroke");
    expect(merged.count).toBe(5);
    expect(merged.duration_ms).toBe(900);
    expect(merged.regions.map((region) => region.id)).toEqual(["head", "hand", "legs"]);
  });

  it("手势取更强：按住不会被后来的轻点盖掉", () => {
    const merged = mergeTouches(touch({ gesture: "hold" }), touch({ gesture: "tap" }));
    expect(merged.gesture).toBe("hold");
  });

  it("没有旧消息时复制一份，不共享数组", () => {
    const source = touch();
    const merged = mergeTouches(null, source);
    expect(merged).not.toBe(source);
    expect(merged.regions).not.toBe(source.regions);
  });
});
