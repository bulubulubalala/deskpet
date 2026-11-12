import { createHash } from "node:crypto";

import type { MainLogger } from "./logger";

export interface CapturedFrame {
  readonly jpeg: Buffer;
  readonly appTitle: string;
}

export interface ScreenObservation {
  readonly summary: string;
  readonly interesting: boolean;
  readonly confidence: number;
  readonly visionModel: string;
  readonly capturedAt: string;
}

export interface ScreenWatcherDeps {
  readonly capture: () => Promise<CapturedFrame | null>;
  readonly observe: (frame: CapturedFrame) => Promise<ScreenObservation>;
  readonly enabled: () => boolean;
  readonly intervalMs: () => number;
  readonly onObservation: (observation: ScreenObservation) => void;
  readonly onError: (error: unknown) => void;
  readonly logger: MainLogger;
}

export class ScreenWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastHash = "";

  constructor(private readonly deps: ScreenWatcherDeps) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.stop();
    if (!this.deps.enabled()) {
      return;
    }
    const next = Math.max(2000, this.deps.intervalMs());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, next);
  }

  private async tick(): Promise<void> {
    if (!this.deps.enabled()) {
      this.schedule();
      return;
    }
    if (this.busy) {
      this.schedule();
      return;
    }
    this.busy = true;
    try {
      const frame = await this.deps.capture();
      if (frame !== null && this.deps.enabled()) {
        const hash = createHash("sha1").update(frame.jpeg).digest("hex");
        if (hash === this.lastHash) {
          return;
        }
        const observation = await this.deps.observe(frame);
        this.lastHash = hash;
        if (observation.summary !== "") {
          this.deps.onObservation(observation);
        }
      }
    } catch (error: unknown) {
      this.deps.onError(error);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
}
