/**
 * 文件职责：工具链与工程规范冒烟测试——确认 Vitest 能跑 TS，且三个进程入口都带文件头注释。
 *
 * 为什么不 import 三个入口：它们现在会 import electron（主进程/preload），在纯 Node 测试环境里
 * 跑不起来；改为「读源码 + 断言文件头」，既验证文件存在，也把 CODE_STYLE §3 的文件头要求变成自动化检查。
 * 依赖方向：tests -> 源码文件（只读）。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PROCESS_ENTRIES = [
  "app/main/index.ts",
  "app/preload/index.ts",
  "app/renderer/index.ts",
] as const;

describe("工具链与代码规范冒烟", () => {
  it.each(PROCESS_ENTRIES)("%s 存在且带文件职责注释", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source.startsWith("/**")).toBe(true);
    expect(source).toContain("文件职责：");
  });
});
