/**
 * deskpet 前端 lint 配置（ESLint 9 flat config）。
 *
 * 职责：语法/静态检查，并用 no-restricted-imports 落地 CODE_STYLE §1.3 的分层边界。
 * 谁调用：pnpm lint 与（未来的）pre-commit / CI。
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "out/**",
      "release/**",
      "data/**",
      "sidecar/**",
      ".venv/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // CODE_STYLE §6：提交里不留 console.log（测试与脚本可局部豁免）
      "no-console": "warn",
      // CODE_STYLE §1.3：禁止跨层深路径 import，必须走模块出口或 IPC 白名单
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
          ],
        },
      ],
    },
  },
  // 纯 JS 配置文件不在 tsconfig 的 project 内，关掉类型感知检查（否则 projectService 报找不到文件）
  { files: ["**/*.js", "**/*.mjs"], extends: [tseslint.configs.disableTypeChecked] },
);
