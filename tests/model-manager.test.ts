import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ModelManager } from "../app/main/model-manager";
import type { MainLogger } from "../app/main/logger";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => undefined,
} as unknown as MainLogger;

describe("ModelManager", () => {
  it("reads the catalog and reports external/file status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-models-"));
    const catalog = join(dir, "catalog.json");
    await writeFile(
      catalog,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "edge",
            capability: "tts",
            label: "Edge",
            description: "在线",
            kind: "external",
            source: { type: "edge" },
          },
          {
            id: "piper",
            capability: "tts",
            label: "Piper",
            description: "本地",
            kind: "files",
            target: "models/piper",
            size_mb: 63,
            source: {
              type: "url",
              files: [{ url: "https://example.test/a.onnx", path: "a.onnx" }],
            },
          },
        ],
      }),
      "utf8",
    );
    const manager = new ModelManager({
      dataDir: dir,
      catalogFile: catalog,
      logger,
      emit: () => undefined,
    });
    const statuses = await manager.list();
    expect(statuses).toHaveLength(2);
    expect(statuses[0]?.installed).toBe(true);
    expect(statuses[1]?.installed).toBe(false);
  });

  it("rejects path traversal in model targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-models-"));
    const catalog = join(dir, "catalog.json");
    await writeFile(
      catalog,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "bad",
            capability: "tts",
            label: "bad",
            description: "",
            kind: "files",
            target: "../../outside",
            source: { type: "url", files: [] },
          },
        ],
      }),
      "utf8",
    );
    const manager = new ModelManager({
      dataDir: dir,
      catalogFile: catalog,
      logger,
      emit: () => undefined,
    });
    await expect(manager.install("bad")).rejects.toThrow("越界");
  });
});
