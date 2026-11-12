/**
 * 文件职责：设置窗「常用服务商」的预设表与旧配置反推（LLM / ASR / TTS）。
 *
 * 为什么放在 shared：渲染层要拿它画下拉、主进程要校验 / 反推，两边必须同一份表；
 * 只读公开的 base_url 与建议模型，不含任何密钥。新增一个路由 = 这里加一条。
 * 依赖方向：shared 内部；只 import 类型，不碰 electron / node / DOM。
 */
import type { ProviderCapability, ProviderValue } from "./contracts/ipc";

/** 选中预设后要自动填的字段；没写的字段保持界面原值。 */
export interface ProviderPresetFields {
  readonly cloud_base_url?: string;
  readonly cloud_model?: string;
  readonly local_base_url?: string;
  readonly local_model?: string;
  readonly fallback_base_url?: string;
  readonly fallback_model?: string;
}

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  /** null = 自定义：不强行改来源，用户自己选。 */
  readonly provider: ProviderValue | null;
  readonly fields: ProviderPresetFields;
  readonly note: string;
  /** 只用于界面提示；真正校验在 sidecar / 端点。 */
  readonly requiresKey: boolean;
}

export interface PresetInferenceInput {
  readonly provider: ProviderValue;
  readonly cloud_base_url?: string;
  readonly local_base_url?: string;
  readonly local_model?: string;
}

function hostOf(url: string | undefined): string {
  if (url === undefined || url.trim() === "") {
    return "";
  }
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function portOf(url: string | undefined): string {
  if (url === undefined || url.trim() === "") {
    return "";
  }
  try {
    return new URL(url.trim()).port;
  } catch {
    return "";
  }
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

const LLM_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "cloud",
    fields: {
      cloud_base_url: "https://api.deepseek.com/v1",
      cloud_model: "deepseek-chat",
    },
    note: "在 DeepSeek 控制台创建 API Key；模型名可按控制台改成当前可用模型。",
    requiresKey: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    provider: "cloud",
    fields: {
      cloud_base_url: "https://api.openai.com/v1",
      cloud_model: "gpt-4o-mini",
    },
    note: "在 OpenAI 平台创建 API Key；模型名可按控制台改成当前可用模型。",
    requiresKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "cloud",
    fields: {
      cloud_base_url: "https://openrouter.ai/api/v1",
      cloud_model: "openai/gpt-4o-mini",
    },
    note: "OpenRouter 的模型 ID 通常带厂商前缀（例如 openai/...），可到模型页复制。",
    requiresKey: true,
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    provider: "cloud",
    fields: {
      cloud_base_url: "https://opencode.ai/inference/go/openai/v1",
      cloud_model: "deepseek-v4.1-flash",
    },
    note: "OpenCode Go 需要 API Key；deskpet 会自动发送 x-opencode-session 会话头。",
    requiresKey: true,
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    provider: "local",
    fields: {
      local_base_url: "http://127.0.0.1:11434/v1",
      local_model: "qwen2.5:7b",
    },
    note: "本机 Ollama 默认端口 11434；不需要 API Key，模型名按 ollama list 填。",
    requiresKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio（本地）",
    provider: "local",
    fields: {
      local_base_url: "http://127.0.0.1:1234/v1",
    },
    note: "LM Studio 本地服务器默认端口 1234；不需要 API Key，模型名按软件里显示的填。",
    requiresKey: false,
  },
  {
    id: "custom",
    label: "自定义",
    provider: null,
    fields: {},
    note: "自己填端点、模型和密钥；端点需是 OpenAI 兼容的 /v1 地址。",
    requiresKey: true,
  },
];

