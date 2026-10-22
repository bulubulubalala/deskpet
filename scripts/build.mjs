/**
 * 文件职责：把 app/ 下的 TypeScript 源码打包进 dist/（Electron 只认 JS，源码是 TS）。
 *
 * 为什么用 esbuild 而不是 tsc：它把「转换 + 打包」一步做完，主进程 / preload / renderer
 * 三个目标共用同一份配置，构建耗时在百毫秒级；tsc 只负责类型检查（pnpm typecheck）。
 * 为什么每个目标格式不同：main 与 preload 跑在 Node 里要 CJS（electron 是 external），
 * renderer 跑在浏览器里用 IIFE，避免任何模块加载器假设。
 * 谁调用：package.json 的 build / dev 脚本；打包时 electron-builder 之前必须先跑它。
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

/** 三个进程共用的打包选项；electron 由运行时提供，不能打进产物。 */
const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  external: ["electron"],
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    ...shared,
    entryPoints: [join(root, "app", "main", "index.ts")],
    outfile: join(dist, "main", "index.js"),
    platform: "node",
    target: "node20",
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: [join(root, "app", "preload", "index.ts")],
    outfile: join(dist, "preload", "index.js"),
    platform: "node",
    target: "node20",
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: [join(root, "app", "renderer", "index.ts")],
    outfile: join(dist, "renderer", "index.js"),
    platform: "browser",
    target: "es2022",
    format: "iife",
  }),
  // 设置窗是独立的第二个渲染层入口（T1.12a）：与主窗共用 style.css，两份页面各自打包
  build({
    ...shared,
    entryPoints: [join(root, "app", "renderer", "settings.ts")],
    outfile: join(dist, "renderer", "settings.js"),
    platform: "browser",
    target: "es2022",
    format: "iife",
  }),
  // 角色包编辑器（T2.3-D）：第三个渲染层入口，自带 editor.css（画布布局与设置窗差得远）
  build({
    ...shared,
    entryPoints: [join(root, "app", "renderer", "editor.ts")],
    outfile: join(dist, "renderer", "editor.js"),
    platform: "browser",
    target: "es2022",
    format: "iife",
  }),
  build({
    ...shared,
    entryPoints: [join(root, "app", "renderer", "companion.ts")],
    outfile: join(dist, "renderer", "companion.js"),
    platform: "browser",
    target: "es2022",
    format: "iife",
  }),
]);

for (const file of [
  "index.html",
  "settings.html",
  "editor.html",
  "companion.html",
  "style.css",
  "settings.css",
  "theme.css",
  "editor.css",
  "companion.css",
]) {
  await cp(join(root, "app", "renderer", file), join(dist, "renderer", file));
}
await cp(join(root, "app", "renderer", "assets"), join(dist, "renderer", "assets"), {
  recursive: true,
});

console.log("构建完成：" + dist);
