import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import { commitPackImport, exportPackArchive, inspectPackArchive } from "../app/main/pack-archive";

async function makePack(root: string, id = "amber"): Promise<string> {
  const dir = join(root, id);
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(
    join(dir, "pack.json"),
    JSON.stringify({ pack_version: 1, char_id: id, display_name: "琥珀" }),
  );
  await writeFile(
    join(dir, "card.json"),
    JSON.stringify({
      name: "琥珀",
      display_name: "琥珀",
      description: "测试角色",
      personality: "安静",
      speaking_style: "简短",
    }),
  );
  await writeFile(
    join(dir, "appearance.json"),
    JSON.stringify({ stage: "png", portrait: "assets/portrait.png" }),
  );
  await writeFile(
    join(dir, "hits.json"),
    JSON.stringify({ version: 2, regions: [{ id: "head", name: "头", rect: [0, 0, 1, 0.3] }] }),
  );
  await writeFile(join(dir, "assets", "portrait.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

describe("pack archive", () => {
  it("exports a complete folder and inspects card + hits", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-pack-test-"));
    await makePack(root);
    const output = join(root, "amber.zip");
    const exported = await exportPackArchive(root, "amber", output, {
      includeVoice: true,
      includeModel: true,
    });
    expect(exported.ok).toBe(true);
    expect(exported.files).toBeGreaterThan(0);
    const zip = new AdmZip(output);
    expect(zip.getEntry("amber/card.json")).not.toBeNull();
    expect(zip.getEntry("amber/hits.json")).not.toBeNull();

    const preview = await inspectPackArchive(output);
    expect(preview.ok).toBe(true);
    expect(preview.charId).toBe("amber");
    expect(preview.hasHits).toBe(true);
    expect(preview.regionCount).toBe(1);
    await commitPackImport(
      preview,
      join(root, "target"),
      { includeVoice: true, includeModel: true },
      false,
    );
  });

  it("keeps the existing character by renaming an imported duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-pack-test-"));
    await makePack(root);
    const output = join(root, "amber.zip");
    await exportPackArchive(root, "amber", output, { includeVoice: true, includeModel: true });
    const target = join(root, "target");
    await mkdir(join(target, "amber"), { recursive: true });
    const preview = await inspectPackArchive(output);
    const result = await commitPackImport(
      preview,
      target,
      { includeVoice: true, includeModel: true },
      false,
    );
    expect(result.ok).toBe(true);
    expect(result.charId).toMatch(/^amber-\d+$/);
    expect(result.renamedFrom).toBe("amber");
    expect(await readdir(target)).toEqual(expect.arrayContaining(["amber", result.charId]));
  });

  it("does not generate hits and reports a warning when they are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-pack-test-"));
    const source = await makePack(root);
    await writeFile(join(source, "hits.json"), JSON.stringify({ version: 2, regions: [] }));
    const output = join(root, "empty-hits.zip");
    await exportPackArchive(root, "amber", output, { includeVoice: true, includeModel: true });
    const preview = await inspectPackArchive(output);
    expect(preview.ok).toBe(true);
    expect(preview.hasHits).toBe(false);
    expect(preview.warnings.join(" ")).toContain("没有 hits.json");
  });

  it("accepts directory entries and a ./ prefix from common zip tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-pack-test-"));
    const source = await makePack(root);
    const zipPath = join(root, "directory-entries.zip");
    const zip = new AdmZip();
    zip.addFile("./amber/", Buffer.alloc(0));
    zip.addFile("./amber/assets/", Buffer.alloc(0));
    for (const name of ["pack.json", "card.json", "appearance.json", "hits.json"]) {
      zip.addFile("./amber/" + name, await readFile(join(source, name)));
    }
    zip.addFile(
      "./amber/assets/portrait.png",
      await readFile(join(source, "assets", "portrait.png")),
    );
    zip.writeZip(zipPath);

    const preview = await inspectPackArchive(zipPath);
    expect(preview.ok).toBe(true);
    expect(preview.charId).toBe("amber");
    const target = join(root, "target");
    const result = await commitPackImport(
      preview,
      target,
      { includeVoice: true, includeModel: true },
      false,
    );
    expect(result.ok).toBe(true);
    expect(result.charId).toBe("amber");
    expect(await readdir(join(target, "amber"))).toEqual(
      expect.arrayContaining(["pack.json", "card.json", "assets"]),
    );
  });

  it("imports a pack nested one wrapper directory deep", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-pack-test-"));
    const source = await makePack(root);
    const zipPath = join(root, "wrapped.zip");
    const zip = new AdmZip();
    for (const name of ["pack.json", "card.json", "appearance.json", "hits.json"]) {
      zip.addFile("wrapper/amber/" + name, await readFile(join(source, name)));
    }
    zip.addFile(
      "wrapper/amber/assets/portrait.png",
      await readFile(join(source, "assets", "portrait.png")),
    );
    zip.writeZip(zipPath);

    const preview = await inspectPackArchive(zipPath);
    expect(preview.ok).toBe(true);
    expect(preview.charId).toBe("amber");
    const target = join(root, "target");
    const result = await commitPackImport(
      preview,
      target,
      { includeVoice: true, includeModel: true },
      false,
    );
    expect(result.ok).toBe(true);
    expect(result.charId).toBe("amber");
    expect(await readdir(join(target, "amber"))).toEqual(expect.arrayContaining(["pack.json"]));
  });

  it("rejects an archive with path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-pack-test-"));
    const zipPath = join(root, "bad.zip");
    const zip = new AdmZip();
    zip.addFile("../evil.txt", Buffer.from("evil"));
    zip.writeZip(zipPath);
    const preview = await inspectPackArchive(zipPath);
    expect(preview.ok).toBe(false);
    expect(preview.error).not.toBe("");
  });
});
