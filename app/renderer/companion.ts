import type { CompanionSettings, ModelProgress, ModelStatus, UiStatePayload } from "../main/ipc";
import type { DeskpetApi } from "../preload/api";

declare global {
  interface Window {
    readonly deskpet: DeskpetApi;
  }
}

const api = window.deskpet;
let current: UiStatePayload | null = null;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showBanner(message: string, bad = false): void {
  const banner = byId<HTMLElement>("companion-banner");
  if (banner === null) {
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
  banner.classList.toggle("bad", bad);
  window.setTimeout(() => {
    banner.hidden = true;
  }, 3200);
}

function featureOn(settings: CompanionSettings, key: keyof CompanionSettings): boolean {
  return settings.enabled || settings[key] === true;
}

function quietOptions(selected: number): string {
  const options = ['<option value="-1">不启用</option>'];
  for (let hour = 0; hour < 24; hour += 1) {
    const text = String(hour).padStart(2, "0") + ":00";
    options.push('<option value="' + String(hour) + '">' + text + "</option>");
  }
  void selected;
  return options.join("");
}

let modelStatuses: ModelStatus[] = [];
const modelProgress = new Map<string, ModelProgress>();

function capabilityLabel(capability: ModelStatus["capability"]): string {
  return capability === "asr" ? "语音识别" : capability === "tts" ? "语音合成" : "屏幕识图";
}

function renderModels(): void {
  const list = byId<HTMLElement>("model-list");
  if (list === null) {
    return;
  }
  list.replaceChildren();
  if (modelStatuses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "没有可用模型。";
    list.append(empty);
    return;
  }
  for (const model of modelStatuses) {
    const row = document.createElement("div");
    row.className = "model-row";
    const copy = document.createElement("div");
    copy.className = "model-copy";
    const title = document.createElement("div");
    title.className = "model-title";
    const name = document.createElement("span");
    name.textContent = model.label;
    const meta = document.createElement("span");
    meta.className = "model-meta";
    meta.textContent =
      capabilityLabel(model.capability) +
      " · " +
      (model.size_mb > 0 ? String(model.size_mb) + " MB" : "无需下载") +
      (model.license ? " · " + model.license : "");
    title.append(name, meta);
    const desc = document.createElement("p");
    desc.className = "model-desc";
    desc.textContent = model.description + " " + model.detail;
    copy.append(title, desc);

    const progress = modelProgress.get(model.id);
    if (progress !== undefined && !progress.done) {
      const bar = document.createElement("div");
      bar.className = "model-progress";
      const fill = document.createElement("span");
      fill.style.width = String(Math.max(0, Math.min(100, progress.percent))) + "%";
      bar.append(fill);
      copy.append(bar);
    }

    const action = document.createElement("button");
    action.type = "button";
    action.className = "secondary-button";
    if (model.installed) {
      action.textContent =
        model.capability === "vision" && model.model_id !== "" ? "使用" : "已安装";
      action.disabled = model.capability !== "vision" || model.model_id === "";
      action.addEventListener("click", () => {
        const base = current?.companion;
        if (base === undefined || model.model_id === "") {
          return;
        }
        void save(companionWith(base, { vision_model: model.model_id }), "已选择视觉模型");
      });
    } else if (model.kind === "external") {
      action.textContent = "外部";
      action.disabled = true;
    } else {
      action.textContent = progress !== undefined && !progress.done ? "安装中…" : "安装";
      action.disabled = progress !== undefined && !progress.done;
      action.addEventListener("click", () => {
        action.disabled = true;
        void api.models
          .install(model.id)
          .then(async () => {
            await refreshModels();
            showBanner("模型安装完成");
          })
          .catch((error: unknown) => {
            showBanner("安装失败：" + String(error), true);
            action.disabled = false;
          });
      });
    }
    row.append(copy, action);
    list.append(row);
  }
}

async function refreshModels(): Promise<void> {
  try {
    modelStatuses = await api.models.list();
    renderModels();
  } catch (error: unknown) {
    showBanner("读取模型目录失败：" + String(error), true);
  }
}

function renderQuietSelects(): void {
  const start = byId<HTMLSelectElement>("quiet-start");
  const end = byId<HTMLSelectElement>("quiet-end");
  if (start === null || end === null) {
    return;
  }
  start.innerHTML = quietOptions(-1);
  end.innerHTML = quietOptions(-1);
}

function render(state: UiStatePayload): void {
  current = state;
  const companion = state.companion;
  const enabled = byId<HTMLInputElement>("companion-enabled");
  if (enabled !== null) {
    enabled.checked = companion.enabled;
  }

  const title = byId<HTMLElement>("companion-title");
  const desc = byId<HTMLElement>("companion-desc");
  if (title !== null) {
    title.textContent = companion.enabled ? "角色正在陪伴你" : "角色暂时不打扰你";
  }
  if (desc !== null) {
    desc.textContent = companion.enabled
      ? "全功能开启：屏幕观察、识图、主动开口、观察记忆和应用动态都在工作。"
      : "陪伴已暂停。下面可以逐项重新授权；打开哪一项，角色就会知道哪一项恢复了。";
  }

  const chip = byId<HTMLElement>("companion-chip");
  const chipText = byId<HTMLElement>("companion-chip-text");
  if (chip !== null && chipText !== null) {
    if (!companion.enabled) {
      chip.dataset["state"] = "offline";
      chipText.textContent = "已暂停";
    } else if (!companion.vision_consented) {
      chip.dataset["state"] = "starting";
      chipText.textContent = "待确认";
    } else {
      chip.dataset["state"] = "online";
      chipText.textContent = "陪伴中";
    }
  }

  const screen = featureOn(companion, "screen_enabled");
  const setChecked = (id: string, checked: boolean): void => {
    const input = byId<HTMLInputElement>(id);
    if (input !== null) {
      input.checked = checked;
      input.disabled = companion.enabled;
    }
  };
  setChecked("screen-enabled", screen);
  setChecked("ocr-enabled", featureOn(companion, "ocr_enabled"));
  setChecked("proactive-enabled", featureOn(companion, "proactive_enabled"));
  setChecked("observe-memory", featureOn(companion, "observe_memory"));
  setChecked("app-activity", featureOn(companion, "app_activity_enabled"));
  const screenInput = byId<HTMLInputElement>("screen-enabled");
  if (screenInput !== null) {
    screenInput.disabled = companion.enabled;
  }
  const ocrInput = byId<HTMLInputElement>("ocr-enabled");
  if (ocrInput !== null) {
    ocrInput.disabled = companion.enabled || !screen;
  }

  const interval = byId<HTMLInputElement>("screen-interval");
  const intervalValue = byId<HTMLOutputElement>("screen-interval-value");
  if (interval !== null) {
    interval.value = String(companion.screen_interval_s);
    interval.disabled = !screen;
  }
  if (intervalValue !== null) {
    intervalValue.textContent = String(companion.screen_interval_s) + " 秒";
  }

  const quietStart = byId<HTMLSelectElement>("quiet-start");
  const quietEnd = byId<HTMLSelectElement>("quiet-end");
  if (quietStart !== null) {
    quietStart.value = String(companion.quiet_hours_start);
    quietStart.disabled = !featureOn(companion, "proactive_enabled");
  }
  if (quietEnd !== null) {
    quietEnd.value = String(companion.quiet_hours_end);
    quietEnd.disabled = !featureOn(companion, "proactive_enabled");
  }

  const vision = byId<HTMLInputElement>("vision-model");
  if (vision !== null) {
    vision.value = companion.vision_model;
    vision.disabled = !screen;
  }

  const consent = byId<HTMLElement>("consent-card");
  if (consent !== null) {
    consent.hidden = !(screen && !companion.vision_consented);
  }
  const consentButton = byId<HTMLButtonElement>("consent-button");
  if (consentButton !== null) {
    const ready = companion.vision_model !== "";
    consentButton.disabled = !ready;
    consentButton.textContent = ready ? "开始观察" : "先在模型库选择识图模型";
  }
}

function companionWith(
  settings: CompanionSettings,
  patch: Partial<CompanionSettings>,
): CompanionSettings {
  return { ...settings, ...patch };
}

async function save(next: CompanionSettings, success: string): Promise<void> {
  try {
    const state = await api.ui.setState({ companion: next });
    render(state);
    showBanner(success);
  } catch (error: unknown) {
    showBanner("保存失败：" + String(error), true);
    if (current !== null) {
      render(current);
    }
  }
}

function bind(): void {
  byId<HTMLInputElement>("companion-enabled")?.addEventListener("change", (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    const base = current?.companion;
    if (base === undefined) {
      return;
    }
    const next = companionWith(base, {
      enabled,
      screen_enabled: enabled,
      ocr_enabled: enabled,
      proactive_enabled: enabled,
      observe_memory: enabled,
      app_activity_enabled: enabled,
    });
    void save(next, enabled ? "主动陪伴已开启" : "主动陪伴已暂停，角色会知道你想安静");
  });

  const bindToggle = (id: string, key: keyof CompanionSettings, label: string): void => {
    byId<HTMLInputElement>(id)?.addEventListener("change", (event) => {
      const base = current?.companion;
      if (base === undefined || base.enabled) {
        return;
      }
      const checked = (event.currentTarget as HTMLInputElement).checked;
      void save(companionWith(base, { [key]: checked }), label + (checked ? "已开启" : "已关闭"));
    });
  };
  bindToggle("screen-enabled", "screen_enabled", "屏幕观察");
  bindToggle("ocr-enabled", "ocr_enabled", "屏幕文字识别");
  bindToggle("proactive-enabled", "proactive_enabled", "主动开口");
  bindToggle("observe-memory", "observe_memory", "观察记忆");
  bindToggle("app-activity", "app_activity_enabled", "应用动态");

  byId<HTMLInputElement>("screen-interval")?.addEventListener("input", (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    const output = byId<HTMLOutputElement>("screen-interval-value");
    if (output !== null) {
      output.textContent = String(value) + " 秒";
    }
  });
  byId<HTMLInputElement>("screen-interval")?.addEventListener("change", (event) => {
    const base = current?.companion;
    if (base === undefined) {
      return;
    }
    const value = Number((event.currentTarget as HTMLInputElement).value);
    void save(companionWith(base, { screen_interval_s: value }), "采样间隔已保存");
  });

  const saveQuiet = (): void => {
    const base = current?.companion;
    const start = byId<HTMLSelectElement>("quiet-start");
    const end = byId<HTMLSelectElement>("quiet-end");
    if (base === undefined || start === null || end === null) {
      return;
    }
    void save(
      companionWith(base, {
        quiet_hours_start: Number(start.value),
        quiet_hours_end: Number(end.value),
      }),
      "安静时段已保存",
    );
  };
  byId<HTMLSelectElement>("quiet-start")?.addEventListener("change", saveQuiet);
  byId<HTMLSelectElement>("quiet-end")?.addEventListener("change", saveQuiet);

  byId<HTMLInputElement>("vision-model")?.addEventListener("change", (event) => {
    const base = current?.companion;
    if (base === undefined) {
      return;
    }
    const value = (event.currentTarget as HTMLInputElement).value.trim();
    void save(companionWith(base, { vision_model: value }), "视觉模型已保存");
  });

  byId<HTMLElement>("consent-button")?.addEventListener("click", () => {
    const base = current?.companion;
    if (base === undefined) {
      return;
    }
    void save(companionWith(base, { vision_consented: true }), "屏幕观察已开启");
  });

  byId<HTMLElement>("open-models")?.addEventListener("click", () => {
    byId<HTMLElement>("model-list")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  byId<HTMLElement>("models-refresh")?.addEventListener("click", () => {
    void refreshModels();
  });
  api.models.onProgress((progress) => {
    modelProgress.set(progress.id, progress);
    renderModels();
    if (progress.done) {
      modelProgress.delete(progress.id);
      void refreshModels();
    }
  });
}

async function main(): Promise<void> {
  if (api === undefined) {
    showBanner("preload 桥没有注入", true);
    return;
  }
  renderQuietSelects();
  bind();
  try {
    render(await api.ui.getState());
  } catch (error: unknown) {
    showBanner("读取陪伴设置失败：" + String(error), true);
  }
  api.ui.onStateChanged(render);
  void refreshModels();
  document.body.dataset["ready"] = "1";
}

void main();
