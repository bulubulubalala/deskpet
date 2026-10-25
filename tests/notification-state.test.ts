import { describe, expect, it } from "vitest";

import { isDndState } from "../app/main/notification-state";

describe("isDndState", () => {
  it("treats fullscreen, presentation, busy and locked as do-not-disturb", () => {
    expect(isDndState(1)).toBe(true);
    expect(isDndState(2)).toBe(true);
    expect(isDndState(3)).toBe(true);
    expect(isDndState(4)).toBe(true);
    expect(isDndState(6)).toBe(true);
  });

  it("allows normal and app notification states", () => {
    expect(isDndState(5)).toBe(false);
    expect(isDndState(7)).toBe(false);
  });
});
