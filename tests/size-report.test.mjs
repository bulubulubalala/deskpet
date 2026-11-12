// 文件职责：scripts/size_report.mjs 的纯逻辑测试（聚合、报告文案、预算判定）。
//
// 为什么值得测：这张表是 D7「把包压到 150 MiB」的唯一尺子，聚合层级一旦算错，
// 后面所有优化都会对着错误的数字做决策。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SIZE_BUDGET_MIB,
  aggregateTree,
  formatReport,
  overBudgetText,
} from "../scripts/size_report.mjs";

const MIB = 1024 * 1024;
const roots = [];

async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), "deskpet-size-"));
  roots.push(root);
  for (const [path, bytes] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, Buffer.alloc(bytes, 1));
  }
  return root;
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true });
});

describe("aggregateTree", () => {
  it("按前 depth 段路径聚合并按大小降序", async () => {
    const root = await makeTree({
      "resources/sidecar/sidecar.exe": 300,
      "resources/sidecar/_internal/lib.dll": 200,
      "resources/app.asar": 100,
      "deskpet.exe": 50,
    });
    const { total, groups } = await aggregateTree(root, { depth: 2 });
    expect(total).toBe(650);
    expect(groups[0]).toEqual({ path: "resources/sidecar", size: 500 });
    expect(groups.map((group) => group.path)).toEqual([
      "resources/sidecar",
      "resources/app.asar",
      "deskpet.exe",
    ]);
  });

  it("depth=1 时把子目录一起算进顶层目录", async () => {
    const root = await makeTree({
      "resources/sidecar/a.bin": 10,
      "resources/app.asar": 5,
    });
    const { groups } = await aggregateTree(root, { depth: 1 });
    expect(groups[0]).toEqual({ path: "resources", size: 15 });
  });

  it("目录不存在时返回空结果而不是抛错", async () => {
    const { total, groups } = await aggregateTree(join(tmpdir(), "deskpet-does-not-exist-xyz"));
    expect(total).toBe(0);
    expect(groups).toEqual([]);
  });
});

describe("formatReport", () => {
  it("报告里同时有总大小、预算差额与前三名贡献者", () => {
    const text = formatReport({
      total: 931.2 * MIB,
      groups: [
        { path: "resources", size: 540.4 * MIB },
        { path: "deskpet.exe", size: 234.9 * MIB },
      ],
      limit: 2,
      root: "release/win-unpacked",
    });
    expect(text).toContain("release/win-unpacked");
    expect(text).toContain("931.2 MiB");
    expect(text).toContain("超出 781.2 MiB");
    expect(text).toContain("resources");
    expect(text).toContain("deskpet.exe");
  });

  it("合计为 0 时不会除零", () => {
    const text = formatReport({ total: 0, groups: [], budgetMib: SIZE_BUDGET_MIB, root: "/x" });
    expect(text).toContain("合计：0.0 MiB");
    expect(text).toContain(`还差 ${SIZE_BUDGET_MIB.toFixed(1)} MiB 到预算`);
  });
});

describe("overBudgetText", () => {
  it("低于预算时说的是「还差」而不是「超出」", () => {
    expect(overBudgetText(140 * MIB, SIZE_BUDGET_MIB)).toBe("还差 10.0 MiB 到预算");
  });

  it("超预算时给出超出量", () => {
    expect(overBudgetText(160 * MIB, SIZE_BUDGET_MIB)).toBe("超出 10.0 MiB");
  });

  it("正好等于预算时不算超出", () => {
    expect(overBudgetText(SIZE_BUDGET_MIB * MIB, SIZE_BUDGET_MIB)).toBe("还差 0.0 MiB 到预算");
  });
});
