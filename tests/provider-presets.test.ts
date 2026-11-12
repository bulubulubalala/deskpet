import { describe, expect, it } from "vitest";

import {
  CUSTOM_PRESET_ID,
  findPreset,
  inferPreset,
  PROVIDER_PRESETS,
} from "../app/shared/provider-presets";

describe("PROVIDER_PRESETS", () => {
  it("每个能力面都有自定义，且 id 不重复", () => {
    for (const capability of ["llm", "asr", "tts"] as const) {
      const presets = PROVIDER_PRESETS[capability];
      const ids = presets.map((preset) => preset.id);
      expect(ids).toContain(CUSTOM_PRESET_ID);
      expect(new Set(ids).size).toBe(ids.length);
      expect(presets.find((preset) => preset.id === CUSTOM_PRESET_ID)?.provider).toBeNull();
    }
  });

  it("内置路由的端点都是 http(s)，语义字段齐全", () => {
    for (const capability of ["llm", "asr", "tts"] as const) {
      for (const preset of PROVIDER_PRESETS[capability]) {
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.note.length).toBeGreaterThan(0);
        const url = preset.fields.cloud_base_url ?? preset.fields.local_base_url;
        if (url !== undefined) {
          const parsed = new URL(url);
          expect(["http:", "https:"]).toContain(parsed.protocol);
        }
        if (preset.id !== CUSTOM_PRESET_ID) {
          expect(preset.provider).not.toBeNull();
        }
      }
    }
  });
});

describe("inferPreset", () => {
  it("按 LLM 端点识别常用路由", () => {
    expect(
      inferPreset("llm", {
        provider: "cloud",
        cloud_base_url: "https://api.deepseek.com/v1",
      }),
    ).toBe("deepseek");
    expect(
      inferPreset("llm", { provider: "cloud", cloud_base_url: "https://api.openai.com/v1" }),
    ).toBe("openai");
    expect(
      inferPreset("llm", {
        provider: "cloud",
        cloud_base_url: "https://opencode.ai/inference/go/openai/v1",
      }),
    ).toBe("opencode-go");
    expect(
      inferPreset("llm", {
        provider: "local",
        local_base_url: "http://127.0.0.1:11434/v1",
      }),
    ).toBe("ollama");
    expect(
      inferPreset("llm", { provider: "cloud", cloud_base_url: "https://x.example.com/v1" }),
    ).toBe(CUSTOM_PRESET_ID);
  });

  it("按 ASR 的 provider / 模型 / 端点识别", () => {
    expect(inferPreset("asr", { provider: "local", local_model: "small" })).toBe("local-small");
    expect(inferPreset("asr", { provider: "local", local_model: "medium" })).toBe("local-medium");
    expect(
      inferPreset("asr", {
        provider: "cloud",
        cloud_base_url: "https://api.groq.com/openai/v1",
      }),
    ).toBe("groq-whisper");
    expect(inferPreset("asr", { provider: "local", local_model: "tiny" })).toBe(CUSTOM_PRESET_ID);
  });

  it("TTS 按 provider / 端口识别", () => {
    expect(inferPreset("tts", { provider: "edge" })).toBe("edge");
    expect(
      inferPreset("tts", {
        provider: "local",
        local_base_url: "http://127.0.0.1:8742",
      }),
    ).toBe("indextts-local");
    expect(inferPreset("tts", { provider: "local", local_base_url: "http://127.0.0.1:9999" })).toBe(
      CUSTOM_PRESET_ID,
    );
  });
});

describe("findPreset", () => {
  it("未知 id 返回 undefined，交给界面按自定义处理", () => {
    expect(findPreset("llm", "not-a-preset")).toBeUndefined();
    expect(findPreset("llm", "opencode-go")?.label).toBe("OpenCode Go");
  });
});
