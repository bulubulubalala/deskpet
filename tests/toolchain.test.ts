// 文件职责：工具链冒烟测试 —— 确认 Vitest 能加载并执行 TypeScript 模块。
// 依赖方向：tests -> app（只读导入，不启动 Electron）。
import { describe, expect, it } from "vitest";

import { MODULE_NAME as mainModule } from "../app/main/index";
import { MODULE_NAME as preloadModule } from "../app/preload/index";
import { MODULE_NAME as rendererModule } from "../app/renderer/index";

describe("toolchain smoke", () => {
  it("三段进程模块可被 TS 加载", () => {
    expect([mainModule, preloadModule, rendererModule]).toEqual([
      "app/main/index.ts",
      "app/preload/index.ts",
      "app/renderer/index.ts",
    ]);
  });
});
