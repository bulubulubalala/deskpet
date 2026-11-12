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
      "app/renderer/vendor/**",
      "characters/**",
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
  // 二层以内的子目录（app/main/sidecar/**）允许 ../.. 回到 app/ 取 shared 下的契约，
  // 但仍然不许再往上爬（../../../ 就是仓库根，跨出 app/ 边界）。
  {
    files: ["app/*/*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
          ],
        },
      ],
    },
  },
  // D2 分层边界：契约、通道名与共享常量都住在 app/shared（contracts/ipc.ts、ipc-channels.ts、defaults.ts）。
  // 渲染层与 preload 连「type import 主进程」也不许——否则类型写在谁的文件里，谁就事实上拥有契约。
  {
    files: ["app/renderer/**/*.ts", "app/preload/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
            {
              group: ["**/main/*", "**/main"],
              message:
                "渲染层与 preload 一律不能 import 主进程（D2）：契约在 app/shared/contracts，常量在 app/shared。",
            },
          ],
        },
      ],
    },
  },
  // 渲染层的子目录（如 app/renderer/settings/**）允许 ../.. 回到 app/ 取 shared 下的契约与常量，
  // 但仍然不许再往上爬（../../../ 就出了 app/ 边界）；不许 import 主进程的规则照旧。
  {
    files: ["app/renderer/*/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
            {
              group: ["**/main/*", "**/main"],
              message:
                "渲染层与 preload 一律不能 import 主进程（D2）：契约在 app/shared/contracts，常量在 app/shared。",
            },
          ],
        },
      ],
    },
  },
  // 渲染层的三层子目录（如 app/renderer/settings/memory/**）再多放一档：允许 ../../../ 回到 app/ 取 shared，
  // 但不许出 app/ 边界；不许 import 主进程的规则照旧。
  {
    files: ["app/renderer/*/*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
          ],
        },
      ],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
            {
              group: ["**/main/*", "**/main"],
              message:
                "渲染层与 preload 一律不能 import 主进程（D2）：契约在 app/shared/contracts，常量在 app/shared。",
            },
          ],
        },
      ],
    },
  },
  // app/shared 必须保持纯净：只放常量与类型，不 import Electron、Node 内置实现或任何应用层。
  {
    files: ["app/shared/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["electron", "node:*"],
              message: "app/shared 必须保持纯净（D2）：不 import Electron / Node 实现。",
            },
            {
              group: ["**/main/*", "**/renderer/*", "**/preload/*"],
              message: "app/shared 不能反向 import 应用层（D2）。",
            },
          ],
        },
      ],
    },
  },
  // 反向也挡：主进程不该为了图省事去 import 渲染层的 DOM 代码或 preload 的实现
  {
    files: ["app/main/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
            {
              group: ["**/renderer/*", "**/preload/*"],
              message: "主进程不能反向 import 渲染层/preload（D2）。",
            },
          ],
        },
      ],
    },
  },
  // 主进程的二层子目录（app/main/sidecar/**）允许 ../.. 回到 app/ 取 shared，规则同上收紧一档
  {
    files: ["app/main/*/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../*"],
              message: "禁止跨层深路径 import（CODE_STYLE §1.3）：请走模块出口或 IPC 白名单。",
            },
            {
              group: ["**/renderer/*", "**/preload/*"],
              message: "主进程不能反向 import 渲染层/preload（D2）。",
            },
          ],
        },
      ],
    },
  },
  // 纯 JS 配置文件与构建脚本不在 tsconfig 的 project 内，关掉类型感知检查（否则 projectService 报找不到文件）；
  // 它们跑在 Node 里，console / process 是合法的全局对象，所以显式声明而不是当成未定义
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
        // Node 20+ 的运行时全局：冒烟脚本用它们驱动真实进程与 HTTP（smoke_text.mjs / smoke_memory.mjs）
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        WebSocket: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        AbortController: "readonly",
        crypto: "readonly",
        structuredClone: "readonly",
        Buffer: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
  // 构建脚本本来就是命令行工具，输出进度是它的工作，不按应用代码的口径限制
  { files: ["scripts/**/*.mjs"], rules: { "no-console": "off" } },
);
