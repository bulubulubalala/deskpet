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
  CHAT_BAR_HEIGHT_MAX,
  CHAT_BAR_HEIGHT_MIN,
  CHAT_BAR_MIN_WIDTH,
  clampChatbarHeight,
  clampScale,
  clampStage,
  computePetWindowSize,
  computeStageLimits,
  DEFAULT_COMPANION,
  DEFAULT_UI_STATE,
  parseCompanionSettings,
  parseFps,
  parseUiState,
  readUiState,
  STAGE_MAX,
  STAGE_MIN_HEIGHT,
  writeUiState,
} from "../app/main/ui-state";

describe("fps（T2.43 渲染帧率档位）", () => {
  it("缺省与坏值都回默认 60", () => {
    expect(parseFps(undefined)).toBe(60);
    expect(parseFps(37)).toBe(60);
    expect(parseFps("60")).toBe(60);
    expect(parseFps(Number.NaN)).toBe(60);
    expect(parseFps(null)).toBe(60);
  });

  it("只接受 15/30/45/60/120", () => {
    for (const value of [15, 30, 45, 60, 120]) {
      expect(parseFps(value)).toBe(value);
    }
  });

  it("旧存档没有 fps 时读成默认值，增量改动能落进去", () => {
    const parsed = parseUiState(JSON.stringify({ scale: 1.2 }));
    expect(parsed.fps).toBe(60);
    expect(applyUiStatePatch(parsed, { fps: 30 }).fps).toBe(30);
    expect(applyUiStatePatch(parsed, {}).fps).toBe(60);
    expect(parseUiState(JSON.stringify({ fps: 15 })).fps).toBe(15);
  });
});

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

  it("v1 存档（没有 version）里的 always_on_top:false 升级时强制打开（T2.2 用户反馈第五轮）", () => {
    // 旧存档：点一下桌面桌宠就被别的窗口盖住，看起来像「窗口消失」——升级后默认置顶
    expect(parseUiState(JSON.stringify({ x: 10, always_on_top: false })).always_on_top).toBe(true);
    // 新存档按存档里的值走：用户可以在设置窗里把置顶关掉
    expect(parseUiState(JSON.stringify({ version: 2, always_on_top: false })).always_on_top).toBe(
      false,
    );
    expect(parseUiState(JSON.stringify({ version: 2 })).always_on_top).toBe(true);
  });

  it("立绘包围盒存得住，坏值退回占位图尺寸（T2.2）", () => {
    const parsed = parseUiState(JSON.stringify({ stage_width: 640, stage_height: 960.7 }));
    expect(parsed.stage_width).toBe(640);
    expect(parsed.stage_height).toBe(961);
    const broken = parseUiState(JSON.stringify({ stage_width: "640", stage_height: 0 }));
    expect(broken.stage_width).toBe(DEFAULT_UI_STATE.stage_width);
    expect(broken.stage_height).toBe(DEFAULT_UI_STATE.stage_height);
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

  it("尺寸 = 100% 基准 × 缩放 + 聊天条，宽度不低于立绘区与聊天条的下限", () => {
    // 占位图 128×128 比两个下限都小：1× 时窗口完全由下限决定（T2.2 修）
    expect(computePetWindowSize(1)).toEqual({
      width: CHAT_BAR_MIN_WIDTH,
      height: STAGE_MIN_HEIGHT + CHAT_BAR_HEIGHT,
    });
    const stage = { width: 400, height: 600 };
    expect(computePetWindowSize(1, stage, 92)).toEqual({ width: 400, height: 692 });
    // 400×600 小于 420×630 基准，2× 直接放大到 800×1200
    expect(computePetWindowSize(2, stage, 92)).toEqual({ width: 800, height: 1292 });
    // 0.5× 时立绘只有 200 宽，仍然踩在聊天条下限上
    expect(computePetWindowSize(0.5, stage, 92).width).toBe(CHAT_BAR_MIN_WIDTH);
    expect(computePetWindowSize(99, stage, 92).width).toBe(800);

    const real = { width: 1024, height: 1536 };
    // 真立绘 2:3：100% = 420×630，缩放现在真正生效
    expect(computePetWindowSize(0.5, real, 92)).toEqual({ width: 400, height: 407 });
    expect(computePetWindowSize(1, real, 92)).toEqual({ width: 420, height: 722 });
    expect(computePetWindowSize(1.5, real, 92)).toEqual({ width: 630, height: 1037 });
    expect(computePetWindowSize(2, real, 92)).toEqual({ width: 840, height: 1352 });
  });

  it("显示器工作区限制会等比压缩 150% / 200% 的大窗口", () => {
    const real = { width: 1024, height: 1536 };
    const limits = computeStageLimits({ width: 1920, height: 1040 }, 92);
    expect(limits).toEqual({ maxStageWidth: 1872, maxStageHeight: 900 });
    expect(computePetWindowSize(1, real, 92, limits)).toEqual({ width: 420, height: 722 });
    // 1080p 工作区只剩 900 高给立绘：1.5× 与 2× 都会压到同一可用高度
    expect(computePetWindowSize(1.5, real, 92, limits)).toEqual({ width: 600, height: 992 });
    expect(computePetWindowSize(2, real, 92, limits)).toEqual({ width: 600, height: 992 });

    // 小屏进一步压缩，但宽度仍不低于聊天条下限
    const small = computeStageLimits({ width: 800, height: 600 }, 92);
    expect(computePetWindowSize(1, real, 92, small)).toEqual({ width: 400, height: 552 });

    // 4K 屏幕放得下 200%
    const large = computeStageLimits({ width: 3840, height: 2160 }, 92);
    expect(computePetWindowSize(2, real, 92, large)).toEqual({ width: 840, height: 1352 });
  });

  it("包围盒与聊天条高度的坏值都被合法化", () => {
    expect(clampStage(Number.NaN, 128)).toBe(128);
    expect(clampStage(0, 128)).toBe(128);
    expect(clampStage(-3, 128)).toBe(128);
    expect(clampStage(300.6, 128)).toBe(301);
    expect(clampStage(99999, 128)).toBe(STAGE_MAX);
    expect(clampChatbarHeight(Number.NaN)).toBe(CHAT_BAR_HEIGHT);
    expect(clampChatbarHeight(10)).toBe(CHAT_BAR_HEIGHT_MIN);
    expect(clampChatbarHeight(9999)).toBe(CHAT_BAR_HEIGHT_MAX);
  });
});

