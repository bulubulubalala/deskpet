/**
 * 文件职责：设置窗的开发者面板（T2.3-B1）——入口手势、三页签切换、装配三页并接管角色列表。
 *
 * 为什么单独一个模块：这块只在连点版本号 20 次后出现，普通用户看不到；它还要与记忆面板共用
 * 一份角色列表，混在主入口里会让导航、外观、开发者三件事互相牵连。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 */

import { api, byId, showBanner } from "../dom";
import { setDevCharacterHook } from "../memory";
import { refreshDevData } from "./data";
import { refreshDevContext } from "./context";
import { refreshDevRaw } from "./raw";
import {
  devState,
  DEV_TAP_RESET_MS,
  DEV_TAP_TARGET_COUNT,
  selectPane,
  setSelectPane,
} from "./state";

/** 一次版本号点击：先判间隔，再攒次数；连满 20 次翻转开关（进入与退出一套手势）。 */
function onVersionClicked(): void {
  const now = Date.now();
  if (now - devState.tapLastAt > DEV_TAP_RESET_MS) {
    devState.tapCount = 0;
  }
  devState.tapLastAt = now;
  devState.tapCount += 1;
  if (devState.tapCount < DEV_TAP_TARGET_COUNT) {
    return;
  }
  devState.tapCount = 0;
  void setDevMode(!devState.enabled);
}

/** 写开关并立刻按结果重画面板；写失败只提示，界面状态不动（免得显示一个没存下的状态）。 */
async function setDevMode(enabled: boolean): Promise<void> {
  try {
    const result = await api.dev.set({ enabled });
    applyDevMode(result.enabled);
    showBanner(result.enabled ? "已进入开发者模式。" : "已关闭开发者模式。");
  } catch (error: unknown) {
    showBanner("切换开发者模式失败：" + String(error));
  }
}

/** 读一次开关；设置窗刚打开时调用。读不到就当没开——普通用户不该看到横幅报错。 */
async function loadDevMode(): Promise<void> {
  try {
    applyDevMode((await api.dev.get()).enabled);
  } catch {
    applyDevMode(false);
  }
}

/** 面板显隐；打开时把三页都拉一遍（原文 + 注入预览 + 可编辑事实）。 */
function applyDevMode(enabled: boolean): void {
  devState.enabled = enabled;
  const nav = byId("dev-nav");
  if (nav !== null) {
    nav.hidden = !enabled;
  }
  if (!enabled && document.body.dataset["pane"] === "dev") {
    selectPane("appearance");
  }
  if (enabled) {
    selectPane("dev");
    void refreshDevRaw();
    void refreshDevContext();
    void refreshDevData();
  }
}

/** 三个 tab 只切显隐，不落盘：关掉设置窗再打开回到「原文」。 */
function selectDevTab(name: "raw" | "context" | "data"): void {
  const rawTab = byId("dev-tab-raw");
  const contextTab = byId("dev-tab-context");
  const dataTab = byId("dev-tab-data");
  const rawPane = byId("dev-pane-raw");
  const contextPane = byId("dev-pane-context");
  const dataPane = byId("dev-pane-data");
  if (rawTab !== null) {
    rawTab.classList.toggle("active", name === "raw");
  }
  if (contextTab !== null) {
    contextTab.classList.toggle("active", name === "context");
  }
  if (dataTab !== null) {
    dataTab.classList.toggle("active", name === "data");
  }
  if (rawPane !== null) {
    rawPane.hidden = name !== "raw";
  }
  if (contextPane !== null) {
    contextPane.hidden = name !== "context";
  }
  if (dataPane !== null) {
    dataPane.hidden = name !== "data";
  }
  if (name === "context") {
    void refreshDevContext();
  }
  if (name === "data") {
    void refreshDevData();
  }
}

export function isDevEnabled(): boolean {
  return devState.enabled;
}

/** 开发者模式开着才重拉三页；关着时什么也不做（普通用户不该为这块多付一次请求）。 */
function refreshDevIfActive(): void {
  if (!devState.enabled) {
    return;
  }
  void refreshDevRaw();
  void refreshDevContext();
  void refreshDevData();
}

export interface DevPaneOptions {
  /** 切到某一页（由设置窗主入口提供，避免本模块去改导航 DOM）。 */
  readonly selectPane: (name: string) => void;
}

/**
 * 开发者面板接线：连点版本号入口、三个 tab、刷新与关闭按钮，并接管记忆面板刷出来的角色列表。
 *
 * 角色列表为什么走钩子：两个下拉必须显示同一份角色（T2.3-B1），但列表是记忆面板拉回来的；
 * 让记忆模块反过来改这里的 DOM 会把两个面板粘死，所以改成「记忆面板刷新完喊一声」。
 */
export async function initDevPane(options: DevPaneOptions): Promise<void> {
  setSelectPane(options.selectPane);
  byId("app-version")?.addEventListener("click", onVersionClicked);
  byId("dev-close")?.addEventListener("click", () => {
    void setDevMode(false);
  });
  byId("dev-refresh")?.addEventListener("click", () => {
    void refreshDevRaw();
    void refreshDevContext();
    void refreshDevData();
  });
  byId("dev-more")?.addEventListener("click", () => {
    void refreshDevRaw(true);
  });
  byId("dev-tab-raw")?.addEventListener("click", () => {
    selectDevTab("raw");
  });
  byId("dev-tab-context")?.addEventListener("click", () => {
    selectDevTab("context");
  });
  byId("dev-tab-data")?.addEventListener("click", () => {
    selectDevTab("data");
  });
  byId("dev-preview")?.addEventListener("click", () => {
    void refreshDevContext();
  });
  setDevCharacterHook((preferred, characters) => {
    const devSelect = byId("dev-char");
    if (!(devSelect instanceof HTMLSelectElement)) {
      return;
    }
    devSelect.replaceChildren();
    for (const character of characters) {
      const option = document.createElement("option");
      option.value = character.char_id;
      option.textContent = character.display_name + "（" + character.char_id + "）";
      devSelect.append(option);
    }
    devState.charId = preferred;
    if (preferred !== null) {
      devSelect.value = preferred;
    }
    // 开发者面板比记忆面板先接线：那时还没有角色，三页数据是空拉。角色列表到位后补拉一遍。
    refreshDevIfActive();
    devSelect.onchange = () => {
      devState.charId = devSelect.value;
      devState.rawItems = [];
      devState.rawBefore = null;
      void refreshDevRaw();
      void refreshDevContext();
      void refreshDevData();
    };
  });
  await loadDevMode();
}
