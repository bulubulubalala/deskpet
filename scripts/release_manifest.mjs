#!/usr/bin/env node
// 文件职责：发布产物清单与校验和（D6 发布工程第一步）。
//
// 为什么需要它：便携 zip 是唯一的发布形态，用户拿到的是一个几百 MB 的压缩包，
// 没有任何办法确认「下载完整、没被中间人改过」。SHA256SUMS.txt 与 release.json
// 是零成本的可验证凭据，也是出问题时唯一能复述「这一版到底是什么」的记录。
//
// 用法（Windows 侧，electron-builder 跑完之后）：
//   node scripts/release_manifest.mjs
//   node scripts/release_manifest.mjs --dir release --skip-unpacked-check
//
// 产物：
//   release/SHA256SUMS.txt              `<sha256>  <文件名>`，每行一个
//   release/deskpet-<版本>-release.json 版本、提交、构建时间、平台、各文件大小与哈希

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 便携包里必须存在的路径（相对 zip 解压后的根目录）。 */
export const REQUIRED_ENTRIES = [
  "deskpet.exe",
  "resources/sidecar/sidecar.exe",
  "resources/config/model-catalog.json",
  "models/embedding",
];

/** 参与校验和/清单的文件后缀：只列用户真正下载的东西。 */
const ARTIFACT_PATTERN = /\.(zip|exe|7z)$/i;

export function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

/**
 * 生成 SHA256SUMS.txt 的内容：按文件名排序、每行 `hash  name`（两个空格，sha256sum 的格式）、
 * 结尾单个换行。排序是为了让同样的产物在不同机器上生成一模一样的文件，方便比对。
 */
export function formatChecksums(entries) {
  return (
    entries
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => `${entry.sha256}  ${entry.name}`)
      .join("\n") + "\n"
  );
}

/** 列出目录里要写进清单的文件（不递归；release/ 里的产物都在顶层）。 */
export async function collectArtifacts(dir) {
  const names = (await readdir(dir)).filter((name) => ARTIFACT_PATTERN.test(name)).sort();
  const entries = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    entries.push({ name, size: info.size, sha256: await sha256File(path) });
  }
  return entries;
}

/**
 * 检查 win-unpacked 里的关键文件是否齐全。
 *
 * 只查 zip 内容要解压，代价大；electron-builder 的 win-unpacked 是同一个目录树的内容源，
 * 在打包机上查它足够早、足够便宜。
 */
export async function checkUnpacked(releaseDir) {
  const root = join(releaseDir, "win-unpacked");
  const missing = [];
  for (const entry of REQUIRED_ENTRIES) {
    const path = join(root, ...entry.split("/"));
    let ok = false;
    try {
      ok = await stat(path).then((info) =>
        entry.includes(".") ? info.isFile() : info.isDirectory(),
      );
    } catch {
      ok = false;
    }
    if (!ok) missing.push(entry);
  }
  return { root, missing };
}

export function gitInfo(cwd) {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim() !== "";
    return { commit, dirty };
  } catch {
    return { commit: "", dirty: false };
  }
}

export async function buildManifest({
  version,
  builtAt = new Date(),
  git = {},
  platform,
  arch,
  artifacts,
}) {
  return {
    name: "deskpet",
    version,
    commit: git.commit ?? "",
    dirty: Boolean(git.dirty),
    builtAt: builtAt.toISOString(),
    platform: platform ?? process.platform,
    arch: arch ?? process.arch,
    files: artifacts.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const releaseDir = resolve(repoRoot, args.dir);
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

  const artifacts = await collectArtifacts(releaseDir);
  if (artifacts.length === 0) {
    throw new Error(`${releaseDir} 里没有找到 zip/exe/7z 产物，先跑 scripts\\build_release.ps1`);
  }

  const lines = [];
  if (!args.skipUnpackedCheck) {
    const { root, missing } = await checkUnpacked(releaseDir);
    if (missing.length > 0 && !args.allowIncomplete) {
      throw new Error(
        `${root} 缺少 ${missing.join("、")}，这个包发出去用不了；确认只是临时打包可加 --allow-incomplete`,
      );
    }
    if (missing.length > 0) {
      lines.push(`警告：${root} 缺少 ${missing.join("、")}，这个包可能不完整`);
    }
  }

  await writeFile(join(releaseDir, "SHA256SUMS.txt"), formatChecksums(artifacts), "utf8");
  const manifest = await buildManifest({
    version: pkg.version,
    releaseDir,
    git: gitInfo(repoRoot),
    artifacts,
  });
  const manifestName = `deskpet-${pkg.version}-release.json`;
  await writeFile(join(releaseDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  lines.push(
    `版本 ${pkg.version}（${manifest.commit || "未知提交"}${manifest.dirty ? "，工作区有未提交改动" : ""}）`,
  );
  for (const entry of artifacts) {
    lines.push(
      `  ${entry.name}  ${(entry.size / 1024 / 1024).toFixed(1)} MiB  sha256=${entry.sha256.slice(0, 16)}…`,
    );
  }
  lines.push(`已写出 ${join(releaseDir, "SHA256SUMS.txt")}`);
  lines.push(`已写出 ${join(releaseDir, manifestName)}`);
  console.log(lines.join("\n"));
}

function parseArgs(argv) {
  const args = { dir: "release", skipUnpackedCheck: false, allowIncomplete: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir") {
      args.dir = argv[index + 1];
      index += 1;
    } else if (arg === "--skip-unpacked-check") {
      args.skipUnpackedCheck = true;
    } else if (arg === "--allow-incomplete") {
      args.allowIncomplete = true;
    }
  }
  return args;
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === "release_manifest.mjs";
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`发布清单生成失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
