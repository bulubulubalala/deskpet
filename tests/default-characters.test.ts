import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDefaultCharacters } from "../app/main/default-characters";

const logger = {
  info: () => undefined,
  warn: () => undefined,
};

async function makeDefault(root: string): Promise<void> {
  const char = join(root, "snow");
  await mkdir(join(char, "model"), { recursive: true });
  await writeFile(join(char, "card.json"), '{"display_name":"小雪"}', "utf8");
  await writeFile(join(char, "model", "model.model3.json"), "{}", "utf8");
}

describe("ensureDefaultCharacters", () => {
  it("copies bundled characters only into an empty user directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-default-"));
    const bundled = join(dir, "bundled");
    const user = join(dir, "user");
    await makeDefault(bundled);

    expect(await ensureDefaultCharacters(user, bundled, logger)).toBe(true);
    expect(await readFile(join(user, "snow", "card.json"), "utf8")).toContain("小雪");
    expect(await ensureDefaultCharacters(user, bundled, logger)).toBe(false);
    expect(await readFile(join(user, "snow", "model", "model.model3.json"), "utf8")).toBe("{}");
  });

  it("does nothing when there is no bundled directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-default-"));
    expect(await ensureDefaultCharacters(join(dir, "user"), join(dir, "missing"), logger)).toBe(
      false,
    );
  });

  it("does not overwrite a non-empty user directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-default-"));
    const bundled = join(dir, "bundled");
    const user = join(dir, "user");
    await makeDefault(bundled);
    await mkdir(join(user, "custom"), { recursive: true });
    await writeFile(join(user, "custom", "card.json"), "{}", "utf8");
    expect(await ensureDefaultCharacters(user, bundled, logger)).toBe(false);
  });
});
