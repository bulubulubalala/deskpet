/**
 * 文件职责：设置窗里跟「这台机器」有关的面板——引擎状态、外观（缩放/帧率）、使用统计、麦克风权限。
 *
 * 为什么单独一个文件：这些内容全部由 main 推来的健康快照与本地 UI 状态驱动，
 * 不持有记忆或角色业务状态；读代码时能在同一屏里看到「状态怎么变成一行字」。
 */
import type {
  AppUpdateInfo,
  AsrModelState,
  HealthView,
  ModuleName,
  UsageStats,
} from "../../shared/contracts/ipc";
import { api, byId, setText, showBanner } from "./dom";

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

function formatUptime(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? minutes + " 分 " + (total % 60) + " 秒" : total + " 秒";
}

function formatUsageDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? hours + " 小时 " + minutes + " 分" : minutes + " 分";
}

export function renderUsageStats(state: UsageStats): void {
  const totals = byId("usage-totals");
  if (totals !== null) {
    totals.textContent =
      "累计 " +
      String(state.total_sessions) +
      " 次会话 / " +
      String(state.total_messages) +
      " 条消息 / " +
      formatUsageDuration(state.total_duration_sec) +
      "；今天 " +
      String(state.today_sessions) +
      " 次 / " +
      String(state.today_messages) +
      " 条";
  }
  const tokens = byId("usage-tokens");
  if (tokens !== null) {
    if (state.llm_calls <= 0) {
      tokens.textContent = "模型 token：暂无数据（模型服务未上报 usage）";
    } else {
      const cacheRate =
        state.cached_tokens > 0 && state.prompt_tokens > 0
          ? ((state.cached_tokens / state.prompt_tokens) * 100).toFixed(1) + "%"
          : "—（未命中或服务未上报）";
      const average = Math.round(state.prompt_tokens / state.llm_calls);
      tokens.textContent =
        "模型 " +
        String(state.llm_calls) +
        " 次调用；输入 " +
        String(state.prompt_tokens) +
        " / 缓存 " +
        String(state.cached_tokens) +
        " " +
        cacheRate +
        " / 输出 " +
        String(state.completion_tokens) +
        " / 合计 " +
        String(state.total_tokens) +
        "；平均上下文 " +
        String(average) +
        " token，最大 " +
        String(state.max_prompt_tokens) +
        "；记忆注入 " +
        String(state.memory_tokens) +
        " token";
    }
  }
  const chars = byId("usage-chars");
  if (chars !== null) {
    chars.textContent =
      state.characters.length === 0
        ? "按角色：暂无数据"
        : "按角色：" +
          state.characters
            .slice(0, 4)
            .map(
              (item) =>
                item.char_id +
                " " +
                String(item.session_count) +
                " 次 / " +
                formatUsageDuration(item.total_duration_sec),
            )
            .join("；");
  }
  const recording = byId("usage-recording");
  if (recording instanceof HTMLInputElement) {
    recording.checked = state.recording_enabled;
  }
}

export async function refreshUsageStats(): Promise<void> {
  try {
    renderUsageStats(await api.usage.stats());
  } catch (error: unknown) {
    setText("usage-totals", "读取使用统计失败：" + String(error));
    setText("usage-tokens", "");
    setText("usage-chars", "");
  }
}

const MIC_STATUS_LABELS: Record<string, string> = {
  granted: "已允许",
  denied: "被系统拒绝",
  restricted: "受系统限制",
  "not-determined": "尚未决定",
  unknown: "未知",
};

export async function loadMicStatus(): Promise<void> {
  const node = byId("mic-status");
  if (node === null) {
    return;
  }
  try {
    const status = await api.voice.micStatus();
    node.textContent = MIC_STATUS_LABELS[status.status] ?? status.status;
    node.className = status.status === "granted" ? "ok-text" : "bad-text";
  } catch (error: unknown) {
    node.textContent = "读取失败";
    node.className = "bad-text";
    showBanner("读取麦克风权限失败：" + String(error));
  }
}

export function renderHealth(view: HealthView): void {
  setText("engine-state", STATE_LABELS[view.state]);
  const chip = byId("engine-chip");
  if (chip !== null) {
    chip.dataset["state"] = view.state;
  }
  setText("engine-chip-text", STATE_LABELS[view.state]);
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
    const dot = document.createElement("span");
    dot.className = "module-dot";
    const name = document.createElement("span");
    name.className = "module-name";
    name.textContent = MODULE_LABELS[module.name] ?? module.name;
    const state = document.createElement("span");
    state.className = "module-state";
    state.textContent = MODULE_STATE_LABELS[module.state] ?? module.state;
    item.append(dot, name, state);
    if (module.detail !== undefined) {
      state.title = module.detail;
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

export function renderScale(value: number): void {
  const range = byId("scale-range");
  if (range instanceof HTMLInputElement) {
    range.value = String(value);
    const percent = Math.min(100, Math.max(0, ((value - 0.5) / 1.5) * 100));
    range.style.setProperty("--range-fill", percent.toFixed(1) + "%");
  }
  setText("scale-value", value.toFixed(2) + "×");
}

/** 帧率档位（T2.43）：只认 UI_FPS_OPTIONS 里的值，存档里的坏值由主进程回默认。 */
export function renderFps(value: number): void {
  const select = byId("fps-select");
  if (select instanceof HTMLSelectElement) {
    select.value = String(value);
  }
}

/** 使用统计面板的接线：暂停记录开关与清空按钮（统计回包直接重画整块，不做局部 patch）。 */
export function bindUsageControls(): void {
  byId("usage-recording")?.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    void api.usage
      .setRecording(input.checked)
      .then((state) => {
        renderUsageStats(state);
        setText("usage-status", input.checked ? "已恢复记录。" : "已暂停记录。");
      })
      .catch((error: unknown) => setText("usage-status", "保存失败：" + String(error)));
  });
  byId("usage-clear")?.addEventListener("click", () => {
    if (!window.confirm("清空全部使用统计？记录开关会保留，此操作不可撤销。")) {
      return;
    }
    void api.usage
      .clear()
      .then((state) => {
        renderUsageStats(state);
        setText("usage-status", "统计已清空。");
      })
      .catch((error: unknown) => setText("usage-status", "清空失败：" + String(error)));
  });
}

