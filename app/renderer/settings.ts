/**
 * 文件职责：设置窗主入口——左侧导航、外观开关（缩放 / 穿透 / 置顶）、手势，以及各面板的装配。
 *
 * 面板各自一个模块（settings/ 下）：系统状态与使用统计、模型供给、角色包、记忆、开发者。
 * 每个面板自带 `init`，按键接线跟着面板走；主入口只按顺序装配，不掺面板内部逻辑。
 *
 * 为什么状态面板搬到这里：F11 规定主窗只有立绘与聊天条，模块明细需要一个常规窗口承接；
 * 这里读的是与主窗同一份界面状态（IPC deskpet:ui:*），所以两边永远一致。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 */

import type { TouchGesture, UiFps, UiGestureSettings } from "../shared/contracts/ipc";
import { UI_FPS_OPTIONS } from "../shared/defaults";
import { initDevPane, isDevEnabled } from "./settings/dev";
import { api, byId, isChecked, setChecked, setText, showBanner } from "./settings/dom";
import { handleMainCharChanged, initMemoryPane } from "./settings/memory";
import { onPackExport, onPackImport, setPackStatus } from "./settings/packs";
import { refreshProviders } from "./settings/providers";
import {
  bindAsrModelDownload,
  bindUpdateCheck,
  bindUsageControls,
  loadMicStatus,
  refreshAsrModel,
  refreshUsageStats,
  renderFps,
  renderHealth,
  renderScale,
} from "./settings/system";

/** 设置窗允许的页码；主进程带 ?pane= 打开时用它挡住非法值。 */
const PANE_IDS = [
  "appearance",
  "gestures",
  "packs",
  "providers",
  "engine",
  "memory",
  "dev",
] as const;

/** 从 URL 的 ?pane= 读要落在哪一页；没有或不认识就回「外观」。 */
function initialPane(): string {
  const requested = new URLSearchParams(location.search).get("pane") ?? "";
  return (PANE_IDS as readonly string[]).includes(requested) ? requested : "appearance";
}

