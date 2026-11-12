/**
 * 文件职责：把主进程的在场快照定时送给 sidecar，并执行主动决定（F5 / F9）。
 * 窗口最小化/隐藏的硬门槛在这里与 sidecar 各守一遍：快照仍有 event，但绝不开口。
 */

import type { MainLogger } from "./logger";
import type { PresenceDecision, PresenceRequest } from "./sidecar-client";

export interface PresenceReporterDeps {
  readonly snapshot: () => PresenceRequest | null;
  readonly decide: (request: PresenceRequest) => Promise<PresenceDecision>;
  readonly onProactive: (request: PresenceRequest, decision: PresenceDecision) => Promise<void>;
  readonly logger: MainLogger;
  readonly intervalMs?: number;
}

export class PresenceReporter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private generation = 0;
  private screenChanged = false;
  private screenText = "";

  constructor(private readonly deps: PresenceReporterDeps) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setScreenObservation(text: string): void {
    const body = text.trim();
    if (body === "" || body === this.screenText) {
      return;
    }
    this.screenText = body;
    this.screenChanged = true;
  }

  async report(): Promise<void> {
    const request = this.deps.snapshot();
    if (request === null) {
      return;
    }
    const payload: PresenceRequest = {
      ...request,
      screen_changed: request.screen_changed || this.screenChanged,
      screen_text: request.screen_text || this.screenText,
    };
    this.screenChanged = false;
    const generation = this.generation;
    let decision: PresenceDecision;
    try {
      decision = await this.deps.decide(payload);
    } catch (error: unknown) {
      this.deps.logger.debug("presence.failed", "在场快照上报失败：" + String(error));
      return;
    }
    if (generation !== this.generation || !decision.proactive) {
      return;
    }
    if (!payload.window_visible || payload.window_minimized || payload.turn_active) {
      this.deps.logger.debug("presence.suppressed", "窗口不可见或用户正忙，主动开口取消");
      return;
    }
    try {
      await this.deps.onProactive(payload, decision);
    } catch (error: unknown) {
      this.deps.logger.debug("presence.proactive_failed", "主动开口失败：" + String(error));
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.deps.intervalMs ?? 30_000);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.schedule();
      return;
    }
    this.running = true;
    try {
      await this.report();
    } finally {
      this.running = false;
      if (!this.stopped && this.timer === null) {
        this.schedule();
      }
    }
  }
}
