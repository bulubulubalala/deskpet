/**
 * 文件职责：「记忆」设置里的 .env 映射（T2.1c）——行为记忆总开关的读写纯函数。
 *
 * 为什么单独一份：界面只认 IPC 契约里的布尔量，.env 的键名与真假写法属于 sidecar 的配置
 * 方言（config.py 的 _bool_flag）。把这两件事收在纯函数里，设置窗与单测都不必碰 fs。
 * 谁调用：app/main/ipc-handlers.ts 的 deskpet:memory:behavior 通道。
 */

/** 行为记忆开关在 .env 里的键名，与 sidecar/config.py 的 _load_memory_settings 对齐。 */
export const MEMORY_BEHAVIOR_KEY = "DESKPET_MEMORY_BEHAVIOR_ENABLED";
/** 语义检索开关在 .env 里的键名，与 config.py 的 _load_embedding_settings 对齐。 */
export const MEMORY_EMBEDDING_KEY = "DESKPET_EMBED_ENABLED";
export const MEMORY_EMBEDDING_MODEL_KEY = "DESKPET_EMBED_MODEL";
export const MEMORY_EMBEDDING_BASE_URL_KEY = "DESKPET_EMBED_BASE_URL";
/** 向量来源：ollama=外接 Ollama；onnx=随包内置（T2.40），与 sidecar/config.py 对齐。 */
export const MEMORY_EMBEDDING_PROVIDER_KEY = "DESKPET_EMBED_PROVIDER";
/** 内置模型的 model_id：必须与 config.py 的 DEFAULT_EMBEDDING_LOCAL_MODEL 一字不差。 */
export const BUNDLED_EMBEDDING_MODEL_ID = "bge-small-zh-v1.5:int8@1";

const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

/**
 * 读 .env 里的开关值，得到界面上该勾还是该取消。
 *
 * 三种情况都返回 true（与 sidecar 的默认值一致）：键不存在、键是空串、键是非法值。
 * 非法值不在这里报错——sidecar 启动时 _bool_flag 会直接抛，界面上多说一句只会误导用户。
 */
export function parseBehaviorEnabled(env: Record<string, string>): boolean {
  const raw = (env[MEMORY_BEHAVIOR_KEY] ?? "").trim().toLowerCase();
  if (raw === "") {
    return true;
  }
  if (TRUTHY.includes(raw)) {
    return true;
  }
  if (FALSY.includes(raw)) {
    return false;
  }
  return true;
}

/**
 * 把界面的勾选翻译成 updateEnvFile 的入参。
 *
 * 一律写成 true / false 两个词（不写 1 / 0）：.env 是给人看的，读起来不用再想一遍。
 */
export function parseEmbeddingEnabled(env: Record<string, string>): boolean {
  return parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: env[MEMORY_EMBEDDING_KEY] ?? "" });
}

/**
 * 启用时同时补齐来源与模型，避免只开开关却仍指向空配置。
 *
 * 默认启用「随包内置」的 onnx 模型（zip 解压即用，不需要 Ollama）；只有 .env 里明确写着
 * provider=ollama（或老版本留下的 model/base_url 且没写 provider）时才继续走 Ollama——
 * 升级不能把用户已经建好的向量库静默换掉。
 */
export function embeddingEnvUpdate(
  env: Record<string, string>,
  enabled: boolean,
): Record<string, string> {
  if (!enabled) {
    return { [MEMORY_EMBEDDING_KEY]: "false" };
  }
  const provider = (env[MEMORY_EMBEDDING_PROVIDER_KEY] ?? "").trim().toLowerCase();
  const legacyOllama =
    provider === "" &&
    ((env[MEMORY_EMBEDDING_MODEL_KEY] ?? "").trim() !== "" ||
      (env[MEMORY_EMBEDDING_BASE_URL_KEY] ?? "").trim() !== "");
  if (provider === "ollama" || legacyOllama) {
    return {
      [MEMORY_EMBEDDING_KEY]: "true",
      [MEMORY_EMBEDDING_PROVIDER_KEY]: "ollama",
      [MEMORY_EMBEDDING_MODEL_KEY]: (env[MEMORY_EMBEDDING_MODEL_KEY] ?? "").trim() || "bge-m3",
      [MEMORY_EMBEDDING_BASE_URL_KEY]:
        (env[MEMORY_EMBEDDING_BASE_URL_KEY] ?? "").trim() || "http://127.0.0.1:11434",
    };
  }
  return {
    [MEMORY_EMBEDDING_KEY]: "true",
    [MEMORY_EMBEDDING_PROVIDER_KEY]: "onnx",
    [MEMORY_EMBEDDING_MODEL_KEY]: BUNDLED_EMBEDDING_MODEL_ID,
  };
}

export function behaviorEnvUpdate(enabled: boolean): Record<string, string> {
  return { [MEMORY_BEHAVIOR_KEY]: enabled ? "true" : "false" };
}
