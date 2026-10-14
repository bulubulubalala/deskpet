/**
 * 文件职责：渲染进程入口——把主进程推来的心跳状态画到界面上（M0 只做这一件事）。
 *
 * 为什么先只做心跳：M0 的验收标准是「壳 ↔ 大脑」这条链路能被看见（docs/PLAN.md §3），
 * 聊天界面与形象舞台属于 M1/M3；现在多画的东西都要重写。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 * 写入一律用 textContent / createElement，不用 innerHTML（注入防线，需求 §7.4）。
 */
import type { HealthView } from "../main/engine";
import type { ModuleName } from "../main/ipc";
import type { DeskpetApi } from "../preload/api";

declare global {
  interface Window {
    readonly deskpet: DeskpetApi;
  }
}

/** 状态中文名；界面用词要和 sidecar 的真实状态对应，不许美化（需求 §6.7「让 UI 说实话」）。 */
const STATE_LABELS: Record<HealthView["state"], string> = {
  starting: "正在启动",
  online: "在线",
  offline: "离线（等待自动重启）",
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

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setText(id: string, value: string): void {
  const element = byId(id);
  if (element !== null) {
    element.textContent = value;
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

/** 状态灯：颜色只由状态决定，方便一眼看出「灯红了」。 */
function renderState(view: HealthView): void {
  const dot = byId("state-dot");
  if (dot !== null) {
    dot.className = "dot " + view.state;
  }
  setText("state-text", STATE_LABELS[view.state]);
  setText("port-text", view.sidecar_port === null ? "—" : String(view.sidecar_port));
  setText("pid-text", view.sidecar_pid === null ? "—" : String(view.sidecar_pid));
  setText("uptime-text", formatUptime(view.uptime_s));
  setText("version-text", view.version ?? "—");
  setText("restarts-text", String(view.restarts_used));
  const errorRow = byId("error-row");
  if (errorRow !== null) {
    errorRow.hidden = view.last_error === null;
  }
  setText("error-text", view.last_error ?? "");
}

/** 模块列表用 DOM API 拼，避免把 sidecar 返回的文本当 HTML 解析。 */
function renderModules(view: HealthView): void {
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

function render(view: HealthView): void {
  renderState(view);
  renderModules(view);
}

/** 界面自己的兜底：渲染层出错也要让人看见，而不是白屏。 */
function showFatal(message: string): void {
  const banner = byId("banner");
  if (banner !== null) {
    banner.hidden = false;
    banner.textContent = message;
  }
}

async function main(): Promise<void> {
  const api = (window as unknown as { deskpet?: DeskpetApi }).deskpet;
  if (api === undefined) {
    showFatal("preload 桥没有注入（window.deskpet 不存在），请检查打包产物里的 preload 路径。");
    return;
  }

  try {
    render(await api.health.get());
  } catch (error) {
    showFatal("读取心跳失败：" + String(error));
  }
  api.health.onChanged(render);

  const restartButton = byId("restart-button");
  restartButton?.addEventListener("click", () => {
    if (restartButton instanceof HTMLButtonElement) {
      restartButton.disabled = true;
    }
    void api.sidecar
      .restart()
      .then(render)
      .catch((error: unknown) => {
        showFatal("重启后台引擎失败：" + String(error));
      })
      .finally(() => {
        if (restartButton instanceof HTMLButtonElement) {
          restartButton.disabled = false;
        }
      });
  });

  try {
    const info = await api.app.getInfo();
    setText("app-version", info.app_version);
  } catch (error) {
    setText("app-version", "读取失败：" + String(error));
  }
}

void main();
