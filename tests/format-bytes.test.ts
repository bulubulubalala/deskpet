import { describe, expect, it } from "vitest";

import { formatBytes } from "../app/main/format-bytes";

describe("体量文案", () => {
  it("小于 1 KiB 直接用字节", () => {
    expect(formatBytes(0)).toBe("（大小未知）");
    expect(formatBytes(-3)).toBe("（大小未知）");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("KiB 与 MiB 各自取整到一位", () => {
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MiB");
    expect(formatBytes(1024 * 1024 * 12)).toBe("12.0 MiB");
  });

  it("NaN / Infinity 当成未知，不往界面里塞 NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("（大小未知）");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("（大小未知）");
  });
});
