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
  MemoryItem,
  ModuleName,
  ProviderCapability,
  ProviderSettingsEntry,
  ProviderSettingsPatchEntry,
  ProviderSettingsPayload,
} from "../main/ipc";
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

const PROVIDER_LABELS: Record<ProviderCapability, string> = {
  llm: "语言模型",
  asr: "语音识别",
  tts: "语音合成",
};

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
}

interface ProviderFormSpec {
  readonly cloud: readonly ProviderFieldSpec[];
  readonly local: readonly ProviderFieldSpec[];
  readonly cloudNote?: string;
  readonly localNote?: string;
  readonly fallback?: readonly ProviderFieldSpec[];
}

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
      { field: "local_base_url", label: "本地端点" },
      { field: "local_model", label: "本地模型" },
    ],
    fallback: [
      { field: "fallback_base_url", label: "备用端点" },
      { field: "fallback_model", label: "备用模型" },
    ],
    localNote:
      "本地端点指向你自己起的服务（如 Ollama / vLLM 的 OpenAI 兼容口），本项目不装、不启、不调参。",
  },
  asr: {
    cloud: [],
    local: [{ field: "local_model", label: "本地模型" }],
    cloudNote: "云端识别尚未实现：要联网识别请把来源改回「本地」。",
    localNote: "本地模型名或本机路径（faster-whisper）；首次识别会自动下载到 data/models/asr。",
  },
  tts: {
    cloud: [],
    local: [
      { field: "local_base_url", label: "适配器地址" },
      { field: "local_token", label: "适配器口令", secret: true },
    ],
    cloudNote: "云端合成尚未实现：请把来源改回「本地」，用你自己部署的 IndexTTS 适配器。",
    localNote: "常驻 HTTP 适配器（§6.12）：填错只影响发音，不会影响聊天与记忆。",
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
  row.className = "row";
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
  heading.className = "placeholder";
  heading.textContent = title;
  group.append(heading);
  if (note !== undefined) {
    const hint = document.createElement("p");
    hint.className = "placeholder";
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
  if (select !== null && (select.value === "cloud" || select.value === "local")) {
    patch.provider = select.value;
  }
  const form = PROVIDER_FORMS[entry.capability];
  const specs = [...form.cloud, ...form.local, ...(form.fallback ?? [])];
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
    empty.className = "placeholder";
    empty.textContent =
      memoryCharId === null ? "先选一个角色。" : "这个角色还没有记忆：聊几句就有了。";
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
    meta.className = "placeholder";
    meta.textContent = memoryMetaText(item);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      void removeMemory(item.id, remove);
    });
    row.append(text, meta, remove);
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
    return;
  }
  if (host !== null) {
    const pending = document.createElement("p");
    pending.className = "placeholder";
    pending.textContent = "正在读取记忆…";
    host.replaceChildren(pending);
  }
  try {
    const response = await api.memory.list({ char_id: memoryCharId, limit: 50 });
    renderMemories(response.items);
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
    button.textContent = "再点一次确认清空";
    return;
  }
  delete button.dataset["armed"];
  button.textContent = "清空该角色记忆";
  void clearMemories();
}

async function clearMemories(): Promise<void> {
  const charId = memoryCharId;
  if (charId === null) {
    return;
  }
  try {
    const result = await api.memory.clear({ char_id: charId });
    showBanner("已清空该角色记忆，共 " + String(result.deleted) + " 条。");
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
  select.addEventListener("change", () => {
    memoryCharId = select.value;
    void refreshMemories();
  });
  await refreshMemories();
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
    header.className = "row";
    const title = document.createElement("label");
    title.textContent = PROVIDER_LABELS[entry.capability];
    const select = document.createElement("select");
    select.dataset["role"] = "provider";
    for (const value of ["cloud", "local"] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "cloud" ? "云端" : "本地";
      select.append(option);
    }
    select.value = entry.provider;
    header.append(title, select);
    card.append(header);

    const onClear = (patch: ProviderSettingsPatchEntry): void => {
      void saveProviders([patch], "已清空该项");
    };
    card.append(
      buildFieldGroup(entry, "云端", form.cloud, form.cloudNote, onClear),
      buildFieldGroup(entry, "本地", form.local, form.localNote, onClear),
    );
    if (form.fallback !== undefined) {
      card.append(
        buildFieldGroup(entry, "备用（主用失败后重试）", form.fallback, undefined, onClear),
      );
    }

    const actions = document.createElement("div");
    actions.className = "row";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存";
    save.addEventListener("click", () => {
      void saveProviders([collectPatch(card, entry)], "已保存模型供给");
    });
    const test = document.createElement("button");
    test.type = "button";
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
  where.className = "placeholder";
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

  // 模型供给与心跳互不依赖：并行拉，谁慢都不挡另一个先显示
  void refreshProviders();
  // 记忆面板：先填角色下拉框，再拉那个角色的记忆（默认主窗正在用的角色）
  void loadMemoryCharacters(currentChar);
  byId("memory-refresh")?.addEventListener("click", () => {
    void refreshMemories();
  });
  byId("memory-clear")?.addEventListener("click", onClearClicked);
  // 行为记忆开关与记忆列表互不依赖：一个在 .env 里，一个在 sidecar 里
  void loadBehaviorToggle();
  byId("memory-behavior")?.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) {
      void onBehaviorToggled(input);
    }
  });

  try {
    const info = await api.app.getInfo();
    setText("app-version", info.app_version);
  } catch (error: unknown) {
    setText("app-version", "读取失败：" + String(error));
  }
}

void main();