describe("applyUiStatePatch", () => {
  it("只接受合法值，坏值保留原值", () => {
    const next = applyUiStatePatch(
      { ...DEFAULT_UI_STATE, char_id: "amber" },
      { scale: 1.5, x: Number.NaN, click_through: false, char_id: "", tts_enabled: false },
    );
    expect(next.scale).toBe(1.5);
    expect(next.x).toBe(DEFAULT_UI_STATE.x);
    expect(next.click_through).toBe(false);
    expect(next.char_id).toBeNull();
    expect(next.tts_enabled).toBe(false);
  });
});

describe("tts_enabled", () => {
  it("按布尔读，缺省 / 坏值都退回 true", () => {
    expect(parseUiState(JSON.stringify({ tts_enabled: false })).tts_enabled).toBe(false);
    expect(parseUiState(JSON.stringify({ tts_enabled: "no" })).tts_enabled).toBe(true);
    expect(parseUiState("{}").tts_enabled).toBe(true);
  });
});

describe("companion settings", () => {
  it("默认开启，屏幕观察等待首次确认", () => {
    const parsed = parseUiState("{}");
    expect(parsed.companion).toEqual(DEFAULT_COMPANION);
    expect(parsed.companion.enabled).toBe(true);
    expect(parsed.companion.vision_consented).toBe(false);
  });

  it("坏值退回默认，数值钳到安全区间", () => {
    const parsed = parseCompanionSettings({
      enabled: "yes",
      screen_interval_s: 999,
      quiet_hours_start: -10,
      quiet_hours_end: 99,
      vision_model: "  qwen2.5vl:3b  ",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.screen_interval_s).toBe(60);
    expect(parsed.quiet_hours_start).toBe(-1);
    expect(parsed.quiet_hours_end).toBe(23);
    expect(parsed.vision_model).toBe("qwen2.5vl:3b");
  });

  it("关闭陪伴时缺省子开关也关闭", () => {
    const parsed = parseCompanionSettings({ enabled: false });
    expect(parsed.screen_enabled).toBe(false);
    expect(parsed.proactive_enabled).toBe(false);
    expect(parsed.app_activity_enabled).toBe(false);
  });

  it("patch 只替换 companion，不影响其他字段", () => {
    const next = applyUiStatePatch(
      { ...DEFAULT_UI_STATE, char_id: "amber" },
      { companion: { ...DEFAULT_COMPANION, enabled: false } },
    );
    expect(next.char_id).toBe("amber");
    expect(next.companion.enabled).toBe(false);
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
