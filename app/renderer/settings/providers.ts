/**
 * 文件职责：设置窗「模型供给」面板——每个能力面（对话 / 识别 / 合成）的来源选择、字段表单、保存与连通性探测。
 *
 * 为什么单独一个文件：这一面板只跟 api.providers 打交道，和记忆、开发者面板没有共享的可变状态；
 * 拆出来之后改供给表单不会再牵动整份设置脚本。
 */
import type {
  ProviderCapability,
  ProviderSettingsEntry,
  ProviderSettingsPatchEntry,
  ProviderSettingsPayload,
  ProviderTestOverrides,
  ProviderValue,
} from "../../shared/contracts/ipc";
import { PROVIDER_VALUES } from "../../shared/defaults";
import {
  CUSTOM_PRESET_ID,
  findPreset,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../../shared/provider-presets";
import { api, byId, showBanner } from "./dom";

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
 * 写进设置文件但绝不回显的字段。
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
 * 为什么写在渲染层：键名映射（哪一面用哪个设置键）在主进程的 provider-settings.ts，
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

/** 当前卡片选中的预设；未知值按自定义处理。 */
function selectedPreset(capability: ProviderCapability, id: string): ProviderPreset | undefined {
  return findPreset(capability, id) ?? findPreset(capability, CUSTOM_PRESET_ID);
}

/** 选中预设后把默认端点 / 模型填进输入框；custom 的 fields 为空，不动现有值。 */
function applyPreset(card: HTMLElement, preset: ProviderPreset): void {
  const providerSelect = card.querySelector<HTMLSelectElement>("select[data-role='provider']");
  if (providerSelect !== null && preset.provider !== null) {
    providerSelect.value = preset.provider;
  }
  const fields = preset.fields as Record<string, string | undefined>;
  for (const field of Object.keys(fields)) {
    const value = fields[field];
    if (value === undefined) {
      continue;
    }
    const input = card.querySelector<HTMLInputElement>("input[data-field='" + field + "']");
    if (input !== null) {
      input.value = value;
    }
  }
  const note = card.querySelector<HTMLElement>(".provider-preset-note");
  if (note !== null) {
    note.textContent = preset.note;
  }
  updateProviderVisibility(card);
}

/** 按当前 provider 只显示对应分组；备用端点只在云端时露出。 */
function updateProviderVisibility(card: HTMLElement): void {
  const select = card.querySelector<HTMLSelectElement>("select[data-role='provider']");
  const provider = select?.value ?? "local";
  const show = (group: string, visible: boolean): void => {
    const node = card.querySelector<HTMLElement>(".provider-group[data-group='" + group + "']");
    if (node !== null) {
      node.hidden = !visible;
    }
  };
  show("cloud", provider === "cloud");
  show("local", provider === "local");
  show("edge", provider === "edge");
  show("fallback", provider === "cloud");
  show("models", provider === "cloud");
}

/** 把设置改动转成测试请求的 overrides；capability 不放进 overrides。 */
function toOverrides(patch: ProviderSettingsPatchEntry): ProviderTestOverrides {
  return {
    ...(patch.provider === undefined ? {} : { provider: patch.provider }),
    ...(patch.preset === undefined ? {} : { preset: patch.preset }),
    ...(patch.cloud_base_url === undefined ? {} : { cloud_base_url: patch.cloud_base_url }),
    ...(patch.cloud_model === undefined ? {} : { cloud_model: patch.cloud_model }),
    ...(patch.cloud_api_key === undefined ? {} : { cloud_api_key: patch.cloud_api_key }),
    ...(patch.local_base_url === undefined ? {} : { local_base_url: patch.local_base_url }),
    ...(patch.local_model === undefined ? {} : { local_model: patch.local_model }),
    ...(patch.local_token === undefined ? {} : { local_token: patch.local_token }),
    ...(patch.fallback_base_url === undefined
      ? {}
      : { fallback_base_url: patch.fallback_base_url }),
    ...(patch.fallback_model === undefined ? {} : { fallback_model: patch.fallback_model }),
  };
}

/** 「获取模型列表」一行：手动填 URL/Key 后也能直接拉取，选中的模型写回模型输入框。 */
function buildModelListRow(entry: ProviderSettingsEntry, card: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "provider-group provider-model-list";
  row.dataset["group"] = "models";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-ghost btn-sm";
  button.dataset["role"] = "models";
  button.textContent = "获取模型列表";
  const select = document.createElement("select");
  select.dataset["role"] = "model-options";
  select.hidden = true;
  const status = document.createElement("span");
  status.className = "field-hint provider-model-status";
  row.append(button, select, status);

  button.addEventListener("click", () => {
    const modelInput = card.querySelector<HTMLInputElement>("input[data-field='cloud_model']");
    if (modelInput === null) {
      return;
    }
    const patch = collectPatch(card, entry);
    button.disabled = true;
    status.textContent = "正在获取…";
    void api.providers
      .listModels({ capability: entry.capability, overrides: toOverrides(patch) })
      .then((report) => {
        if (report.models.length === 0) {
          select.hidden = true;
          status.textContent = report.detail === "" ? "端点没有返回模型。" : report.detail;
          return;
        }
        select.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "选择模型…";
        select.append(placeholder);
        for (const model of report.models) {
          const option = document.createElement("option");
          option.value = model;
          option.textContent = model;
          select.append(option);
        }
        select.value = report.models.includes(modelInput.value) ? modelInput.value : "";
        select.hidden = false;
        status.textContent =
          "已获取 " + String(report.models.length) + " 个模型，点下拉选择或继续手填。";
        modelInput.focus();
      })
      .catch((error: unknown) => {
        select.hidden = true;
        status.textContent = "获取失败：" + String(error);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  select.addEventListener("change", () => {
    const modelInput = card.querySelector<HTMLInputElement>("input[data-field='cloud_model']");
    if (modelInput !== null && select.value !== "") {
      modelInput.value = select.value;
    }
  });
  return row;
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
  groupKey: "cloud" | "local" | "edge" | "fallback",
): HTMLElement {
  const group = document.createElement("div");
  group.className = "provider-group";
  group.dataset["group"] = groupKey;
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
  const presetSelect = card.querySelector<HTMLSelectElement>("select[data-role='preset']");
  if (presetSelect !== null && presetSelect.value !== "") {
    patch.preset = presetSelect.value;
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

/** 写回设置文件；成功用返回的配置重画（密钥「已配 / 未配」立刻变准）。 */
async function saveProviders(
  patch: readonly ProviderSettingsPatchEntry[],
  done: string,
): Promise<void> {
  try {
    const payload = await api.providers.set(patch);
    renderProviders(payload);
    showBanner(done + "（后台引擎已重启，约两秒后生效）");
  } catch (error: unknown) {
    showBanner("写入设置失败：" + String(error));
  }
}

/** 探测当前表单值（未保存也能测）：只测选中的 provider。 */
async function testProvider(entry: ProviderSettingsEntry, card: HTMLElement): Promise<void> {
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
    const patch = collectPatch(card, entry);
    const report = await api.providers.test({
      capability: entry.capability,
      overrides: toOverrides(patch),
    });
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

    const presetRow = document.createElement("div");
    presetRow.className = "provider-preset";
    const presetLabel = document.createElement("label");
    presetLabel.textContent = "常用服务商";
    const presetSelect = document.createElement("select");
    presetSelect.dataset["role"] = "preset";
    for (const preset of PROVIDER_PRESETS[entry.capability]) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      presetSelect.append(option);
    }
    const currentPreset = selectedPreset(entry.capability, entry.preset);
    presetSelect.value = currentPreset?.id ?? CUSTOM_PRESET_ID;
    presetRow.append(presetLabel, presetSelect);
    card.append(presetRow);
    const presetNote = document.createElement("p");
    presetNote.className = "field-hint provider-preset-note";
    presetNote.textContent = currentPreset?.note ?? "";
    card.append(presetNote);

    presetSelect.addEventListener("change", () => {
      const preset = selectedPreset(entry.capability, presetSelect.value);
      if (preset !== undefined) {
        applyPreset(card, preset);
      }
    });
    select.addEventListener("change", () => {
      const preset = selectedPreset(entry.capability, presetSelect.value);
      if (preset !== undefined && preset.provider !== null && preset.provider !== select.value) {
        presetSelect.value = CUSTOM_PRESET_ID;
        const custom = selectedPreset(entry.capability, CUSTOM_PRESET_ID);
        presetNote.textContent = custom?.note ?? "";
      }
      updateProviderVisibility(card);
    });

    const onClear = (patch: ProviderSettingsPatchEntry): void => {
      void saveProviders([patch], "已清空该项");
    };
    card.append(buildFieldGroup(entry, "云端", form.cloud, form.cloudNote, onClear, "cloud"));
    if (entry.capability === "llm") {
      card.append(buildModelListRow(entry, card));
    }
    card.append(buildFieldGroup(entry, "本地", form.local, form.localNote, onClear, "local"));
    if (form.edge !== undefined) {
      card.append(buildFieldGroup(entry, "Edge 在线", form.edge, form.edgeNote, onClear, "edge"));
    }
    if (form.fallback !== undefined) {
      card.append(
        buildFieldGroup(
          entry,
          "备用（主用失败后重试）",
          form.fallback,
          undefined,
          onClear,
          "fallback",
        ),
      );
    }
    updateProviderVisibility(card);

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
      void testProvider(entry, card);
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
  where.textContent = "写入位置：" + payload.config_file;
  host.append(where);
}

export async function refreshProviders(): Promise<void> {
  try {
    renderProviders(await api.providers.get());
  } catch (error: unknown) {
    showBanner("读取模型供给失败：" + String(error));
  }
}
