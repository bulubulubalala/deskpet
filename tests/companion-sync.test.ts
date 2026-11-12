import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCompanionSync } from "../app/main/companion-sync";
import type { UiStatePayload } from "../app/shared/contracts/ipc";

type Companion = UiStatePayload["companion"];

function state(companion: Partial<Companion> = {}): UiStatePayload {
  return {
    x: 100,
    y: 100,
    scale: 1,
    click_through: true,
    always_on_top: false,
    char_id: "snow",
    stage_width: 400,
    stage_height: 600,
    gestures: { triggers: ["button"], enabled: [] },
    tts_enabled: true,
    native_mic_fallback: false,
    fps: 60,
    companion: {
      enabled: true,
      screen_enabled: false,
      screen_interval_s: 5,
      screen_display_id: "primary",
      ocr_enabled: false,
      vision_model: "m1",
      proactive_enabled: true,
      observe_memory: false,
      app_activity_enabled: true,
      vision_consented: false,
      quiet_hours_start: -1,
      quiet_hours_end: -1,
      ...companion,
    },
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  const activity = { clear: vi.fn(), record: vi.fn() };
  const presence = { setScreenObservation: vi.fn(), report: vi.fn(() => Promise.resolve()) };
  const client = {
    ocrScreen: vi.fn(),
    captureScreen: vi.fn(),
    writeScreenMemory: vi.fn(() => Promise.resolve(true)),
  };
  return {
    activity,
    presence,
    client,
    input: {
      activity: activity as never,
      client: client as never,
      readState: () => current,
      presence: () => presence,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
      capture: () => Promise.resolve({ jpeg: Buffer.from("frame"), appTitle: "vscode" }),
      now: () => Date.now(),
      ...overrides,
    },
  };
}

let current: UiStatePayload | undefined = undefined;

describe("屏幕观察与陪伴设置", () => {
  beforeEach(() => {
    current = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("开着 OCR 时优先用本地识别结果，模型名取识别引擎", async () => {
    current = state({ ocr_enabled: true });
    const d = deps();
    d.client.ocrScreen.mockResolvedValue({
      text: "编辑器窗口",
      confidence: 0.9,
      engine: "rapidocr",
    });
    const sync = createCompanionSync(d.input);

    const observation = await sync.observe({ jpeg: Buffer.from("x"), appTitle: "vscode" });

    expect(observation.summary).toBe("编辑器窗口");
    expect(observation.interesting).toBe(true);
    expect(observation.visionModel).toBe("rapidocr");
    expect(d.client.captureScreen).not.toHaveBeenCalled();
  });

  it("OCR 失败后这一次退回视觉摘要，并在冷却期内不再重试 OCR", async () => {
    current = state({ ocr_enabled: true });
    let clock = 1_000_000;
    const d = deps({ now: () => clock });
    d.client.ocrScreen.mockRejectedValue(new Error("没有 tesseract"));
    d.client.captureScreen.mockResolvedValue({
      summary: "一个代码编辑器",
      interesting: true,
      confidence: 0.5,
      visionModel: "m1",
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    const sync = createCompanionSync(d.input);

    const first = await sync.observe({ jpeg: Buffer.from("x"), appTitle: "vscode" });
    expect(first.summary).toBe("一个代码编辑器");
    expect(d.client.ocrScreen).toHaveBeenCalledTimes(1);

    clock += 60_000;
    await sync.observe({ jpeg: Buffer.from("y"), appTitle: "vscode" });
    expect(d.client.ocrScreen).toHaveBeenCalledTimes(1);
  });

  it("关掉 OCR 时直接用视觉摘要，并把设置里的模型名带上", async () => {
    current = state({ ocr_enabled: false, vision_model: "qwen-vl" });
    const d = deps();
    d.client.captureScreen.mockResolvedValue({
      summary: "浏览器",
      interesting: true,
      confidence: 0.7,
      visionModel: "qwen-vl",
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    const sync = createCompanionSync(d.input);

    await sync.observe({ jpeg: Buffer.from("x"), appTitle: "chrome" });

    expect(d.client.ocrScreen).not.toHaveBeenCalled();
    expect(d.client.captureScreen).toHaveBeenCalledWith(
      expect.any(Buffer),
      "chrome",
      expect.any(String),
      "qwen-vl",
    );
  });

  it("关掉陪伴时把用户改的每个开关都记成一条动态", () => {
    const d = deps();
    const sync = createCompanionSync(d.input);
    sync.sync(state());
    sync.sync(state({ enabled: false }));

    // 关掉陪伴那一下只记一条总账；之后单独改子开关才逐条记
    expect(d.activity.record).toHaveBeenCalledTimes(1);
    expect(d.activity.record).toHaveBeenCalledWith("用户关闭了主动陪伴，希望暂时不被打扰。");

    sync.sync(state({ enabled: false, screen_enabled: true, observe_memory: true }));
    // 两个子开关各记一条
    expect(d.activity.record).toHaveBeenCalledTimes(3);
    expect(d.activity.record).toHaveBeenLastCalledWith("用户重新允许了观察记忆。");
  });

  it("没有同意看屏幕就不启动观察循环", async () => {
    vi.useFakeTimers();
    current = state({ screen_enabled: true, vision_consented: false });
    const d = deps();
    const sync = createCompanionSync(d.input);
    sync.sync(current);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(d.client.captureScreen).not.toHaveBeenCalled();
  });

  it("观察结果进记忆：同摘要不重复写，60 秒冷却内换摘要也不写", async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    let summary = "甲";
    let frames = 0;
    current = state({
      screen_enabled: true,
      vision_consented: true,
      observe_memory: true,
      screen_interval_s: 2,
    });
    const d = deps({
      now: () => clock,
      capture: () =>
        Promise.resolve({ jpeg: Buffer.from("frame" + String(frames++)), appTitle: "vscode" }),
    });
    d.client.captureScreen.mockImplementation(() =>
      Promise.resolve({
        summary,
        interesting: true,
        confidence: 0.5,
        visionModel: "m1",
        capturedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const sync = createCompanionSync(d.input);
    sync.sync(current);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(d.client.writeScreenMemory).toHaveBeenCalledTimes(1);
    expect(d.client.writeScreenMemory).toHaveBeenCalledWith("snow", "甲");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(d.client.writeScreenMemory).toHaveBeenCalledTimes(1);

    clock += 30_000;
    summary = "乙";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(d.client.writeScreenMemory).toHaveBeenCalledTimes(1);

    clock += 40_000;
    summary = "丙";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(d.client.writeScreenMemory).toHaveBeenCalledTimes(2);
    expect(d.client.writeScreenMemory).toHaveBeenLastCalledWith("snow", "丙");
    sync.stop();
  });
});
