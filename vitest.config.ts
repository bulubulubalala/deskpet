/**
 * Vitest 配置：只跑不依赖 GPU / 麦克风的纯逻辑与契约测试（CODE_STYLE §7）。
 *
 * 覆盖率（D5）：provider 只在 `pnpm test:coverage` 与 CI 里启用，日常 `pnpm test` 不插桩。
 * 阈值先只报告——存量代码从 0 到 40% 需要时间，门槛一上来就只会逼出「为了过线」的空测试。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // scripts/ 下是构建期 Node 脚本（.mjs），它们的纯逻辑测试也用 .mjs 写：
    // 脚本本身不在 tsconfig 的编译范围里，测试没必要为它编一份类型。
    include: ["tests/**/*.test.ts", "tests/**/*.test.mjs", "app/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["app/**/*.ts"],
      exclude: [
        "app/**/*.test.ts",
        // 渲染层的 DOM 装配与 Electron 适配器要真机才有意义，先不虚报它们的覆盖率
        "app/main/index.ts",
        "app/main/windows.ts",
        "app/preload/**",
        "app/renderer/index.ts",
      ],
    },
  },
});
