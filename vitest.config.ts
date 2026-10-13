/**
 * Vitest 配置：只跑不依赖 GPU / 麦克风的纯逻辑与契约测试（CODE_STYLE §7）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "app/**/*.test.ts"],
  },
});
