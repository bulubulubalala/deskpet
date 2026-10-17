/**
 * 文件职责：单测 app/main/provider-settings.ts 的键名映射（读视图 / 写改动两张方向）。
 *
 * 为什么值得单独测：双轨配置有八个键，最贵的错误是把云端键写到本地键上——
 * 症状是「设置看起来保存了，重启后模型还是没换」，而日志里只有「改了几个键」，
 * 排查要花掉一整个晚上；这里把每个键钉死（§6.13）。
 * 依赖方向：tests -> app/main/provider-settings.ts（不 import electron、不碰磁盘）。
 */
import { describe, expect, it } from "vitest";

import {
  buildProviderSettings,
  providerPatchToEnv,
  PROVIDER_DEFAULTS,
  PROVIDER_KEY_MAPS,
} from "../app/main/provider-settings";

const FULL_ENV: Record<string, string> = {
  DESKPET_LLM_PROVIDER: "cloud",
  DESKPET_LLM_BASE_URL: "https://cloud.example.com/v1",
  DESKPET_LLM_MODEL: "cloud-model",
  DESKPET_LLM_API_KEY: "sk-secret-value",
  DESKPET_LLM_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
  DESKPET_LLM_LOCAL_MODEL: "local-model",
  DESKPET_LLM_FALLBACK_BASE_URL: "https://backup.example.com/v1",
  DESKPET_LLM_FALLBACK_MODEL: "backup-model",
  DESKPET_ASR_PROVIDER: "local",
  DESKPET_ASR_MODEL: "small",
  DESKPET_TTS_PROVIDER: "local",
  DESKPET_TTS_URL: "http://127.0.0.1:8742",
  DESKPET_TTS_TOKEN: "tok-9f3a-secret",
};

describe("buildProviderSettings", () => {
  it("三个能力面按固定顺序返回，字段值与 .env 一致", () => {
    const entries = buildProviderSettings(FULL_ENV);
    expect(entries.map((entry) => entry.capability)).toEqual(["llm", "asr", "tts"]);
    const llm = entries[0];
    expect(llm).toMatchObject({
      provider: "cloud",
      cloud_base_url: "https://cloud.example.com/v1",
      cloud_model: "cloud-model",
      local_base_url: "http://127.0.0.1:11434/v1",
      local_model: "local-model",
      fallback_base_url: "https://backup.example.com/v1",
      fallback_model: "backup-model",
    });
    expect(entries[1]).toMatchObject({ provider: "local", local_model: "small" });
    expect(entries[2]).toMatchObject({
      provider: "local",
      local_base_url: "http://127.0.0.1:8742",
    });
  });

  it("密钥与口令只回布尔量，明文绝不出现在视图里", () => {
    const entries = buildProviderSettings(FULL_ENV);
    expect(entries[0]?.cloud_api_key_set).toBe(true);
    expect(entries[2]?.local_token_set).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("sk-secret-value");
    // 注意别用 "tok" 这种短串：local_token_set 这种字段名本身就会命中，断言会假失败
    expect(JSON.stringify(entries)).not.toContain("tok-9f3a-secret");
  });

  it("空配置与非法 provider 按面退回默认值（llm→cloud，asr/tts→local），缺的键给空串", () => {
    // 这是 T2.2 用户反馈第五轮修的 bug：界面以前一律回退 local，于是实际在用云端却显示「本地」
    const entries = buildProviderSettings({ DESKPET_LLM_PROVIDER: "  " });
    expect(entries[0]).toMatchObject({ provider: "cloud", cloud_base_url: "", local_model: "" });
    expect(buildProviderSettings({ DESKPET_LLM_PROVIDER: "gpu" })[0]?.provider).toBe("cloud");
    expect(buildProviderSettings({})[0]?.provider).toBe("cloud");
    expect(buildProviderSettings({})[1]?.provider).toBe("local");
    expect(buildProviderSettings({})[2]).toMatchObject({
      provider: "local",
      local_base_url: "",
      local_token_set: false,
    });
    expect(PROVIDER_DEFAULTS).toEqual({ llm: "cloud", asr: "local", tts: "local" });
    // 只有空白的密钥等于没配
    expect(buildProviderSettings({ DESKPET_LLM_API_KEY: "   " })[0]?.cloud_api_key_set).toBe(false);
  });

  it("云端 ASR / TTS 尚无用得上的键，一律空串（后置实现）", () => {
    const entries = buildProviderSettings(FULL_ENV);
    expect(entries[1]).toMatchObject({
      cloud_base_url: "",
      cloud_model: "",
      cloud_api_key_set: false,
    });
    expect(entries[2]).toMatchObject({
      cloud_base_url: "",
      cloud_model: "",
      cloud_api_key_set: false,
    });
    expect(PROVIDER_KEY_MAPS.asr.cloudBaseUrl).toBeNull();
    expect(PROVIDER_KEY_MAPS.tts.localModel).toBeNull();
  });
});

describe("providerPatchToEnv", () => {
  it("把界面改动翻成 .env 更新，缺省字段一个都不出现", () => {
    expect(providerPatchToEnv([{ capability: "llm", provider: "local" }])).toEqual({
      DESKPET_LLM_PROVIDER: "local",
    });
  });

  it("云端与本地键各归各位，备用端点也落对键", () => {
    expect(
      providerPatchToEnv([
        {
          capability: "llm",
          cloud_base_url: "https://cloud.example.com/v1",
          cloud_model: "cloud-model",
          local_base_url: "http://127.0.0.1:11434/v1",
          local_model: "local-model",
          fallback_base_url: "https://backup.example.com/v1",
          fallback_model: "backup-model",
        },
      ]),
    ).toEqual({
      DESKPET_LLM_BASE_URL: "https://cloud.example.com/v1",
      DESKPET_LLM_MODEL: "cloud-model",
      DESKPET_LLM_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
      DESKPET_LLM_LOCAL_MODEL: "local-model",
      DESKPET_LLM_FALLBACK_BASE_URL: "https://backup.example.com/v1",
      DESKPET_LLM_FALLBACK_MODEL: "backup-model",
    });
  });

  it("密钥：undefined 与 null 都不改，空串才是清空", () => {
    expect(providerPatchToEnv([{ capability: "llm" }])).toEqual({});
    expect(providerPatchToEnv([{ capability: "llm", cloud_api_key: null }])).toEqual({});
    expect(providerPatchToEnv([{ capability: "llm", cloud_api_key: "sk-new" }])).toEqual({
      DESKPET_LLM_API_KEY: "sk-new",
    });
    expect(providerPatchToEnv([{ capability: "llm", cloud_api_key: "" }])).toEqual({
      DESKPET_LLM_API_KEY: "",
    });
    expect(providerPatchToEnv([{ capability: "tts", local_token: "" }])).toEqual({
      DESKPET_TTS_TOKEN: "",
    });
  });

  it("后置实现的键不会被凭空写出来", () => {
    expect(
      providerPatchToEnv([
        { capability: "asr", cloud_base_url: "https://x/v1", local_model: "small" },
        { capability: "tts", local_base_url: "http://127.0.0.1:8742" },
      ]),
    ).toEqual({
      DESKPET_ASR_MODEL: "small",
      DESKPET_TTS_URL: "http://127.0.0.1:8742",
    });
  });
});
