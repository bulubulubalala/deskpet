/**
 * 文件职责：主进程用到的各处静态路径（页面、preload、托盘图标、模型目录）。
 *
 * 为什么单独一个文件：这些路径只取决于「编译产物在哪」与「是否打包」，没有任何运行时状态；
 * 以前它们散在 index.ts 里和窗口装配混着，想核对「打包后文件到底在哪」得翻半个文件。
 * 依赖方向：main/* -> 本文件；本文件不 import 任何应用模块，也不读配置。
 */

import { app } from "electron";
import { join } from "node:path";

/** 主窗页面（打包后是 dist/renderer/index.html，与 dist/main/index.js 平级）。 */
export function rendererIndexPath(): string {
  return join(__dirname, "..", "renderer", "index.html");
}

export function settingsHtmlPath(): string {
  return join(__dirname, "..", "renderer", "settings.html");
}

export function companionHtmlPath(): string {
  return join(__dirname, "..", "renderer", "companion.html");
}

export function editorHtmlPath(): string {
  return join(__dirname, "..", "renderer", "editor.html");
}

/** 模型目录清单：打包后在资源目录（asar 外的 config/），开发态在仓库根。 */
export function modelCatalogPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "config", "model-catalog.json")
    : join(app.getAppPath(), "config", "model-catalog.json");
}

export function preloadPath(): string {
  return join(__dirname, "..", "preload", "index.js");
}

export function trayIconPath(): string {
  return join(__dirname, "..", "renderer", "assets", "placeholder.png");
}
