import { describe, expect, it } from "vitest";

import {
  CARD_TEXT_MAX,
  DEFAULT_REGION_COLOR,
  MAX_PORTRAIT_BYTES,
  MAX_REGION_PADDING,
  MAX_REGION_POLY_POINTS,
  MAX_REGION_PRIORITY,
  MAX_REGIONS,
  PACK_ID_PATTERN,
  REGION_NAME_MAX,
} from "../app/shared/pack-limits";
import {
  DEFAULT_REGION_COLOR as EDITOR_COLOR,
  MAX_PORTRAIT_BYTES as EDITOR_PORTRAIT_BYTES,
  MAX_REGION_PADDING as EDITOR_PADDING,
  MAX_REGION_PRIORITY as EDITOR_PRIORITY,
  PACK_ID_PATTERN as EDITOR_PACK_ID,
  POLY_MAX_POINTS,
} from "../app/renderer/editor/constants";

describe("角色包规则只有一份", () => {
  it("char_id 规则：字母数字开头，允许 _ 与 -，最长 64", () => {
    for (const ok of ["snow", "a", "A1_-", "x".repeat(64)]) {
      expect(PACK_ID_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ["", "_x", ".x", "-x", "x".repeat(65), "有中文", "a b"]) {
      expect(PACK_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("上限值本身是约定好的数（改这里就要同时考虑读写两端）", () => {
    expect(MAX_PORTRAIT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_REGIONS).toBe(24);
    expect(REGION_NAME_MAX).toBe(24);
    expect(CARD_TEXT_MAX).toBe(2000);
    expect(DEFAULT_REGION_COLOR).toBe("#ffb347");
    expect(MAX_REGION_PRIORITY).toBe(100);
    expect(MAX_REGION_PADDING).toBe(0.2);
    expect(MAX_REGION_POLY_POINTS).toBe(64);
  });

  it("编辑器用的是同一份规则，不是各抄一遍", () => {
    expect(EDITOR_PACK_ID).toBe(PACK_ID_PATTERN);
    expect(EDITOR_PORTRAIT_BYTES).toBe(MAX_PORTRAIT_BYTES);
    expect(EDITOR_COLOR).toBe(DEFAULT_REGION_COLOR);
    expect(EDITOR_PRIORITY).toBe(MAX_REGION_PRIORITY);
    expect(EDITOR_PADDING).toBe(MAX_REGION_PADDING);
    expect(POLY_MAX_POINTS).toBe(MAX_REGION_POLY_POINTS);
  });
});
