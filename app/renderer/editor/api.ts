/**
 * 文件职责：编辑器访问主进程的唯一入口（window.deskpet 的类型声明 + 取值）。
 *
 * 为什么单独一个文件：编辑器拆成多个文件后，每个文件都要拿 api；如果各自写 window.deskpet，类型声明会散在多处，改 preload 接口就得挨个找。
 * 依赖方向：renderer -> preload 的类型（只 import type）。
 */

import type { DeskpetApi } from "../../preload/api";

declare global {
  interface Window {
    readonly deskpet: DeskpetApi;
  }
}

export const api: DeskpetApi = window.deskpet;
