/**
 * 文件职责：设置窗渲染层——外观开关（缩放 / 穿透 / 置顶）、引擎状态与版本信息。
 *
 * 为什么状态面板搬到这里：F11 规定主窗只有立绘与聊天条，模块明细需要一个常规窗口承接；
 * 这里读的是与主窗同一份界面状态（IPC deskpet:ui:*），所以两边永远一致。
 * 依赖方向：renderer -> window.deskpet（preload 白名单）；禁止 import main 的实现模块。
 */

import type { HealthView } from "../main/engine";
import type {
  CharacterSummary,
  MemoryContextItem,
  MemoryContextResponse,
  MemoryContextSection,
  MemoryItem,
  MemoryMessageItem,
  MemoryMessagesRequest,
  MemorySummaryItem,
  ModuleName,
  ProviderCapability,
  ProviderSettingsEntry,
  ProviderSettingsPatchEntry,
  ProviderSettingsPayload,
  ProviderValue,
  TouchGesture,
  UiGestureSettings,
  UsageStats,
} from "../main/ipc";
import { PROVIDER_VALUES } from "../main/ipc";
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

function formatUsageDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? hours + " 小时 " + minutes + " 分" : minutes + " 分";
}

function renderUsageStats(state: UsageStats): void {
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

async function refreshUsageStats(): Promise<void> {
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

async function loadMicStatus(): Promise<void> {
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

function checked(id: string): boolean {
  const input = byId(id);
  return input instanceof HTMLInputElement ? input.checked : true;
}

function setPackStatus(id: string, text: string, bad = false): void {
  const node = byId(id);
  if (node !== null) {
    node.textContent = text;
    node.classList.toggle("bad-text", bad);
  }
}

async function onPackExport(): Promise<void> {
  setPackStatus("pack-export-status", "正在导出…");
  try {
    const state = await api.ui.getState();
    if (state.char_id === null) {
      setPackStatus("pack-export-status", "当前没有可导出的角色。", true);
      return;
    }
    const result = await api.pack.exportPack({
      char_id: state.char_id,
      include_voice: checked("pack-export-voice"),
      include_model: checked("pack-export-model"),
    });
    if (result.canceled) {
      setPackStatus("pack-export-status", "已取消导出。");
      return;
    }
    if (!result.ok) {
      setPackStatus("pack-export-status", "导出失败：" + result.error, true);
      return;
    }
    setPackStatus(
      "pack-export-status",
      "已导出 " + String(result.files) + " 个文件：" + result.path,
    );
  } catch (error: unknown) {
    setPackStatus("pack-export-status", "导出失败：" + String(error), true);
  }
}

async function onPackImport(droppedPath = ""): Promise<void> {
  setPackStatus("pack-import-status", "正在读取 zip…");
  try {
    const result = await api.pack.importPack({
      include_voice: checked("pack-import-voice"),
      include_model: checked("pack-import-model"),
      ...(droppedPath === "" ? {} : { path: droppedPath }),
    });
    if (result.canceled) {
      setPackStatus("pack-import-status", "已取消导入。");
      return;
    }
    if (!result.ok) {
      setPackStatus("pack-import-status", "导入失败：" + result.error, true);
      return;
    }
    let message = "已导入 " + result.display_name + " (" + result.char_id + ")。";
    if (result.renamed_from !== "") {
      message += " 原 ID " + result.renamed_from + " 已保留，新角色改名。";
    }
    if (result.warnings.length > 0) {
      message += " " + result.warnings.join(" ");
    }
    setPackStatus("pack-import-status", message);
  } catch (error: unknown) {
    setPackStatus("pack-import-status", "导入失败：" + String(error), true);
  }
}

function renderHealth(view: HealthView): void {
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

function renderScale(value: number): void {
  const range = byId("scale-range");
  if (range instanceof HTMLInputElement) {
    range.value = String(value);
    const percent = Math.min(100, Math.max(0, ((value - 0.5) / 1.5) * 100));
    range.style.setProperty("--range-fill", percent.toFixed(1) + "%");
  }
  setText("scale-value", value.toFixed(2) + "×");
}

const PROVIDER_LABELS: Record<ProviderCapability, string> = {
  llm: "对话模型",
  asr: "语音识别",
  tts: "语音合成",
};

/** 当前实际生效的供给摘要；本地 LLM 没配时明确说未配置，而不是留空让人猜。 */
function effectiveProviderText(entry: ProviderSettingsEntry): string {
  if (entry.capability === "llm") {
    if (entry.provider === "local") {
      return "当前生效：本地 · " + (entry.local_model.trim() || "未配置（需填本地端点 / 模型）");
    }
    return "当前生效：云端 · " + (entry.cloud_model.trim() || "未配置模型");
  }
  if (entry.capability === "asr") {
    if (entry.provider === "local") {
      return "当前生效：本地 · " + (entry.local_model.trim() || "small（faster-whisper 默认）");
    }
    return "当前生效：云端 · " + (entry.cloud_model.trim() || "whisper-large-v3-turbo（默认）");
  }
  if (entry.provider === "local") {
    return "当前生效：本地 · " + (entry.local_base_url.trim() || "http://127.0.0.1:8742（默认）");
  }
  return "当前生效：Edge 在线合成";
}

type ProviderFieldName = Exclude<keyof ProviderSettingsEntry, "capability" | "provider">;

/**
 * 写进 .env 但绝不回显的字段。
 *
 * 为什么单列：它们不在 ProviderSettingsEntry 里（主进程只回「已配 / 未配」的布尔量），
 * 所以表单字段名是这两者的并集，而读值的一侧要显式处理这两个名字。
 */
type ProviderSecretField = "cloud_api_key" | "local_token";

interface ProviderFieldSpec {
  readonly field: ProviderFieldName | ProviderSecretField;
  readonly label: string;
  /** 密钥类字段：要密码框、只显示「已配 / 未配」、留空表示不修改。 */
  readonly secret?: boolean;
  readonly placeholder?: string;
}

interface ProviderFormSpec {
  readonly cloud: readonly ProviderFieldSpec[];
  readonly local: readonly ProviderFieldSpec[];
  /** edge 在线合成（T2.4）：通常没有可编辑字段，只有一段说明。 */
  readonly edge?: readonly ProviderFieldSpec[];
  readonly cloudNote?: string;
  readonly localNote?: string;
  readonly edgeNote?: string;
  readonly fallback?: readonly ProviderFieldSpec[];
}

/** 每个能力面允许选的来源 + 下拉里显示的名字（顺序即显示顺序）。 */
const PROVIDER_OPTIONS: Record<
  ProviderCapability,
  readonly { value: ProviderValue; label: string }[]
> = {
  llm: [
    { value: "cloud", label: "云端" },
    { value: "local", label: "本地" },
  ],
  asr: [
    { value: "local", label: "本地" },
    { value: "cloud", label: "云端" },
  ],
  tts: [
    { value: "local", label: "本地（IndexTTS）" },
    { value: "edge", label: "Edge 在线" },
  ],
};

/**
 * 每个能力面显示哪些字段。
 *
 * 为什么写在渲染层：键名映射（哪一面用哪个 .env 键）在主进程的 provider-settings.ts，
 * 这里只管「给用户看什么」；云端 ASR / TTS 后置实现前只给一句说明，不给假输入框。
 */
const PROVIDER_FORMS: Record<ProviderCapability, ProviderFormSpec> = {
  llm: {
    cloud: [
      { field: "cloud_base_url", label: "云端端点" },
      { field: "cloud_model", label: "云端模型" },
      { field: "cloud_api_key", label: "云端密钥", secret: true },
    ],
    local: [
      { field: "local_base_url", label: "本地端点", placeholder: "http://127.0.0.1:11434/v1" },
      { field: "local_model", label: "本地模型", placeholder: "例如 qwen2.5:7b" },
    ],
    fallback: [
      { field: "fallback_base_url", label: "备用端点" },
      { field: "fallback_model", label: "备用模型" },
    ],
    localNote:
      "本地端点指向你自己起的服务（如 Ollama / LM Studio / vLLM 的 OpenAI 兼容口），本项目不装、不启、不调参；不填就是没配本地模型。",
  },
  asr: {
    cloud: [
      { field: "cloud_base_url", label: "云端端点" },
      { field: "cloud_model", label: "云端模型" },
      { field: "cloud_api_key", label: "云端密钥", secret: true },
    ],
    local: [{ field: "local_model", label: "本地模型（默认 small）", placeholder: "small" }],
    cloudNote:
      "OpenAI 兼容转录端点（Groq / OpenAI / Azure）：只上传这一段语音，不记别的。密钥只写不回显。",
    localNote: "本地模型名或本机路径（faster-whisper）；首次识别会自动下载到 data/models/asr。",
  },
  tts: {
    cloud: [],
    local: [
      {
        field: "local_base_url",
        label: "适配器地址",
        placeholder: "http://127.0.0.1:8742",
      },
      { field: "local_token", label: "适配器口令", secret: true },
    ],
    edge: [],
    cloudNote: "云端通用合成尚未实现：要联网请把来源改成「Edge 在线」，否则用本地适配器。",
    localNote: "常驻 HTTP 适配器（§6.12）：填错只影响发音，不会影响聊天与记忆。",
    edgeNote:
      "Edge 在线合成（零密钥，需联网，不能克隆角色音色）：音色用 .env 的 DESKPET_TTS_EDGE_VOICE（默认 zh-CN-XiaoxiaoNeural）。",
  },
};

/** 把一条供给配置摊平成「字段 → 要显示的文本」。 */
function fieldText(
  entry: ProviderSettingsEntry,
  field: ProviderFieldName | ProviderSecretField,
): string {
  if (isSecretField(field)) {
    return "";
  }
  const value = entry[field];
  if (value === true) {
    return "已配置";
  }
  if (value === false) {
    return "";
  }
  return value;
}

function isSecretField(
  field: ProviderFieldName | ProviderSecretField,
): field is ProviderSecretField {
  return field === "cloud_api_key" || field === "local_token";
}

function fieldPlaceholder(entry: ProviderSettingsEntry, spec: ProviderFieldSpec): string {
  if (spec.secret !== true) {
    return "";
  }
  const set = isSecretField(spec.field)
    ? spec.field === "cloud_api_key"
      ? entry.cloud_api_key_set
      : entry.local_token_set
    : false;
  return set ? "已配置（留空则不修改）" : "未配置";
}

/** 一个字段一行：标签 + 输入框（+ 密钥的「清除」按钮）。 */
function buildFieldRow(
  entry: ProviderSettingsEntry,
  spec: ProviderFieldSpec,
  onClear: (patch: ProviderSettingsPatchEntry) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "provider-field";
  const label = document.createElement("label");
  label.textContent = spec.label;
  row.append(label);

  const input = document.createElement("input");
  input.type = spec.secret === true ? "password" : "text";
  input.dataset["field"] = spec.field;
  input.placeholder = fieldPlaceholder(entry, spec);
  input.value = spec.secret === true ? "" : fieldText(entry, spec.field);
  input.autocomplete = "off";
  row.append(input);

  if (spec.secret === true) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "清除";
    clear.className = "btn-ghost btn-sm";
    clear.addEventListener("click", () => {
      const patch: ProviderSettingsPatchEntry = { capability: entry.capability };
      if (spec.field === "cloud_api_key") {
        patch.cloud_api_key = "";
      }
      if (spec.field === "local_token") {
        patch.local_token = "";
      }
      onClear(patch);
    });
    row.append(clear);
  }
  return row;
}

/** 一组字段（云端 / 本地 / 备用）；字段为空时只显示一句说明。 */
function buildFieldGroup(
  entry: ProviderSettingsEntry,
  title: string,
  specs: readonly ProviderFieldSpec[],
  note: string | undefined,
  onClear: (patch: ProviderSettingsPatchEntry) => void,
): HTMLElement {
  const group = document.createElement("div");
  group.className = "provider-group";
  const heading = document.createElement("p");
  heading.className = "provider-group-title";
  heading.textContent = title;
  group.append(heading);
  if (note !== undefined) {
    const hint = document.createElement("p");
    hint.className = "field-hint";
    hint.textContent = note;
    group.append(hint);
  }
  for (const spec of specs) {
    group.append(buildFieldRow(entry, spec, onClear));
  }
  return group;
}

/** 读一张卡片上的所有输入，拼成一条改动（留空的密钥不出现 = 不修改）。 */
function collectPatch(card: HTMLElement, entry: ProviderSettingsEntry): ProviderSettingsPatchEntry {
  const patch: ProviderSettingsPatchEntry = { capability: entry.capability };
  const select = card.querySelector<HTMLSelectElement>("select[data-role='provider']");
  if (select !== null && (PROVIDER_VALUES as readonly string[]).includes(select.value)) {
    patch.provider = select.value as ProviderValue;
  }
  const form = PROVIDER_FORMS[entry.capability];
  const specs = [...form.cloud, ...form.local, ...(form.edge ?? []), ...(form.fallback ?? [])];
  for (const spec of specs) {
    const input = card.querySelector<HTMLInputElement>("input[data-field='" + spec.field + "']");
    if (input === null) {
      continue;
    }
    const value = input.value.trim();
    if (spec.secret === true) {
      if (value === "") {
        continue;
      }
      if (spec.field === "cloud_api_key") {
        patch.cloud_api_key = value;
      }
      if (spec.field === "local_token") {
        patch.local_token = value;
      }
      continue;
    }
    switch (spec.field) {
      case "cloud_base_url":
        patch.cloud_base_url = value;
        break;
      case "cloud_model":
        patch.cloud_model = value;
        break;
      case "local_base_url":
        patch.local_base_url = value;
        break;
      case "local_model":
        patch.local_model = value;
        break;
      case "fallback_base_url":
        patch.fallback_base_url = value;
        break;
      case "fallback_model":
        patch.fallback_model = value;
        break;
      default:
        break;
    }
  }
  return patch;
}

/** 写回 .env；成功用返回的配置重画（密钥「已配 / 未配」立刻变准）。 */
async function saveProviders(
  patch: readonly ProviderSettingsPatchEntry[],
  done: string,
): Promise<void> {
  try {
    const payload = await api.providers.set(patch);
    renderProviders(payload);
    showBanner(done + "（重启后台引擎后生效）");
  } catch (error: unknown) {
    showBanner("写入 .env 失败：" + String(error));
  }
}

/** 探测一个能力面：结论一行一条，密钥永远不出现在这里（sidecar 也不回传）。 */
async function testProvider(capability: ProviderCapability, card: HTMLElement): Promise<void> {
  const list = card.querySelector<HTMLElement>(".probe-results");
  const button = card.querySelector<HTMLButtonElement>("button[data-role='test']");
  if (list === null || button === null) {
    return;
  }
  list.replaceChildren();
  button.disabled = true;
  const pending = document.createElement("li");
  pending.className = "placeholder";
  pending.textContent = "正在探测…";
  list.append(pending);
  try {
    const report = await api.providers.test(capability);
    list.replaceChildren();
    if (report.results.length === 0) {
      const empty = document.createElement("li");
      empty.className = "placeholder";
      empty.textContent = "没有可探测的端点：先在下面填好再来。";
      list.append(empty);
    }
    for (const result of report.results) {
      const item = document.createElement("li");
      item.className = "probe " + (result.ok ? "ok" : "bad");
      const head = document.createElement("span");
      head.className = "probe-head";
      const where = result.base_url ?? result.model ?? "";
      head.textContent =
        (result.ok ? "✓ " : "✗ ") + result.provider + (where === "" ? "" : " · " + where);
      const detail = document.createElement("span");
      detail.className = "probe-detail";
      detail.textContent = result.detail + "（" + String(result.elapsed_ms) + " ms）";
      item.append(head, detail);
      list.append(item);
    }
  } catch (error: unknown) {
    list.replaceChildren();
    const failed = document.createElement("li");
    failed.className = "probe bad";
    failed.textContent = "探测失败：" + String(error);
    list.append(failed);
  } finally {
    button.disabled = false;
  }
}

/** 记忆种类与层级的显示名；不在表里的值直接显示原文（历史遗留值不让面板崩）。 */
const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  event: "经历",
  action: "行为",
};

const MEMORY_TIER_LABELS: Record<string, string> = {
  fact: "长期记忆",
  "1": "阶段摘要",
  "2": "近期梗概",
  "3": "长期印象",
};

/** 设置窗当前正在看的角色；null = 还没选（列表为空）。 */
let memoryCharId: string | null = null;
let currentCharId: string | null = null;
/** 用户没手动改下拉时，记忆角色跟随主窗当前角色 */
let memoryFollowsCurrent = true;

/** 把 ISO 时间串显示成「2026-10-16 01:28」；空串给破折号（sidecar 没记时间的情况）。 */
function formatMemoryTime(value: string): string {
  return value === "" ? "—" : value.replace("T", " ").slice(0, 16);
}

function memoryMetaText(item: MemoryItem): string {
  return [
    MEMORY_KIND_LABELS[item.kind] ?? item.kind,
    MEMORY_TIER_LABELS[item.tier] ?? item.tier,
    "重要度 " + item.importance.toFixed(2),
    "记于 " + formatMemoryTime(item.created_at),
    "用过 " + String(item.used_count) + " 次",
  ].join(" · ");
}

function renderMemories(items: readonly MemoryItem[]): void {
  const host = byId("memory-list");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent =
      memoryCharId === null ? "先选一个角色。" : "没有提取出长期事实；最近对话仍会显示在下方。";
    host.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "memory";
    const text = document.createElement("p");
    text.className = "memory-text";
    text.textContent = item.text;
    const meta = document.createElement("p");
    meta.className = "memory-meta";
    meta.textContent = memoryMetaText(item);
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-danger btn-sm";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      void removeMemory(item.id, remove);
    });
    actions.append(remove);
    row.append(text, meta, actions);
    host.append(row);
  }
}

