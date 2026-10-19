/**
 * 文件职责：把 .env 里的供给键读成界面视图、把界面改动翻译成 .env 更新（纯函数）。
 *
 * 为什么单独一个模块：配置的唯一事实来源是 .env（不另开 data/settings.json），
 * 「键名 → 视图」与「视图 → 键名」两张映射必须放在一起，否则 T1.14b 的设置窗
 * 迟早会把 DESKPET_LLM_BASE_URL 与 DESKPET_LLM_LOCAL_BASE_URL 写串（§6.13 双轨）。
 * 依赖方向：main -> ./ipc（只 import 类型与枚举）；不 import electron、不碰磁盘，可直接单测。
 * 谁调用：app/main/ipc-handlers.ts（四个供给 IPC 通道）与 app/renderer/settings.ts（字段布局）。
 */
import {
  PROVIDER_VALUES,
  type ProviderCapability,
  type ProviderSettingsEntry,
  type ProviderSettingsPatchEntry,
  type ProviderValue,
} from "./ipc";

/** 一个能力面对应的 .env 键；null 表示这一面还没有这个键（后置实现）。 */
export interface ProviderKeyMap {
  readonly provider: string;
  readonly cloudBaseUrl: string | null;
  readonly cloudModel: string | null;
  readonly cloudApiKey: string | null;
  readonly localBaseUrl: string | null;
  readonly localModel: string | null;
  readonly localToken: string | null;
  readonly fallbackBaseUrl: string | null;
  readonly fallbackModel: string | null;
}

/** 键名与仓库根 .env.example 一一对应；改这里必须同步改 .env.example 与 sidecar/config.py。 */
export const PROVIDER_KEY_MAPS: Record<ProviderCapability, ProviderKeyMap> = {
  llm: {
    provider: "DESKPET_LLM_PROVIDER",
    cloudBaseUrl: "DESKPET_LLM_BASE_URL",
    cloudModel: "DESKPET_LLM_MODEL",
    cloudApiKey: "DESKPET_LLM_API_KEY",
    localBaseUrl: "DESKPET_LLM_LOCAL_BASE_URL",
    localModel: "DESKPET_LLM_LOCAL_MODEL",
    localToken: null,
    fallbackBaseUrl: "DESKPET_LLM_FALLBACK_BASE_URL",
    fallbackModel: "DESKPET_LLM_FALLBACK_MODEL",
  },
  // 云端识别已实现（T2.4）：OpenAI 兼容转录端点（Groq / OpenAI / Azure）；本地是模型名
  asr: {
    provider: "DESKPET_ASR_PROVIDER",
    cloudBaseUrl: "DESKPET_ASR_CLOUD_BASE_URL",
    cloudModel: "DESKPET_ASR_CLOUD_MODEL",
    cloudApiKey: "DESKPET_ASR_CLOUD_API_KEY",
    localBaseUrl: null,
    localModel: "DESKPET_ASR_MODEL",
    localToken: null,
    fallbackBaseUrl: null,
    fallbackModel: null,
  },
  // 本地合成走常驻适配器（§6.12）：地址 + 口令；edge 走在线合成（音色在 .env 的 DESKPET_TTS_EDGE_VOICE）
  tts: {
    provider: "DESKPET_TTS_PROVIDER",
    cloudBaseUrl: null,
    cloudModel: null,
    cloudApiKey: null,
    localBaseUrl: "DESKPET_TTS_URL",
    localModel: null,
    localToken: "DESKPET_TTS_TOKEN",
    fallbackBaseUrl: null,
    fallbackModel: null,
  },
};

/** 供给面的显示顺序（设置窗与探测顺序都用它）。 */
export const PROVIDER_CAPABILITY_ORDER: readonly ProviderCapability[] = ["llm", "asr", "tts"];

/**
 * 每个能力面的默认供给来源，必须与 sidecar/config.py 的 _provider_value 默认值一一对应。
 *
 * 为什么按面分开（T2.2 用户反馈第五轮修）：sidecar 里 LLM 默认 cloud（本地 LLM 后置实现）、
 * ASR / TTS 默认 local；界面以前一律回退 local，于是「实际在用云端」却显示成「本地」。
 */
export const PROVIDER_DEFAULTS: Record<ProviderCapability, ProviderValue> = {
  llm: "cloud",
  asr: "local",
  tts: "local",
};

/** 未设或非法的 provider 值退回该面的默认值：与 sidecar 一致，界面不会显示成空白。 */
function toProviderValue(capability: ProviderCapability, raw: string | undefined): ProviderValue {
  const value = (raw ?? "").trim();
  return (PROVIDER_VALUES as readonly string[]).includes(value)
    ? (value as ProviderValue)
    : PROVIDER_DEFAULTS[capability];
}

/** 读一个键；键为 null（这一面没有这个键）或不存在都返回空串。 */
function readKey(env: Readonly<Record<string, string>>, key: string | null): string {
  return key === null ? "" : (env[key] ?? "");
}

/** 密钥类的键只回「有没有值」，明文绝不进视图（§7.1）。 */
function isKeySet(env: Readonly<Record<string, string>>, key: string | null): boolean {
  return readKey(env, key).trim() !== "";
}

/** 由 .env 解析结果构造设置窗视图；顺序固定，字段名与 PROVIDER_SETTINGS_FIELDS 一致。 */
export function buildProviderSettings(
  env: Readonly<Record<string, string>>,
): ProviderSettingsEntry[] {
  return PROVIDER_CAPABILITY_ORDER.map((capability) => {
    const keys = PROVIDER_KEY_MAPS[capability];
    return {
      capability,
      provider: toProviderValue(capability, env[keys.provider]),
      cloud_base_url: readKey(env, keys.cloudBaseUrl),
      cloud_model: readKey(env, keys.cloudModel),
      cloud_api_key_set: isKeySet(env, keys.cloudApiKey),
      local_base_url: readKey(env, keys.localBaseUrl),
      local_model: readKey(env, keys.localModel),
      local_token_set: isKeySet(env, keys.localToken),
      fallback_base_url: readKey(env, keys.fallbackBaseUrl),
      fallback_model: readKey(env, keys.fallbackModel),
    };
  });
}

/**
 * 把界面提交的改动翻译成 applyEnvUpdates 的入参。
 *
 * 缺省字段一律不出现（= 不改）；密钥字段传 null 也不出现，传 "" 才会被写成空值。
 */
export function providerPatchToEnv(
  patch: readonly ProviderSettingsPatchEntry[],
): Record<string, string | null> {
  const updates: Record<string, string | null> = {};
  for (const entry of patch) {
    const keys = PROVIDER_KEY_MAPS[entry.capability];
    if (entry.provider !== undefined) {
      updates[keys.provider] = entry.provider;
    }
    assign(updates, keys.cloudBaseUrl, entry.cloud_base_url);
    assign(updates, keys.cloudModel, entry.cloud_model);
    assign(updates, keys.localBaseUrl, entry.local_base_url);
    assign(updates, keys.localModel, entry.local_model);
    assign(updates, keys.fallbackBaseUrl, entry.fallback_base_url);
    assign(updates, keys.fallbackModel, entry.fallback_model);
    assign(updates, keys.cloudApiKey, entry.cloud_api_key);
    assign(updates, keys.localToken, entry.local_token);
  }
  return updates;
}

/** 单个字段的写入：键不存在（后置实现）或值与 null 都跳过。 */
function assign(
  updates: Record<string, string | null>,
  key: string | null,
  value: string | null | undefined,
): void {
  if (key === null || value === null || value === undefined) {
    return;
  }
  updates[key] = value;
}
