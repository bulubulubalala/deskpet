/**
 * 文件职责：单测 app/main/memory-settings.ts —— 行为记忆总开关的 .env 映射（T2.1c）。
 *
 * 为什么值得单独测：开关的默认值必须与 sidecar/config.py 的 _bool_flag 完全一致。
 * 这里一旦把「没配」读成关，用户第一次打开设置窗看到的就是「行为记忆已关闭」，
 * 而实际运行里它是开的——界面上说的和引擎做的对不上，是最难排查的一类问题。
 * 依赖方向：tests -> app/main/memory-settings.ts（不 import electron、不碰磁盘）。
 */
import { describe, expect, it } from "vitest";

import {
  BUNDLED_EMBEDDING_MODEL_ID,
  behaviorEnvUpdate,
  embeddingEnvUpdate,
  MEMORY_BEHAVIOR_KEY,
  MEMORY_EMBEDDING_BASE_URL_KEY,
  MEMORY_EMBEDDING_KEY,
  MEMORY_EMBEDDING_MODEL_KEY,
  MEMORY_EMBEDDING_PROVIDER_KEY,
  parseBehaviorEnabled,
  parseEmbeddingEnabled,
} from "../app/main/memory-settings";

describe("parseBehaviorEnabled", () => {
  it("键不存在或为空串时按 sidecar 的默认值当成开着", () => {
    expect(MEMORY_BEHAVIOR_KEY).toBe("DESKPET_MEMORY_BEHAVIOR_ENABLED");
    expect(parseBehaviorEnabled({})).toBe(true);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "" })).toBe(true);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "   " })).toBe(true);
  });

  it("真写法的四种拼写都算开", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: value })).toBe(true);
    }
  });

  it("假写法的四种拼写都算关", () => {
    for (const value of ["0", "false", "no", "off"]) {
      expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: value })).toBe(false);
    }
  });

  it("大小写与首尾空白不影响判断", () => {
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "  FALSE " })).toBe(false);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "On" })).toBe(true);
  });

  it("非法值不在这里报错，退回默认值", () => {
    // sidecar 启动时 _bool_flag 会直接抛错；界面上再报一次只会把用户绕晕
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "也许" })).toBe(true);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "2" })).toBe(true);
  });
});

describe("behaviorEnvUpdate", () => {
  it("写回 true / false 两个词，不写 1 / 0", () => {
    expect(behaviorEnvUpdate(true)).toEqual({ [MEMORY_BEHAVIOR_KEY]: "true" });
    expect(behaviorEnvUpdate(false)).toEqual({ [MEMORY_BEHAVIOR_KEY]: "false" });
  });

  it("写回的值能被自己读回来（往返一致）", () => {
    const enabled = parseBehaviorEnabled(behaviorEnvUpdate(true));
    const disabled = parseBehaviorEnabled(behaviorEnvUpdate(false));
    expect(enabled).toBe(true);
    expect(disabled).toBe(false);
  });
});

describe("embeddingEnvUpdate", () => {
  it("关闭只写 enabled=false", () => {
    expect(embeddingEnvUpdate({}, false)).toEqual({ [MEMORY_EMBEDDING_KEY]: "false" });
  });

  it("开启时缺省用内置 onnx 模型，不写 Ollama 地址", () => {
    const env = embeddingEnvUpdate({}, true);
    expect(env[MEMORY_EMBEDDING_KEY]).toBe("true");
    expect(env[MEMORY_EMBEDDING_PROVIDER_KEY]).toBe("onnx");
    expect(env[MEMORY_EMBEDDING_MODEL_KEY]).toBe(BUNDLED_EMBEDDING_MODEL_ID);
    expect(env[MEMORY_EMBEDDING_BASE_URL_KEY]).toBeUndefined();
    expect(parseEmbeddingEnabled(env)).toBe(true);
  });

  it("老版本留下的 Ollama 配置继续走 Ollama，不被内置模型顶掉", () => {
    const legacy = {
      [MEMORY_EMBEDDING_MODEL_KEY]: "bge-m3",
      [MEMORY_EMBEDDING_BASE_URL_KEY]: "http://127.0.0.1:11434",
    };
    const env = embeddingEnvUpdate(legacy, true);
    expect(env[MEMORY_EMBEDDING_PROVIDER_KEY]).toBe("ollama");
    expect(env[MEMORY_EMBEDDING_MODEL_KEY]).toBe("bge-m3");
    expect(env[MEMORY_EMBEDDING_BASE_URL_KEY]).toBe("http://127.0.0.1:11434");
  });

  it("显式 provider=ollama 时补齐缺省模型与地址", () => {
    const env = embeddingEnvUpdate({ [MEMORY_EMBEDDING_PROVIDER_KEY]: "OLLAMA" }, true);
    expect(env[MEMORY_EMBEDDING_PROVIDER_KEY]).toBe("ollama");
    expect(env[MEMORY_EMBEDDING_MODEL_KEY]).toBe("bge-m3");
    expect(env[MEMORY_EMBEDDING_BASE_URL_KEY]).toBe("http://127.0.0.1:11434");
  });

  it("显式 provider=onnx 时保留用户改过的模型名", () => {
    const env = embeddingEnvUpdate(
      { [MEMORY_EMBEDDING_PROVIDER_KEY]: "onnx", [MEMORY_EMBEDDING_MODEL_KEY]: "custom" },
      true,
    );
    expect(env[MEMORY_EMBEDDING_PROVIDER_KEY]).toBe("onnx");
    expect(env[MEMORY_EMBEDDING_MODEL_KEY]).toBe(BUNDLED_EMBEDDING_MODEL_ID);
  });
});
