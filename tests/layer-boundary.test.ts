import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 分层边界的行为级守卫（D2）。
 *
 * 为什么除了 eslint 还要再测一遍：eslint 的自定义规则一旦被人顺手放宽，就再没有第二道闸；
 * 这里直接扫源码，说明「渲染层一行都不能碰主进程」是产品约束，不是某条 lint 规则的实现细节。
 */

const ROOT = process.cwd();

export interface ImportStatement {
  readonly typeOnly: boolean;
  readonly specifier: string;
}

/** 逐行扫 import 语句（合并跨行），返回模块说明符与是否 import type。 */
export function importStatements(source: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  let buffer: string | null = null;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (buffer === null) {
      if (!trimmed.startsWith("import ")) {
        continue;
      }
      buffer = trimmed;
    } else {
      buffer = buffer + " " + trimmed;
    }
    const fromMatch = /from\s+"([^"]+)"/.exec(buffer);
    const bareMatch = /^import\s+"([^"]+)"/.exec(buffer);
    if (fromMatch === null && bareMatch === null) {
      continue;
    }
    const specifier = fromMatch?.[1] ?? bareMatch?.[1] ?? "";
    out.push({ typeOnly: /^import\s+type\s/.test(buffer), specifier });
    buffer = null;
  }
  return out;
}

function collect(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collect(path));
      continue;
    }
    if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/** 收集命中 pattern 的 import；includeType=false 时忽略 import type（类型在编译期被擦除）。 */
function offendersOf(files: readonly string[], pattern: RegExp, includeType: boolean): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    for (const statement of importStatements(readFileSync(file, "utf8"))) {
      if (!includeType && statement.typeOnly) {
        continue;
      }
      if (!pattern.test(statement.specifier)) {
        continue;
      }
      offenders.push(file.replace(ROOT + "/", "") + " -> " + statement.specifier);
    }
  }
  return offenders;
}

function runtimeImportsOf(files: readonly string[], pattern: RegExp): string[] {
  return offendersOf(files, pattern, false);
}

describe("分层边界", () => {
  it("渲染层与 preload 完全不 import 主进程（连 import type 也不行）", () => {
    const files = [...collect(join(ROOT, "app/renderer")), ...collect(join(ROOT, "app/preload"))];
    expect(files.length).toBeGreaterThan(10);
    expect(offendersOf(files, /(^|\/)main\//, true)).toEqual([]);
  });

  it("主进程不反向 import 渲染层或 preload", () => {
    const files = collect(join(ROOT, "app/main"));
    expect(runtimeImportsOf(files, /(^|\/)(renderer|preload)\//)).toEqual([]);
  });

  it("app/shared 保持纯：不 import electron、node 内置与任何应用层", () => {
    const files = collect(join(ROOT, "app/shared"));
    expect(files.length).toBeGreaterThan(0);
    expect(runtimeImportsOf(files, /^(electron|node:)|(^|\/)(main|renderer|preload)\//)).toEqual(
      [],
    );
  });
});

describe("importStatements", () => {
  it("识别跨行 import 与 import type", () => {
    const source = [
      "import type { A,",
      '  B } from "../main/ipc";',
      'import { C } from "../shared/defaults";',
      'import "side-effect";',
    ].join("\n");
    expect(importStatements(source)).toEqual([
      { typeOnly: true, specifier: "../main/ipc" },
      { typeOnly: false, specifier: "../shared/defaults" },
      { typeOnly: false, specifier: "side-effect" },
    ]);
  });
});
