import { describe, expect, it, vi } from "vitest";

import type { MainLogger } from "../app/main/logger";
import { PresenceReporter } from "../app/main/presence-reporter";
import type { PresenceDecision, PresenceRequest } from "../app/main/sidecar-client";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => undefined,
} as unknown as MainLogger;

function request(overrides: Partial<PresenceRequest> = {}): PresenceRequest {
  return {
    char_id: "amber",
    session_id: "s1",
    window_visible: true,
    window_minimized: false,
    window_focused: true,
    idle_seconds: 1800,
    input_mode: "text",
    turn_active: false,
    quiet_hours: false,
    screen_changed: false,
    screen_text: "",
    mic_busy: false,
    ...overrides,
  };
}

function decision(proactive: boolean): PresenceDecision {
  return { proactive, kind: proactive ? "idle_checkin" : "", reason: "" };
}

describe("PresenceReporter", () => {
  it("never executes proactive while the window is minimized", async () => {
    const onProactive = vi.fn(() => Promise.resolve());
    const reporter = new PresenceReporter({
      snapshot: () => request({ window_minimized: true }),
      decide: () => Promise.resolve(decision(true)),
      onProactive,
      logger,
    });

    await reporter.report();

    expect(onProactive).not.toHaveBeenCalled();
  });

  it("executes a proactive decision and forwards the latest screen text", async () => {
    const onProactive = vi.fn(() => Promise.resolve());
    const decide = vi.fn(() => Promise.resolve(decision(true)));
    const reporter = new PresenceReporter({
      snapshot: () => request(),
      decide,
      onProactive,
      logger,
    });
    reporter.setScreenObservation("编辑器里有一个报错");

    await reporter.report();

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        screen_changed: true,
        screen_text: "编辑器里有一个报错",
      }),
    );
    expect(onProactive).toHaveBeenCalledWith(
      expect.objectContaining({ char_id: "amber" }),
      expect.objectContaining({ kind: "idle_checkin" }),
    );
  });

  it("does not call onProactive when sidecar declines", async () => {
    const onProactive = vi.fn(() => Promise.resolve());
    const reporter = new PresenceReporter({
      snapshot: () => request(),
      decide: () => Promise.resolve(decision(false)),
      onProactive,
      logger,
    });

    await reporter.report();

    expect(onProactive).not.toHaveBeenCalled();
  });
});
