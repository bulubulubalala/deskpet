import { describe, expect, it } from "vitest";

import { parseMicUsage } from "../app/main/mic-occupancy";

const OUTPUT = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\A
    LastUsedTimeStart    REG_QWORD    0x20
    LastUsedTimeStop     REG_QWORD    0x10
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\B
    LastUsedTimeStart    REG_QWORD    0x10
    LastUsedTimeStop     REG_QWORD    0x20
`;

describe("parseMicUsage", () => {
  it("detects an active start > stop entry", () => {
    expect(parseMicUsage(OUTPUT)).toBe(true);
  });

  it("returns false when every app has stopped", () => {
    const stopped = `
HKEY_CURRENT_USER\\...\\A
    LastUsedTimeStart    REG_QWORD    0x10
    LastUsedTimeStop     REG_QWORD    0x20
`;
    expect(parseMicUsage(stopped)).toBe(false);
  });

  it("ignores unmatched or malformed values", () => {
    expect(parseMicUsage("HKEY_X\nLastUsedTimeStart REG_QWORD nope")).toBe(false);
  });
});