function renderRecentMessages(items: readonly MemoryMessageItem[]): void {
  const host = byId("memory-recent");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "这个角色还没有对话原文。";
    host.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "dev-message";
    const meta = document.createElement("p");
    meta.className = "placeholder";
    meta.textContent = [
      item.role === "user" ? "用户" : "助手",
      formatMemoryTime(item.created_at),
      item.covered_by === 0 ? "未压缩" : "摘要 #" + String(item.covered_by),
    ].join(" · ");
    const text = document.createElement("p");
    text.textContent = item.text;
    row.append(meta, text);
    host.append(row);
  }
}

/** 删一条后整块重画：重要度排序与「用过几次」都会变，局部改容易与实际不一致。 */
async function removeMemory(memoryId: number, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const result = await api.memory.remove({ memory_id: memoryId });
    showBanner(result.deleted ? "已删除这条记忆，下一轮不再注入。" : "这条记忆已经不在了。");
  } catch (error: unknown) {
    showBanner("删除记忆失败：" + String(error));
    button.disabled = false;
  }
  await refreshMemories();
}

/** 拉该角色的记忆。记忆是增强项：读不到只在这块面板显示错误，不影响别处（§6.4）。 */
async function refreshMemories(): Promise<void> {
  const host = byId("memory-list");
  if (memoryCharId === null) {
    renderMemories([]);
    renderRecentMessages([]);
    setText("memory-overview", "先选一个角色。");
    return;
  }
  if (host !== null) {
    const pending = document.createElement("p");
    pending.className = "placeholder";
    pending.textContent = "正在读取记忆…";
    host.replaceChildren(pending);
  }
  try {
    const [response, messages] = await Promise.all([
      api.memory.list({ char_id: memoryCharId, limit: 50 }),
      api.memory.messages({ char_id: memoryCharId, limit: 10 }),
    ]);
    renderMemories(response.items);
    renderRecentMessages(messages.items);
    setText(
      "memory-overview",
      "长期事实 " +
        String(response.items.length) +
        " 条 · 最近对话 " +
        String(messages.items.length) +
        (messages.has_more ? "+" : "") +
        " 条",
    );
  } catch (error: unknown) {
    if (host !== null) {
      const failed = document.createElement("p");
      failed.className = "placeholder";
      failed.textContent = "读不到记忆（后台引擎没起来？）：" + String(error);
      host.replaceChildren(failed);
    }
  }
}

