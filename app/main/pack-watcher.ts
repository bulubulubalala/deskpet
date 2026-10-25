/**
 * 文件职责：监听 characters/ 的变化，把「哪个角色包变了」防抖地通知主进程（F6）。
 * 只负责发现变化；校验与广播由组合根做，写坏包时保留旧界面。
 */

import { watch, type FSWatcher } from "node:fs";

import type { MainLogger } from "./logger";

export interface PackWatcherDeps {
  readonly charactersDir: string;
  readonly onChanged: (charId: string) => void;
  readonly logger: MainLogger;
  readonly debounceMs?: number;
}

export class CharacterPackWatcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: PackWatcherDeps) {}

  start(): void {
    if (this.watcher !== null) {
      return;
    }
    try {
      this.watcher = watch(this.deps.charactersDir, { recursive: true }, (_event, filename) => {
        if (filename === null) {
          return;
        }
        const charId = String(filename).split(/[\\/]/)[0] ?? "";
        if (charId === "" || charId.startsWith(".")) {
          return;
        }
        this.queue(charId);
      });
      this.watcher.on("error", (error) => {
        this.deps.logger.warn("pack.watch_failed", "监听角色目录失败：" + String(error));
      });
    } catch (error: unknown) {
      this.deps.logger.warn("pack.watch_failed", "监听角色目录失败：" + String(error));
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private queue(charId: string): void {
    const previous = this.timers.get(charId);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    const timer = setTimeout(() => {
      this.timers.delete(charId);
      this.deps.onChanged(charId);
    }, this.deps.debounceMs ?? 350);
    this.timers.set(charId, timer);
  }
}
