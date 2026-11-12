/**
 * 文件职责：设置窗各面板共用的小工具（取元素、写文本、顶部提示、勾选框）。
 *
 * 为什么单独一个文件：设置窗按面板拆成多个模块后，这些函数每个模块都要用；
 * 它们只碰 DOM 与 window.deskpet，不认识任何面板的业务概念。
 * 依赖方向：renderer -> preload 白名单（window.deskpet）；不 import 主进程实现。
 */

import type { DeskpetApi } from "../../preload/api";

declare global {
  interface Window {
    readonly deskpet: DeskpetApi;
  }
}

export const api = window.deskpet;

export function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function setText(id: string, value: string): void {
  const element = byId(id);
  if (element !== null) {
    element.textContent = value;
  }
}

export function showBanner(message: string): void {
  const banner = byId("settings-banner");
  if (banner !== null) {
    banner.hidden = false;
    banner.textContent = message;
  }
}

/** 勾选框读值；元素不存在时按「开」处理（与历史行为一致，避免误关功能）。 */
export function checked(id: string): boolean {
  const input = byId(id);
  return input instanceof HTMLInputElement ? input.checked : true;
}

export function isChecked(id: string): boolean {
  const input = byId(id);
  return input instanceof HTMLInputElement && input.checked;
}

export function setChecked(id: string, value: boolean): void {
  const input = byId(id);
  if (input instanceof HTMLInputElement) {
    input.checked = value;
  }
}