/** 清空当前角色的记忆；按钮点一下只是「上膛」，再点一下才真删。 */
function onClearClicked(): void {
  const button = byId("memory-clear");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  if (memoryCharId === null) {
    showBanner("先在上面选一个角色。");
    return;
  }
  if (button.dataset["armed"] !== "1") {
    button.dataset["armed"] = "1";
    button.textContent = "再点一次完全重置";
    return;
  }
  delete button.dataset["armed"];
  button.textContent = "完全重置该角色记忆";
  void clearMemories();
}

async function clearMemories(): Promise<void> {
  const charId = memoryCharId;
  if (charId === null) {
    return;
  }
  try {
    const result = await api.memory.clear({ char_id: charId });
    showBanner("已完全重置该角色，共删除 " + String(result.deleted) + " 条记录。");
  } catch (error: unknown) {
    showBanner("清空记忆失败：" + String(error));
  }
  await refreshMemories();
}

/** 读「行为记忆」总开关（T2.1c）并勾上；失败只在这块面板提示，不挡别的设置。 */
async function loadBehaviorToggle(): Promise<void> {
  const input = byId("memory-behavior");
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  try {
    input.checked = (await api.memory.behavior({ enabled: null })).enabled;
  } catch (error: unknown) {
    showBanner("读取行为记忆开关失败：" + String(error));
  }
}

