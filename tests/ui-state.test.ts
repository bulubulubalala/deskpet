/**
 * 文件职责：界面状态纯函数与存档的单测（§6.11 的 data/ui.json）。
 *
 * 为什么测这些边界：位置 / 缩放存坏了会让窗口跑到屏幕外或缩成看不见，
 * 所以「坏值退回默认」「缩放钳位」「原子写往返」必须有测试兜着。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyUiStatePatch,
  CHAT_BAR_HEIGHT,
  CHAT_BAR_MIN_WIDTH,
  clampScale,
  computePetWindowSize,
  DEFAULT_UI_STATE,
  parseUiState,
  readUiState,
  writeUiState,
} from "../app/main/ui-state";

describe("parseUiState", () => {
  it("空档与坏 JSON 都退回默认值", () => {
    expect(parseUiState(null)).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState("   ")).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState("{ 不是 JSON")).toEqual(DEFAULT_UI_STATE);
    expect(parseUiState("[1, 2, 3]")).toEqual(DEFAULT_UI_STATE);
  });

  it("好字段保留、坏字段各自退回默认值", () => {
    const parsed = parseUiState(
      JSON.stringify({
        x: 120.6,
        y: "oops",
        scale: 8,
        click_through: "yes",
        always_on_top: true,
        char_id: "amber",
      }),
    );
    expect(parsed.x).toBe(121);
    expect(parsed.y).toBe(DEFAULT_UI_STATE.y);
    expect(parsed.scale).toBe(2);
    expect(parsed.click_through).toBe(DEFAULT_UI_STATE.click_through);
    expect(parsed.always_on_top).toBe(true);
    expect(parsed.char_id).toBe("amber");
  });

  it("空字符串角色号等价于没选角色", () => {
    expect(parseUiState(JSON.stringify({ char_id: "" })).char_id).toBeNull();
  });
});

describe("clampScale / computePetWindowSize", () => {
  it("缩放钳到 0.5–2，坏值退回 1", () => {
    expect(clampScale(0.1)).toBe(0.5);
    expect(clampScale(3)).toBe(2);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it("尺寸 = 立绘包围盒 × 缩放 + 聊天条，宽度不低于聊天条最小宽度", () => {
    // 1× 时立绘 320 宽已小于聊天条最小宽（T2.2 修：320 会把输入框挤成 0 宽），取最小值
    expect(computePetWindowSize(1)).toEqual({
      width: CHAT_BAR_MIN_WIDTH,
      height: 420 + CHAT_BAR_HEIGHT,
    });
    expect(computePetWindowSize(2)).toEqual({ width: 640, height: 840 + CHAT_BAR_HEIGHT });
    expect(computePetWindowSize(0.5).width).toBe(CHAT_BAR_MIN_WIDTH);
    expect(computePetWindowSize(99).width).toBe(640);
  });
});

describe("applyUiStatePatch", () => {
  it("只接受合法值，坏值保留原值", () => {
    const next = applyUiStatePatch(
      { ...DEFAULT_UI_STATE, char_id: "amber" },
      { scale: 1.5, x: Number.NaN, click_through: false, char_id: "" },
    );
    expect(next.scale).toBe(1.5);
    expect(next.x).toBe(DEFAULT_UI_STATE.x);
    expect(next.click_through).toBe(false);
    expect(next.char_id).toBeNull();
  });
});

describe("readUiState / writeUiState", () => {
  it("写出去再读回来是同一份", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-ui-"));
    const file = join(dir, "ui.json");
    const state = { ...DEFAULT_UI_STATE, x: 40, y: 80, scale: 1.25, char_id: "amber" };
    await writeUiState(file, state);
    expect(await readUiState(file)).toEqual(state);
    // 原子写不该留下 .tmp
    expect(await readFile(file + ".tmp", "utf8").catch(() => null)).toBeNull();
  });

  it("没有存档时读默认值", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-ui-"));
    expect(await readUiState(join(dir, "missing.json"))).toEqual(DEFAULT_UI_STATE);
  });
});