const ASR_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai-whisper",
    label: "OpenAI Whisper",
    provider: "cloud",
    fields: {
      cloud_base_url: "https://api.openai.com/v1",
      cloud_model: "whisper-1",
    },
    note: "OpenAI 兼容转录端点；只上传这一段语音，不记别的。",
    requiresKey: true,
  },
  {
    id: "groq-whisper",
    label: "Groq Whisper",
    provider: "cloud",
    fields: {
      cloud_base_url: "https://api.groq.com/openai/v1",
      cloud_model: "whisper-large-v3-turbo",
    },
    note: "Groq 的 OpenAI 兼容转录端点；国内网络可能需要代理。",
    requiresKey: true,
  },
  {
    id: "local-small",
    label: "本地 small（推荐）",
    provider: "local",
    fields: { local_model: "small" },
    note: "本地 faster-whisper；首次识别会自动下载到 data/models/asr。",
    requiresKey: false,
  },
  {
    id: "local-medium",
    label: "本地 medium",
    provider: "local",
    fields: { local_model: "medium" },
    note: "比 small 更准、更慢、体积更大；首次识别自动下载。",
    requiresKey: false,
  },
  {
    id: "local-large-v3",
    label: "本地 large-v3",
    provider: "local",
    fields: { local_model: "large-v3" },
    note: "精度最高、资源占用也最大；首次识别自动下载。",
    requiresKey: false,
  },
  {
    id: "custom",
    label: "自定义",
    provider: null,
    fields: {},
    note: "自己填云端转录端点、模型和密钥，或本地模型名。",
    requiresKey: true,
  },
];

const TTS_PRESETS: readonly ProviderPreset[] = [
  {
    id: "indextts-local",
    label: "本地 IndexTTS 适配器",
    provider: "local",
    fields: { local_base_url: "http://127.0.0.1:8742" },
    note: "自己部署的 IndexTTS 适配器；本项目只调用，不启动、不调参。",
    requiresKey: false,
  },
  {
    id: "edge",
    label: "Edge 在线（默认音色）",
    provider: "edge",
    fields: {},
    note: "零密钥、需联网；音色仍由 .env 的 DESKPET_TTS_EDGE_VOICE 控制。",
    requiresKey: false,
  },
  {
    id: "custom",
    label: "自定义适配器",
    provider: null,
    fields: {},
    note: "自己填适配器地址与口令；只影响发音，不影响聊天与记忆。",
    requiresKey: false,
  },
];

export const PROVIDER_PRESETS: Record<ProviderCapability, readonly ProviderPreset[]> = {
  llm: LLM_PRESETS,
  asr: ASR_PRESETS,
  tts: TTS_PRESETS,
};

export const CUSTOM_PRESET_ID = "custom";

/** 按 id 找预设；未知 id 返回 undefined（调用方按自定义处理）。 */
export function findPreset(capability: ProviderCapability, id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[capability].find((preset) => preset.id === id);
}

/**
 * 旧配置没有 preset 时按端点/模型反推一个显示值。
 * 只影响界面与 LLM 的额外头选择；推不出来就显示自定义，不报错。
 */
export function inferPreset(capability: ProviderCapability, input: PresetInferenceInput): string {
  const cloudHost = hostOf(input.cloud_base_url);
  const localHost = hostOf(input.local_base_url);
  const localPort = portOf(input.local_base_url);
  const localModel = (input.local_model ?? "").trim().toLowerCase();

  if (capability === "llm") {
    if (input.provider === "local") {
      if (isLocalHost(localHost) && localPort === "11434") {
        return "ollama";
      }
      if (isLocalHost(localHost) && localPort === "1234") {
        return "lmstudio";
      }
      return CUSTOM_PRESET_ID;
    }
    if (cloudHost === "api.deepseek.com") {
      return "deepseek";
    }
    if (cloudHost === "api.openai.com") {
      return "openai";
    }
    if (cloudHost === "openrouter.ai") {
      return "openrouter";
    }
    if (cloudHost === "opencode.ai" || cloudHost.endsWith(".opencode.ai")) {
      return "opencode-go";
    }
    return CUSTOM_PRESET_ID;
  }

  if (capability === "asr") {
    if (input.provider === "local") {
      if (localModel === "small" || localModel === "medium" || localModel === "large-v3") {
        return "local-" + localModel;
      }
      return CUSTOM_PRESET_ID;
    }
    if (cloudHost === "api.openai.com") {
      return "openai-whisper";
    }
    if (cloudHost === "api.groq.com") {
      return "groq-whisper";
    }
    return CUSTOM_PRESET_ID;
  }

  // TTS：edge 直接对上；本地默认端口算 IndexTTS 适配器。
  if (input.provider === "edge") {
    return "edge";
  }
  if (input.provider === "local") {
    const port = portOf(input.local_base_url);
    if (port === "" || port === "8742") {
      return "indextts-local";
    }
  }
  return CUSTOM_PRESET_ID;
}
