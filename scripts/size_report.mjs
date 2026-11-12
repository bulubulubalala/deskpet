#!/usr/bin/env node
// 文件职责：量一下发出去的东西到底有多大、大在哪（D7 体积优化的尺子）。
//
// 为什么单独一个脚本：每次改打包配置都要回答「省了多少」，靠肉眼翻 release/ 里的
// 目录树既慢又容易看错层级（Electron 的 dll、PyInstaller 的 _internal、资源文件混在
// 一起）。这里按「目录前缀」聚合成一张表，直接对着 150 MiB 的预算看差多少。
//
// 用法：
//   node scripts/size_report.mjs                    # 默认量 release/win-unpacked
//   node scripts/size_report.mjs --dir release/win-unpacked --budget 150
//   node scripts/size_report.mjs --dir dist/sidecar --depth 3

import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 便携包体积预算（MiB，D7）。 */
export const SIZE_BUDGET_MIB = 150;

const MIB = 1024 * 1024;

/**
 * 递归累计目录里每个文件的字节数，并按前 `depth` 段路径聚合。
 *
 * 为什么要聚合而不是列每个文件：一个 PyInstaller onedir 有几万个文件，逐行看没有意义；
 * 「哪个顶层目录吃掉一半」才是能动手的地方。
 */
export async function aggregateTree(root, { depth = 2 } = {}) {
  const buckets = new Map();
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue; // 符号链接/junction 跳过，避免重复计数
      let size = 0;
      try {
        size = (await stat(path)).size;
      } catch {
        continue;
      }
      total += size;
      const parts = relative(root, path).split(sep).slice(0, depth);
      const bucket = parts.join("/");
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + size);
    }
  }
  await walk(root);
  const groups = [...buckets.entries()]
    .map(([path, size]) => ({ path, size }))
    .sort((a, b) => b.size - a.size);
  return { total, groups };
}

/** 报告正文（纯函数，便于测试与复用）。 */
export function formatReport({
  total,
  groups,
  budgetMib = SIZE_BUDGET_MIB,
  limit = 12,
  root = "",
}) {
  const lines = [];
  lines.push(`路径：${root}`);
  lines.push(
    `合计：${(total / MIB).toFixed(1)} MiB（预算 ${budgetMib} MiB，${overBudgetText(total, budgetMib)}）`,
  );
  lines.push("最大贡献者：");
  for (const group of groups.slice(0, limit)) {
    const share = total === 0 ? 0 : (group.size / total) * 100;
    lines.push(
      `  ${(group.size / MIB).toFixed(1).padStart(7)} MiB  ${share.toFixed(1).padStart(5)}%  ${group.path}`,
    );
  }
  return lines.join("\n");
}

export function overBudgetText(total, budgetMib) {
  const diff = total / MIB - budgetMib;
  return diff <= 0 ? `还差 ${Math.abs(diff).toFixed(1)} MiB 到预算` : `超出 ${diff.toFixed(1)} MiB`;
}

async function main(argv) {
  const args = parseArgs(argv);
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = resolve(repoRoot, args.dir);
  const { total, groups } = await aggregateTree(root, { depth: args.depth });
  if (total === 0) {
    throw new Error(`${root} 里没有文件（还没打包？先跑 scripts\\build_release.ps1）`);
  }
  console.log(formatReport({ total, groups, budgetMib: args.budget, limit: args.limit, root }));
}

function parseArgs(argv) {
  const args = { dir: "release/win-unpacked", depth: 2, budget: SIZE_BUDGET_MIB, limit: 12 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--dir") {
      args.dir = value;
      index += 1;
    } else if (argv[index] === "--depth") {
      args.depth = Number(value) || 2;
      index += 1;
    } else if (argv[index] === "--budget") {
      args.budget = Number(value) || SIZE_BUDGET_MIB;
      index += 1;
    } else if (argv[index] === "--limit") {
      args.limit = Number(value) || 12;
      index += 1;
    }
  }
  return args;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("size_report.mjs");
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`体积报告失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