/** 勾选 / 取消后写回 .env；与「模型供给」同口径，提示重启后台引擎才生效。 */
async function onBehaviorToggled(input: HTMLInputElement): Promise<void> {
  input.disabled = true;
  try {
    const result = await api.memory.behavior({ enabled: input.checked });
    input.checked = result.enabled;
    showBanner("行为记忆已" + (result.enabled ? "打开" : "关闭") + "（重启后台引擎后生效）");
  } catch (error: unknown) {
    // 写盘失败就把勾选还原，别让界面显示一个并不存在的状态
    input.checked = !input.checked;
    showBanner("保存行为记忆开关失败：" + String(error));
  } finally {
    input.disabled = false;
  }
}

/** 填角色下拉框并记住当前角色；默认选主窗正在用的那个（§6.11 的同一份状态）。 */
async function loadMemoryCharacters(current: string | null): Promise<void> {
  const select = byId("memory-char");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  let characters: readonly CharacterSummary[] = [];
  try {
    characters = await api.characters.list();
  } catch (error: unknown) {
    showBanner("读取角色列表失败：" + String(error));
  }
  select.replaceChildren();
  for (const character of characters) {
    const option = document.createElement("option");
    option.value = character.char_id;
    option.textContent = character.display_name + "（" + character.char_id + "）";
    select.append(option);
  }
  const ids = characters.map((character) => character.char_id);
  const preferred = current !== null && ids.includes(current) ? current : (ids[0] ?? null);
  memoryCharId = preferred;
  if (preferred !== null) {
    select.value = preferred;
  }
  // onchange 而不是 addEventListener：角色列表刷新时会重进这个函数，addEventListener 会越挂越多
  select.onchange = () => {
    memoryCharId = select.value;
    memoryFollowsCurrent = false;
    void refreshMemories();
  };
  // 开发者模式的角色下拉与记忆面板共用同一份角色列表（T2.3-B1）：两份列表不一致会很迷惑
  const devSelect = byId("dev-char");
  if (devSelect instanceof HTMLSelectElement) {
    devSelect.replaceChildren();
    for (const character of characters) {
      const option = document.createElement("option");
      option.value = character.char_id;
      option.textContent = character.display_name + "（" + character.char_id + "）";
      devSelect.append(option);
    }
    devCharId = preferred;
    if (preferred !== null) {
      devSelect.value = preferred;
    }
    devSelect.onchange = () => {
      devCharId = devSelect.value;
      devRawItems = [];
      devRawBefore = null;
      void refreshDevRaw();
      void refreshDevContext();
      void refreshDevData();
    };
  }
  await refreshMemories();
}

