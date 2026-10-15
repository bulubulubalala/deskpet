/**
 * 文件职责：设置窗渲染层——外观开关（缩放 / 穿透 / 置顶）、引擎状态与版本信息。
 *
 * 为什么状态面板搬到这里：F11 规定主窗只有立绘与聊天条，模块明细需要一个常规窗口承接；
 * 这里读的是与主窗同一份界面状态（IPC deskpet:ui:*），所以两边永远一致。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 */

import type { HealthView } from "../main/engine";
import type { ModuleName } from "../main/ipc";
import type { DeskpetApi } from "../preload/api";

declare global {
  interface Window {
    readonly deskpet: DeskpetApi;
  }
}

const STATE_LABELS: Record<HealthView["state"], string> = {
  starting: "正在启动",
  offline: "离线（等待自动重启）",
  online: "在线",
  restarting: "正在重启后台引擎",
  failed: "启动失败（已达到自动重启上限）",
};

const MODULE_LABELS: Record<ModuleName, string> = {
  tts: "语音合成",
  asr: "语音识别",
  llm: "语言模型",
  memory: "记忆",
  screen: "屏幕识别",
  stage: "形象舞台",
};

const MODULE_STATE_LABELS: Record<string, string> = {
  idle: "待命",
  loading: "加载中",
  ready: "就绪",
  error: "异常",
  offline: "未启动",
};

const api = window.deskpet;

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setText(id: string, value: string): void {
  const element = byId(id);
  if (element !== null) {
    element.textContent = value;
  }
}

function showBanner(message: string): void {
  const banner = byId("settings-banner");
  if (banner !== null) {
    banner.hidden = false;
    banner.textContent = message;
  }
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? minutes + " 分 " + (total % 60) + " 秒" : total + " 秒";
}

function renderHealth(view: HealthView): void {
  setText("engine-state", STATE_LABELS[view.state]);
  setText("port-text", view.sidecar_port === null ? "—" : String(view.sidecar_port));
  setText("pid-text", view.sidecar_pid === null ? "—" : String(view.sidecar_pid));
  setText("uptime-text", formatUptime(view.uptime_s));
  setText("version-text", view.version ?? "—");
  setText("restarts-text", String(view.restarts_used));

  const list = byId("module-list");
  if (list === null) {
    return;
  }
  list.replaceChildren();
  for (const module of view.modules ?? []) {
    const item = document.createElement("li");
    item.className = "module " + module.state;
    const name = document.createElement("span");
    name.className = "module-name";
    name.textContent = MODULE_LABELS[module.name] ?? module.name;
    const state = document.createElement("span");
    state.className = "module-state";
    state.textContent = MODULE_STATE_LABELS[module.state] ?? module.state;
    item.append(name, state);
    if (module.detail !== undefined) {
      const detail = document.createElement("span");
      detail.className = "module-detail";
      detail.textContent = module.detail;
      item.append(detail);
    }
    list.append(item);
  }
  if (list.childElementCount === 0) {
    const empty = document.createElement("li");
    empty.className = "module empty";
    empty.textContent = view.state === "online" ? "还没有模块上报状态" : "后台引擎未就绪";
    list.append(empty);
  }
}

function renderScale(value: number): void {
  const range = byId("scale-range");
  if (range instanceof HTMLInputElement) {
    range.value = String(value);
  }
  setText("scale-value", value.toFixed(2) + "×");
}

async function main(): Promise<void> {
  if (api === undefined) {
    showBanner("preload 桥没有注入（window.deskpet 不存在）。");
    return;
  }

  try {
    const state = await api.ui.getState();
    renderScale(state.scale);
    const clickThrough = byId("click-through");
    if (clickThrough instanceof HTMLInputElement) {
      clickThrough.checked = state.click_through;
    }
    const alwaysOnTop = byId("always-on-top");
    if (alwaysOnTop instanceof HTMLInputElement) {
      alwaysOnTop.checked = state.always_on_top;
    }
  } catch (error: unknown) {
    showBanner("读取界面状态失败：" + String(error));
  }
  api.ui.onStateChanged((state) => {
    renderScale(state.scale);
  });

  const range = byId("scale-range");
  range?.addEventListener("change", () => {
    if (range instanceof HTMLInputElement) {
      void api.ui.setState({ scale: Number(range.value) });
    }
  });
  byId("click-through")?.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      void api.ui.setState({ click_through: input.checked });
    }
  });
  byId("always-on-top")?.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      void api.ui.setState({ always_on_top: input.checked });
    }
  });
  byId("restart-button")?.addEventListener("click", () => {
    void api.sidecar.restart().then(renderHealth);
  });

  try {
    renderHealth(await api.health.get());
  } catch (error: unknown) {
    showBanner("读取心跳失败：" + String(error));
  }
  api.health.onChanged(renderHealth);

  try {
    const info = await api.app.getInfo();
    setText("app-version", info.app_version);
  } catch (error: unknown) {
    setText("app-version", "读取失败：" + String(error));
  }
}

void main();
