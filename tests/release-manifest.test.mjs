// 文件职责：发布清单脚本的纯逻辑测试（D6）。
// 只测能在任意平台跑的部分：校验和格式、产物收集、必需文件检查、清单字段。
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REQUIRED_ENTRIES,
  buildManifest,
  checkUnpacked,
  collectArtifacts,
  formatChecksums,
  sha256File,
} from "../scripts/release_manifest.mjs";

const created = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "deskpet-release-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  created.length = 0;
});

describe("formatChecksums", () => {
  it("按文件名排序，每行两个空格分隔，结尾一个换行", () => {
    const text = formatChecksums([
      { name: "b.zip", sha256: "22" },
      { name: "a.zip", sha256: "11" },
    ]);
    expect(text).toBe("11  a.zip\n22  b.zip\n");
  });

  it("空列表也给出空串而不是报错", () => {
    expect(formatChecksums([])).toBe("\n");
  });
});

describe("collectArtifacts", () => {
  it("只收 zip/exe/7z，并算对 sha256 与大小", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "deskpet-0.2.0-x64.zip"), "payload");
    await writeFile(join(dir, "SHA256SUMS.txt"), "ignore me");
    const artifacts = await collectArtifacts(dir);
    expect(artifacts.map((a) => a.name)).toEqual(["deskpet-0.2.0-x64.zip"]);
    expect(artifacts[0].size).toBe(Buffer.byteLength("payload"));
    expect(artifacts[0].sha256).toBe(createHash("sha256").update("payload").digest("hex"));
  });

  it("sha256File 与 createHash 结果一致", async () => {
    const dir = await tempDir();
    const path = join(dir, "x.zip");
    await writeFile(path, Buffer.alloc(1024 * 300, 7));
    expect(await sha256File(path)).toBe(
      createHash("sha256")
        .update(Buffer.alloc(1024 * 300, 7))
        .digest("hex"),
    );
  });
});

describe("checkUnpacked", () => {
  it("文件齐全时不报缺失", async () => {
    const dir = await tempDir();
    for (const entry of REQUIRED_ENTRIES) {
      const path = join(dir, "win-unpacked", ...entry.split("/"));
      if (entry.includes(".")) {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "");
      } else {
        await mkdir(path, { recursive: true });
      }
    }
    const result = await checkUnpacked(dir);
    expect(result.missing).toEqual([]);
  });

  it("缺 sidecar.exe 时点名报出来", async () => {
    const dir = await tempDir();
    const result = await checkUnpacked(dir);
    expect(result.missing).toContain("resources/sidecar/sidecar.exe");
  });
});

describe("buildManifest", () => {
  it("记录版本、提交、平台与每个文件的哈希", async () => {
    const manifest = await buildManifest({
      version: "0.2.0",
      builtAt: new Date("2026-11-09T00:00:00Z"),
      git: { commit: "abc1234", dirty: false },
      platform: "win32",
      arch: "x64",
      artifacts: [{ name: "deskpet-0.2.0-x64.zip", size: 10, sha256: "ff" }],
    });
    expect(manifest).toMatchObject({
      name: "deskpet",
      version: "0.2.0",
      commit: "abc1234",
      dirty: false,
      builtAt: "2026-11-09T00:00:00.000Z",
      platform: "win32",
      arch: "x64",
    });
    expect(manifest.files).toEqual([{ name: "deskpet-0.2.0-x64.zip", size: 10, sha256: "ff" }]);
  });
});
