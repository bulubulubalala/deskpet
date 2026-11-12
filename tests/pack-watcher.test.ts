import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MainLogger } from "../app/main/logger";
import { CharacterPackWatcher } from "../app/main/pack-watcher";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => undefined,
} as unknown as MainLogger;

const watchers: CharacterPackWatcher[] = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.stop();
  }
});

describe("CharacterPackWatcher", () => {
  it("reports the changed character id after debounce", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-pack-watch-"));
    await mkdir(join(root, "amber"), { recursive: true });
    const changed = vi.fn();
    const watcher = new CharacterPackWatcher({
      charactersDir: root,
      onChanged: changed,
      logger,
      debounceMs: 20,
    });
    watchers.push(watcher);
    watcher.start();

    await writeFile(join(root, "amber", "card.json"), "{}", "utf8");

    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("amber"), { timeout: 2000 });
  });
});