/** 左侧导航切页：同一时间只显示一个 pane；开发者模式关闭时不允许停在 dev 页。 */
function selectPane(name: string): void {
  const target = name === "dev" && !isDevEnabled() ? "appearance" : name;
  const nav = byId("settings-nav");
  if (nav !== null) {
    for (const button of Array.from(nav.querySelectorAll<HTMLButtonElement>(".nav-item"))) {
      const active = button.dataset["pane"] === target;
      const label = button.querySelector(".nav-label")?.textContent ?? "";
      if (label !== "") {
        button.title = label;
        button.setAttribute("aria-label", label);
      }
      button.classList.toggle("active", active);
      if (active) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }
  for (const pane of Array.from(document.querySelectorAll<HTMLElement>(".settings-pane"))) {
    pane.hidden = pane.dataset["pane"] !== target;
  }
  document.body.dataset["pane"] = target;
  // 只有切到「后台引擎」才去问语音识别模型：别在打开设置窗时白打一次 sidecar
  if (target === "engine") {
    void refreshAsrModel();
  }
}
/** 手势设置（方案 §5.1）：进入互动模式的方式 + 启用哪些手势；改完立刻写 data/ui.json。 */
let gestureState: UiGestureSettings = {
  triggers: ["button"],
  enabled: ["tap", "stroke", "hold", "knead", "pat"],
};

const GESTURE_ENABLED_IDS: readonly (readonly [TouchGesture, string])[] = [
  ["tap", "gesture-tap"],
  ["stroke", "gesture-stroke"],
  ["hold", "gesture-hold"],
  ["knead", "gesture-knead"],
  ["pat", "gesture-pat"],
];

function readGestureControls(): UiGestureSettings {
  return {
    triggers: gestureState.triggers,
    enabled: GESTURE_ENABLED_IDS.filter(([, id]) => isChecked(id)).map(([value]) => value),
  };
}

/** 把界面上这几个勾选框刷成给定状态（读存档、保存回包、被拒绝回滚时都用它）。 */
function applyGestureControls(settings: UiGestureSettings): void {
  gestureState = settings;
  for (const [value, id] of GESTURE_ENABLED_IDS) {
    setChecked(id, settings.enabled.includes(value));
  }
}

function bindGestureControls(): void {
  const ids = GESTURE_ENABLED_IDS.map(([, id]) => id);
  for (const id of ids) {
    byId(id)?.addEventListener("change", () => {
      const next = readGestureControls();
      if (next.enabled.length === 0) {
        showBanner("至少要留一个手势。");
        applyGestureControls(gestureState);
        return;
      }
      void api.ui
        .setState({ gestures: next })
        .then((state) => {
          applyGestureControls(state.gestures);
          showBanner("手势设置已保存。");
        })
        .catch((error: unknown) => {
          showBanner("保存手势设置失败：" + String(error));
        });
    });
  }
}

async function main(): Promise<void> {
  if (api === undefined) {
    showBanner("preload 桥没有注入（window.deskpet 不存在）。");
    return;
  }

  let currentChar: string | null = null;
  try {
    const state = await api.ui.getState();
    currentChar = state.char_id;
    renderScale(state.scale);
    renderFps(state.fps);
    const clickThrough = byId("click-through");
    if (clickThrough instanceof HTMLInputElement) {
      clickThrough.checked = state.click_through;
    }
    const alwaysOnTop = byId("always-on-top");
    if (alwaysOnTop instanceof HTMLInputElement) {
      alwaysOnTop.checked = state.always_on_top;
    }
    const nativeFallback = byId("native-mic-fallback");
    if (nativeFallback instanceof HTMLInputElement) {
      nativeFallback.checked = state.native_mic_fallback;
    }
    applyGestureControls(state.gestures);
  } catch (error: unknown) {
    showBanner("读取界面状态失败：" + String(error));
  }
  api.ui.onStateChanged((state) => {
    handleMainCharChanged(state.char_id);
    renderScale(state.scale);
    renderFps(state.fps);
    applyGestureControls(state.gestures);
    const nativeFallback = byId("native-mic-fallback");
    if (nativeFallback instanceof HTMLInputElement) {
      nativeFallback.checked = state.native_mic_fallback;
    }
  });
  bindGestureControls();

  const range = byId("scale-range");
  range?.addEventListener("change", () => {
    if (range instanceof HTMLInputElement) {
      void api.ui.setState({ scale: Number(range.value) });
    }
  });
  byId("fps-select")?.addEventListener("change", (event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement) {
      const fps = Number(select.value);
      if ((UI_FPS_OPTIONS as readonly number[]).includes(fps)) {
        void api.ui.setState({ fps: fps as UiFps });
      }
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
  byId("native-mic-fallback")?.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      void api.ui.setState({ native_mic_fallback: input.checked });
    }
  });
  byId("restart-button")?.addEventListener("click", () => {
    void api.sidecar.restart().then(renderHealth);
  });
  byId("mic-settings-button")?.addEventListener("click", () => {
    void api.voice.openMicSettings();
  });
  byId("mic-sound-button")?.addEventListener("click", () => {
    void api.voice.openSoundSettings();
  });
  byId("pack-export")?.addEventListener("click", () => {
    void onPackExport();
  });
  byId("pack-import")?.addEventListener("click", () => {
    void onPackImport();
  });
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
    }
  });
  document.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files.item(0);
    if (file === undefined || file === null) {
      return;
    }
    event.preventDefault();
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setPackStatus("pack-import-status", "拖入的文件不是 zip 角色包", true);
      return;
    }
    void onPackImport(api.pack.pathForFile(file));
  });

  try {
    renderHealth(await api.health.get());
  } catch (error: unknown) {
    showBanner("读取心跳失败：" + String(error));
  }
  api.health.onChanged(renderHealth);
  void loadMicStatus();

  // 模型供给与心跳互不依赖：并行拉，谁慢都不挡另一个先显示
  void refreshProviders();
  // 开发者面板先接线：它要接管记忆面板刷出来的角色列表（两个下拉共用一份，T2.3-B1）
  await initDevPane({ selectPane });
  // 记忆面板自己接线：按钮、模型进度、角色变更广播、行为开关都在 app/renderer/settings/memory.ts
  initMemoryPane({ currentChar });

  void refreshUsageStats();
  bindUsageControls();
  bindAsrModelDownload();
  bindUpdateCheck();

  byId("settings-nav")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest<HTMLButtonElement>(".nav-item");
    const pane = button?.dataset["pane"];
    if (pane !== undefined) {
      selectPane(pane);
    }
  });
  // 主进程可以带 ?pane=providers 打开（首次运行引导 / 引擎失败引导），优先于默认页
  selectPane(isDevEnabled() ? "dev" : initialPane());
  // 探针 / 冒烟的就绪标记：手势绑好之后再置位，否则脚本可能在监听器挂上之前就把 20 次点击发完
  // （真机第一跑就这么假失败过：点击全发在绑定之前，计数器永远是 0）。
  document.body.dataset.devReady = "1";

  try {
    const info = await api.app.getInfo();
    setText("app-version", info.app_version);
  } catch (error: unknown) {
    setText("app-version", "读取失败：" + String(error));
  }
}

void main();