/** 语音识别模型的四种状态各显示成一句话（D7）。 */
const ASR_MODEL_STATUS_LABELS: Record<AsrModelState["status"], string> = {
  ready: "已就绪",
  missing: "还没下载",
  downloading: "正在下载",
  error: "下载失败",
};

/** 下载中每隔这么久问一次进度；只在「正在下载」时排下一次，就绪/失败就停。 */
const ASR_MODEL_POLL_MS = 1500;
let asrModelTimer: ReturnType<typeof setTimeout> | null = null;

/** 把一次状态回包画到「语音识别模型」卡片上（按钮只在没下载 / 失败时出现）。 */
export function renderAsrModel(state: AsrModelState): void {
  const status = byId("asr-model-state");
  if (status === null) {
    return;
  }
  status.textContent = ASR_MODEL_STATUS_LABELS[state.status] ?? state.status;

  const progress = byId("asr-model-progress");
  if (progress instanceof HTMLProgressElement) {
    progress.hidden = state.status !== "downloading";
    progress.value = state.status === "downloading" ? state.progress : 0;
  }

  const button = byId("asr-model-download");
  if (button instanceof HTMLButtonElement) {
    button.hidden = state.status === "ready" || state.status === "downloading";
    button.disabled = false;
    button.textContent = state.status === "error" ? "重新下载" : "下载模型";
  }

  const hint = state.user_hint !== "" ? state.user_hint : "下载一次以后就不用再下。";
  setText("asr-model-hint", state.message === "" ? hint : state.message + " " + hint);
}

/** 正在下载时排一次轮询；已有定时器就不重复排。 */
function scheduleAsrModelPoll(): void {
  if (asrModelTimer !== null) {
    return;
  }
  asrModelTimer = setTimeout(() => {
    asrModelTimer = null;
    void refreshAsrModel();
  }, ASR_MODEL_POLL_MS);
}

/** 拉一次语音识别模型现状；引擎没起来就只提示一句，不轮询（避免离线时一直刷）。 */
export async function refreshAsrModel(): Promise<void> {
  try {
    const state = await api.asr.model();
    renderAsrModel(state);
    if (state.status === "downloading") {
      scheduleAsrModelPoll();
    }
  } catch {
    setText("asr-model-state", "后台引擎未就绪");
    setText("asr-model-hint", "等引擎状态变成「在线」后再看这里。");
  }
}

/** 把一次检查更新的结果画到「版本更新」卡片上；有新版本才露出「打开下载页」。 */
export function renderUpdateInfo(info: AppUpdateInfo): void {
  const openButton = byId("update-open");
  if (openButton instanceof HTMLButtonElement) {
    openButton.hidden = info.status !== "available";
  }

  if (info.status === "available") {
    setText("update-state", `有新版本 ${info.latest_version}`);
    setText(
      "update-hint",
      info.notes === ""
        ? `当前 ${info.current_version}。点「打开下载页」去下新包，覆盖 app/ 目录即可。`
        : `${info.notes}（当前 ${info.current_version}）`,
    );
    return;
  }
  if (info.status === "latest") {
    setText("update-state", "已是最新版本");
    setText(
      "update-hint",
      `当前 ${info.current_version}。便携版升级＝下载新包覆盖 app/ 目录，data/ 与 characters/ 保留。`,
    );
    return;
  }
  setText("update-state", "检查失败");
  setText("update-hint", info.error === "" ? "没能完成检查，稍后再试。" : info.error);
}

/** 点「检查更新」问一次远端；按钮在请求期间禁用，避免连点。 */
export async function checkForUpdate(): Promise<void> {
  const button = byId("update-check");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = "检查中…";
  }
  setText("update-state", "正在检查…");
  setText("update-hint", "");
  try {
    renderUpdateInfo(await api.app.checkUpdate());
  } catch (error: unknown) {
    setText("update-state", "检查失败");
    setText("update-hint", `没能完成检查：${String(error)}`);
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = "再检查一次";
    }
  }
}

/** 绑「检查更新」与「打开下载页」两个按钮；打开地址由主进程决定。 */
export function bindUpdateCheck(): void {
  byId("update-check")?.addEventListener("click", () => {
    void checkForUpdate();
  });
  byId("update-open")?.addEventListener("click", () => {
    void api.app.openUpdatePage().catch((error: unknown) => {
      setText("update-hint", `打不开下载页：${String(error)}`);
    });
  });
}

/** 「下载模型」按钮：起下载任务，然后按 1.5 秒一次看进度。 */
export function bindAsrModelDownload(): void {
  byId("asr-model-download")?.addEventListener("click", () => {
    const button = byId("asr-model-download");
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
    }
    void api.asr
      .prefetchModel()
      .then((state) => {
        renderAsrModel(state);
        if (state.status === "downloading") {
          scheduleAsrModelPoll();
        }
      })
      .catch((error: unknown) => {
        setText("asr-model-state", "没能开始下载");
        setText("asr-model-hint", String(error));
      });
  });
}
