import { describe, expect, it } from "vitest";

import { ActivityLog } from "../app/main/activity-log";

describe("ActivityLog", () => {
  it("keeps recent allowlisted facts and drops duplicates", () => {
    const log = new ActivityLog();
    log.record("用户打开了设置。", 1000);
    log.record("用户打开了设置。", 2000);
    log.record("用户切到了语音模式。", 3000);
    expect(log.recent(3000)).toEqual(["用户打开了设置。", "用户切到了语音模式。"]);
  });

  it("expires old facts and collapses whitespace", () => {
    const log = new ActivityLog();
    log.record("  用户   打开了\n编辑器。 ", 1000);
    expect(log.recent(2000)).toEqual(["用户 打开了 编辑器。"]);
    expect(log.recent(1_000_000)).toEqual([]);
  });

  it("caps the ring at eight entries", () => {
    const log = new ActivityLog();
    for (let index = 0; index < 12; index += 1) {
      log.record("事件 " + String(index), index * 1000);
    }
    expect(log.recent(12_000)).toHaveLength(8);
  });
});
