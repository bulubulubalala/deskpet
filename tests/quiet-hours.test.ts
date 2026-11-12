import { describe, expect, it } from "vitest";

import { quietHoursContain } from "../app/main/quiet-hours";

describe("免打扰时段的整数比较", () => {
  it("负数表示没设，任何时刻都不静音", () => {
    expect(quietHoursContain(-1, 7, 3)).toBe(false);
    expect(quietHoursContain(22, -1, 23)).toBe(false);
  });

  it("起止相同表示整天都算", () => {
    for (const hour of [0, 9, 23]) {
      expect(quietHoursContain(8, 8, hour)).toBe(true);
    }
  });

  it("同一天内是左闭右开：22 点到 23 点只含 22", () => {
    expect(quietHoursContain(22, 23, 22)).toBe(true);
    expect(quietHoursContain(22, 23, 23)).toBe(false);
  });

  it("跨午夜（22 点到 7 点）两头都算", () => {
    for (const hour of [22, 23, 0, 3, 6]) {
      expect(quietHoursContain(22, 7, hour)).toBe(true);
    }
    for (const hour of [7, 12, 21]) {
      expect(quietHoursContain(22, 7, hour)).toBe(false);
    }
  });
});