/** 连点版本号进入 / 退出开发者模式：20 次，间隔超过 1 s 就归零（用户 m09622 第 4 条）。 */
const DEV_TAP_TARGET_COUNT = 20;
const DEV_TAP_RESET_MS = 1000;

/** 原文页一页取多少条；比记忆列表大一些，翻「更早」的次数少点。 */
const DEV_RAW_PAGE_SIZE = 50;

let devTapCount = 0;
let devTapLastAt = 0;
let devEnabled = false;
/** 开发者模式自己选的角色；与记忆面板的下拉分开，避免两边互相改。 */
let devCharId: string | null = null;
let devRawItems: MemoryMessageItem[] = [];
let devRawBefore: number | null = null;
let devRawHasMore = false;

/** 一次版本号点击：先判间隔，再攒次数；连满 20 次翻转开关（进入与退出一套手势）。 */
function onVersionClicked(): void {
  const now = Date.now();
  if (now - devTapLastAt > DEV_TAP_RESET_MS) {
    devTapCount = 0;
  }
  devTapLastAt = now;
  devTapCount += 1;
  if (devTapCount < DEV_TAP_TARGET_COUNT) {
    return;
  }
  devTapCount = 0;
  void setDevMode(!devEnabled);
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

/** 左侧导航切页：同一时间只显示一个 pane；开发者模式关闭时不允许停在 dev 页。 */
function selectPane(name: string): void {
  const target = name === "dev" && !devEnabled ? "appearance" : name;
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
}

/** 面板显隐；打开时把两个页都拉一遍（原文 + 注入预览）。 */
function applyDevMode(enabled: boolean): void {
  devEnabled = enabled;
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

/** 开发者模式在看的角色：优先自己选的，还没选就跟着记忆面板那个。 */
function currentDevChar(): string | null {
  return devCharId ?? memoryCharId;
}

/** 两个 tab 只切显隐，不落盘：关掉设置窗再打开回到「原文」。 */
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

/**
 * 原文页（T2.3-B1）：拉一页历史原文；append = true 时接在现有列表后面。
 *
 * 只读：原文是压缩链路的输入，改了会让摘要的 covered_by 对不上，所以这里不提供编辑。
 */
async function refreshDevRaw(append = false): Promise<void> {
  const charId = currentDevChar();
  const host = byId("dev-raw");
  if (charId === null || host === null) {
    return;
  }
  if (!append) {
    devRawItems = [];
    devRawBefore = null;
    const pending = document.createElement("p");
    pending.className = "placeholder";
    pending.textContent = "正在读取原文…";
    host.replaceChildren(pending);
  }
  try {
    const request: MemoryMessagesRequest = { char_id: charId, limit: DEV_RAW_PAGE_SIZE };
    if (append && devRawBefore !== null) {
      request.before_id = devRawBefore;
    }
    const response = await api.memory.messages(request);
    devRawItems = append ? devRawItems.concat(response.items) : response.items;
    devRawHasMore = response.has_more;
    const last = devRawItems[devRawItems.length - 1];
    devRawBefore = last === undefined ? null : last.message_id;
    renderDevRaw();
  } catch (error: unknown) {
    showBanner("读取历史原文失败：" + String(error));
  }
}

/** 画原文列表；每条上标一行元信息（角色 / 时间 / token / 有没有被摘要覆盖）。 */
function renderDevRaw(): void {
  const host = byId("dev-raw");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  if (devRawItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "还没有历史原文：先跟这个角色聊几句。";
    host.append(empty);
  }
  for (const item of devRawItems) {
    const row = document.createElement("article");
    row.className = "dev-message";
    const meta = document.createElement("p");
    meta.className = "placeholder";
    meta.textContent = [
      "#" + String(item.message_id),
      item.role === "user" ? "用户" : item.role === "assistant" ? "助手" : item.role,
      formatMemoryTime(item.created_at),
      String(item.token_len) + " token",
      item.covered_by === 0 ? "未被摘要覆盖" : "已被摘要 #" + String(item.covered_by) + " 覆盖",
    ].join(" · ");
    const text = document.createElement("p");
    text.textContent = item.text;
    row.append(meta, text);
    host.append(row);
  }
  const more = byId("dev-more");
  if (more instanceof HTMLButtonElement) {
    more.hidden = !devRawHasMore;
  }
}

/** 一条可编辑记录：默认显示文本；编辑时换成 textarea，保存后刷新整个数据页。 */
function devEditableRow(
  metaText: string,
  text: string,
  onSave: (next: string) => Promise<void>,
  onDelete: (() => Promise<void>) | null,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "dev-message";
  const meta = document.createElement("p");
  meta.className = "placeholder";
  meta.textContent = metaText;
  const body = document.createElement("p");
  body.textContent = text;
  const actions = document.createElement("div");
  actions.className = "row";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn-ghost btn-sm";
  edit.textContent = "编辑";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-danger btn-sm";
  remove.textContent = "删除";
  actions.append(edit);
  if (onDelete !== null) {
    actions.append(remove);
  }
  row.append(meta, body, actions);

  edit.addEventListener("click", () => {
    const area = document.createElement("textarea");
    area.className = "memory-edit";
    area.value = text;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary btn-sm";
    save.textContent = "保存";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-ghost btn-sm";
    cancel.textContent = "取消";
    const editActions = document.createElement("div");
    editActions.className = "row";
    editActions.append(save, cancel);
    body.replaceWith(area);
    actions.replaceWith(editActions);
    cancel.addEventListener("click", () => {
      area.replaceWith(body);
      editActions.replaceWith(actions);
    });
    save.addEventListener("click", () => {
      save.disabled = true;
      const next = area.value.trim();
      if (next === "") {
        showBanner("内容不能为空。");
        save.disabled = false;
        return;
      }
      void onSave(next)
        .then(() => void refreshDevData())
        .catch((error: unknown) => {
          showBanner("保存记忆失败：" + String(error));
          save.disabled = false;
        });
    });
  });
  if (onDelete !== null) {
    remove.addEventListener("click", () => {
      if (!window.confirm("确认删除这条记录？此操作不可撤销。")) {
        return;
      }
      remove.disabled = true;
      void onDelete()
        .then(() => void refreshDevData())
        .catch((error: unknown) => {
          showBanner("删除记忆失败：" + String(error));
          remove.disabled = false;
        });
    });
  }
  return row;
}

function devSection(title: string, hint: string, rows: readonly HTMLElement[]): HTMLElement {
  const box = document.createElement("section");
  box.className = "dev-section";
  const head = document.createElement("p");
  head.className = "placeholder";
  head.textContent = title + " · " + hint;
  box.append(head, ...rows);
  return box;
}

async function refreshDevData(): Promise<void> {
  const charId = currentDevChar();
  const host = byId("dev-data");
  if (charId === null || host === null) {
    return;
  }
  host.replaceChildren();
  const pending = document.createElement("p");
  pending.className = "placeholder";
  pending.textContent = "正在读取记忆数据…";
  host.append(pending);
  try {
    const [facts, summaries, messages] = await Promise.all([
      api.memory.list({ char_id: charId, limit: 200 }),
      api.memory.summaries({ char_id: charId, limit: 200 }),
      api.memory.messages({ char_id: charId, limit: 100 }),
    ]);
    const factRows = facts.items.map((item: MemoryItem) =>
      devEditableRow(
        "#" +
          String(item.id) +
          " · " +
          item.kind +
          " · " +
          item.tier +
          " · 重要度 " +
          item.importance.toFixed(2),
        item.text,
        async (text) => {
          await api.memory.edit({ memory_id: item.id, text });
        },
        async () => {
          await api.memory.remove({ memory_id: item.id });
        },
      ),
    );
    const summaryRows = summaries.items.map((item: MemorySummaryItem) =>
      devEditableRow(
        "#" +
          String(item.id) +
          " · L" +
          String(item.tier) +
          " · " +
          item.covers_from +
          " → " +
          item.covers_to,
        item.text,
        async (text) => {
          await api.memory.editSummary({ summary_id: item.id, text });
        },
        async () => {
          await api.memory.deleteSummary(item.id);
        },
      ),
    );
    const messageRows = messages.items.map((item: MemoryMessageItem) =>
      devEditableRow(
        "#" +
          String(item.message_id) +
          " · " +
          (item.role === "user" ? "用户" : "助手") +
          " · " +
          formatMemoryTime(item.created_at) +
          (item.covered_by === 0 ? " · 未覆盖" : " · 摘要 #" + String(item.covered_by)),
        item.text,
        async (text) => {
          await api.memory.editMessage({ message_id: item.message_id, text });
        },
        async () => {
          await api.memory.deleteMessage(item.message_id);
        },
      ),
    );
    host.replaceChildren(
      devSection("事实（L0）", String(facts.items.length) + " 条", factRows),
      devSection("摘要（L1/L2/L3）", String(summaries.items.length) + " 条", summaryRows),
      devSection("原文（L0）", String(messages.items.length) + " 条", messageRows),
    );
  } catch (error: unknown) {
    host.replaceChildren();
    const failed = document.createElement("p");
    failed.className = "placeholder";
    failed.textContent = "读取记忆数据失败：" + String(error);
    host.append(failed);
  }
}

/** 注入页（T2.3-B1）：让 sidecar 干跑一次装配；不调模型、不 mark_used，反复点也不会污染统计。 */
async function refreshDevContext(): Promise<void> {
  const charId = currentDevChar();
  const host = byId("dev-context");
  if (charId === null || host === null) {
    return;
  }
  const queryInput = byId("dev-query");
  const query = queryInput instanceof HTMLInputElement ? queryInput.value.trim() : "";
  try {
    renderDevContext(await api.memory.context({ char_id: charId, query }));
  } catch (error: unknown) {
    showBanner("预览记忆装配失败：" + String(error));
  }
}

/** 画六段装配：每段报「用了多少 / 预算多少 / 多少条」，最后是原文形态的最终注入文本。 */
function renderDevContext(response: MemoryContextResponse): void {
  const host = byId("dev-context");
  if (host !== null) {
    host.replaceChildren();
    const total = document.createElement("p");
    total.className = "placeholder";
    total.textContent =
      "合计 " +
      String(response.total_tokens) +
      " / " +
      String(response.budget_tokens) +
      " token" +
      (response.dropped.length === 0 ? "" : " · 被裁掉：" + response.dropped.join("、")) +
      (response.injected_ids.length === 0
        ? ""
        : " · 注入记忆 id：" + response.injected_ids.join(","));
    host.append(total);
    for (const section of response.sections) {
      host.append(renderDevSection(section));
    }
  }
  const textHost = byId("dev-context-text");
  if (textHost !== null) {
    textHost.textContent =
      response.text === "" ? "（装配为空：这个角色还没有可注入的内容）" : response.text;
  }
}

/**
 * L0 事实行的「编辑」控件（T2.3-B2）：点开换成 textarea，保存走 PATCH /memory/{id}。
 *
 * 只有 facts 段、ref_id > 0、且不是行为观察（kind=action）的行才给编辑：行为观察是从
 * usage.db 派生的，sidecar 也会拒，界面上干脆不露。
 */
function buildMemoryEditControls(item: MemoryContextItem, text: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "row";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn-ghost btn-sm";
  edit.textContent = "编辑";
  box.append(edit);

  edit.addEventListener("click", () => {
    const area = document.createElement("textarea");
    area.className = "memory-edit";
    area.value = item.text;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary btn-sm";
    save.textContent = "保存";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-ghost btn-sm";
    cancel.textContent = "取消";
    const actions = document.createElement("div");
    actions.className = "memory-actions";
    actions.append(save, cancel);
    text.replaceWith(area);
    box.replaceWith(actions);

    cancel.addEventListener("click", () => {
      area.replaceWith(text);
      actions.replaceWith(box);
    });
    save.addEventListener("click", () => {
      void saveMemoryEdit(item.ref_id, area.value, save, cancel);
    });
  });
  return box;
}

/** 保存一次编辑；失败只在这块面板提示，不弹全局错误（与记忆面板同一口径）。 */
async function saveMemoryEdit(
  memoryId: number,
  text: string,
  ...buttons: HTMLButtonElement[]
): Promise<void> {
  const body = text.trim();
  if (body === "") {
    showBanner("记忆内容不能是空的。");
    return;
  }
  for (const button of buttons) {
    button.disabled = true;
  }
  try {
    const result = await api.memory.edit({ memory_id: memoryId, text: body });
    if (!result.updated) {
      showBanner("这条记忆已经不在了（可能刚被删掉）。");
    } else if (result.merged) {
      showBanner("改完与同角色另一条重复，已经并成一条。");
    } else {
      showBanner("已保存这条记忆，下一轮注入就用新内容。");
    }
  } catch (error: unknown) {
    showBanner("保存记忆失败：" + String(error));
    for (const button of buttons) {
      button.disabled = false;
    }
    return;
  }
  await refreshDevContext();
  await refreshMemories();
}

/** 一段的 DOM：标题行 + 每条内容（ref_id / 种类 / 角色 / 重要度 / token）。 */
function renderDevSection(section: MemoryContextSection): HTMLElement {
  const box = document.createElement("section");
  box.className = "dev-section";
  const head = document.createElement("p");
  head.className = "placeholder";
  head.textContent =
    section.title +
    "（" +
    section.name +
    "）：" +
    String(section.used_tokens) +
    " / " +
    String(section.budget_tokens) +
    " token · " +
    String(section.items.length) +
    " 条" +
    (section.dropped ? " · 已被裁掉" : "");
  box.append(head);
  for (const item of section.items) {
    const row = document.createElement("article");
    row.className = "dev-message";
    const meta = document.createElement("p");
    meta.className = "placeholder";
    meta.textContent = [
      item.ref_id === 0 ? "" : "#" + String(item.ref_id),
      item.kind === "" ? "" : (MEMORY_KIND_LABELS[item.kind] ?? item.kind),
      item.role === "" ? "" : item.role,
      item.importance === 0 ? "" : "重要度 " + item.importance.toFixed(2),
      String(item.tokens) + " token",
    ]
      .filter((part) => part !== "")
      .join(" · ");
    const text = document.createElement("p");
    text.textContent = item.text;
    row.append(meta, text);
    if (section.name === "facts" && item.ref_id > 0 && item.kind !== "action") {
      row.append(buildMemoryEditControls(item, text));
    }
    box.append(row);
  }
  return box;
}
/** 画「模型供给」：每个能力面一张卡片（来源 + 三组字段 + 保存 / 测试）。 */
function renderProviders(payload: ProviderSettingsPayload): void {
  const host = byId("providers-list");
  if (host === null) {
    return;
  }
  host.replaceChildren();
  for (const entry of payload.entries) {
    const form = PROVIDER_FORMS[entry.capability];
    const card = document.createElement("section");
    card.className = "provider-card";
    card.dataset["capability"] = entry.capability;

    const header = document.createElement("div");
    header.className = "provider-head";
    const title = document.createElement("div");
    title.className = "provider-name";
    title.textContent = PROVIDER_LABELS[entry.capability];
    const options = PROVIDER_OPTIONS[entry.capability];
    const select = document.createElement("select");
    select.dataset["role"] = "provider";
    for (const option of options) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    // 存量配置可能指向已不在选项里的来源（如 tts 的 cloud）：回退到第一项，避免空选
    select.value = options.some((option) => option.value === entry.provider)
      ? entry.provider
      : (options[0]?.value ?? "local");
    header.append(title, select);
    card.append(header);
    const effective = document.createElement("p");
    effective.className = "provider-effective";
    effective.textContent = effectiveProviderText(entry);
    card.append(effective);

    const onClear = (patch: ProviderSettingsPatchEntry): void => {
      void saveProviders([patch], "已清空该项");
    };
    card.append(
      buildFieldGroup(entry, "云端", form.cloud, form.cloudNote, onClear),
      buildFieldGroup(entry, "本地", form.local, form.localNote, onClear),
    );
    if (form.edge !== undefined) {
      card.append(buildFieldGroup(entry, "Edge 在线", form.edge, form.edgeNote, onClear));
    }
    if (form.fallback !== undefined) {
      card.append(
        buildFieldGroup(entry, "备用（主用失败后重试）", form.fallback, undefined, onClear),
      );
    }

    const actions = document.createElement("div");
    actions.className = "provider-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary btn-sm";
    save.textContent = "保存";
    save.addEventListener("click", () => {
      void saveProviders([collectPatch(card, entry)], "已保存模型供给");
    });
    const test = document.createElement("button");
    test.type = "button";
    test.className = "btn-ghost btn-sm";
    test.dataset["role"] = "test";
    test.textContent = "测试连接";
    test.addEventListener("click", () => {
      void testProvider(entry.capability, card);
    });
    actions.append(save, test);
    card.append(actions);

    const results = document.createElement("ul");
    results.className = "probe-results";
    card.append(results);
    host.append(card);
  }
  const where = document.createElement("p");
  where.className = "field-hint";
  where.textContent = "写入位置：" + payload.env_file;
  host.append(where);
}

async function refreshProviders(): Promise<void> {
  try {
    renderProviders(await api.providers.get());
  } catch (error: unknown) {
    showBanner("读取模型供给失败：" + String(error));
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

function isChecked(id: string): boolean {
  const input = byId(id);
  return input instanceof HTMLInputElement && input.checked;
}

function setChecked(id: string, checked: boolean): void {
  const input = byId(id);
  if (input instanceof HTMLInputElement) {
    input.checked = checked;
  }
}

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
    currentCharId = state.char_id;
    renderScale(state.scale);
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
    if (state.char_id !== currentCharId) {
      currentCharId = state.char_id;
      if (memoryFollowsCurrent && state.char_id !== null) {
        void loadMemoryCharacters(state.char_id);
      }
    }
    renderScale(state.scale);
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
  // 记忆面板：先填角色下拉框，再拉那个角色的记忆（默认主窗正在用的角色）
  void loadMemoryCharacters(currentChar);
  byId("memory-refresh")?.addEventListener("click", () => {
    void refreshMemories();
  });
  byId("memory-clear")?.addEventListener("click", onClearClicked);
  void refreshUsageStats();
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
  // 角色包编辑器保存后主进程会广播（T2.3-D）：两个角色下拉立刻多出新角色
  api.characters.onChanged(() => {
    void loadMemoryCharacters(currentCharId ?? devCharId ?? memoryCharId);
  });
  // 行为记忆开关与记忆列表互不依赖：一个在 .env 里，一个在 sidecar 里
  void loadBehaviorToggle();
  byId("memory-behavior")?.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      void onBehaviorToggled(input);
    }
  });

  // 开发者模式（T2.3-B1）：入口是连点版本号 20 次；面板默认收起，开关存在 data/dev.json
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
  await loadDevMode();
  selectPane(devEnabled ? "dev" : "appearance");
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
