/**
 * 文件职责：CharacterVoiceLoader 与情感向量换算的单测（角色包 → /tts 入参那一步）。
 *
 * 为什么要锚到 sidecar 的 openapi.json：主进程这份实现是「第二份」8 维向量约定，
 * 一旦 sidecar 改了维度或默认权重，这里必须跟着红，而不是等运行时才发现。
 * 依赖方向：tests -> app/main/character-voice.ts + sidecar/contracts/openapi.json（临时目录造角色包）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CharacterVoiceLoader,
  DEFAULT_EMOTION_INTENSITY,
  EMOTION_VECTOR_SIZE,
  emotionVectorFor,
  scaleEmotionVector,
  ttsLangFor,
  type CharacterVoiceProfile,
} from "../app/main/character-voice";
import type { MainLogger } from "../app/main/logger";

const logger: MainLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
};

interface Pack {
  readonly dir: string;
  readonly charId: string;
  readonly root: string;
  cleanup(): Promise<void>;
}

async function makePack(voice: unknown, emotions?: unknown): Promise<Pack> {
  const dir = await mkdtemp(join(tmpdir(), "deskpet-voice-"));
  const charId = "amber";
  const root = join(dir, charId);
  await mkdir(root, { recursive: true });
  if (voice !== undefined) {
    await writeFile(join(root, "voice.json"), JSON.stringify(voice), "utf8");
  }
  if (emotions !== undefined) {
    await writeFile(join(root, "emotion_map.json"), JSON.stringify(emotions), "utf8");
  }
  await writeFile(join(root, "ref.wav"), Buffer.from([82, 73, 70, 70]));
  return {
    dir,
    charId,
    root,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const JOY: readonly number[] = [1, 0, 0, 0, 0, 0, 0, 0];

describe("CharacterVoiceLoader", () => {
  it("相对参考音按角色包目录解析，lang 收窄到 /tts 认的三种", async () => {
    const pack = await makePack({ ref_audio: "ref.wav", lang: "JA" }, { joy: { vector: JOY } });
    const loader = new CharacterVoiceLoader(pack.dir, logger);

    const profile = await loader.load(pack.charId);

    expect(profile.voiceMissing).toBe(false);
    expect(profile.voiceId).toBe(join(pack.root, "ref.wav"));
    expect(profile.lang).toBe("ja");
    expect(profile.emotions.get("joy")).toEqual(JOY);
    await pack.cleanup();
  });

  it("绝对路径参考音直接用；AR/ES 之类按 zh 处理", async () => {
    const pack = await makePack({ ref_audio: "", lang: "AR" });
    const absolute = join(pack.root, "ref.wav");
    await writeFile(
      join(pack.root, "voice.json"),
      JSON.stringify({ ref_audio: absolute, lang: "AR" }),
      "utf8",
    );
    const loader = new CharacterVoiceLoader(pack.dir, logger);

    const profile = await loader.load(pack.charId);

    expect(isAbsolute(profile.voiceId)).toBe(true);
    expect(profile.lang).toBe("zh");
    await pack.cleanup();
  });

  it("参考音文件不存在 → voiceMissing（降级纯文字，不是错误）", async () => {
    const pack = await makePack({ ref_audio: "missing.wav", lang: "ZH" });
    const loader = new CharacterVoiceLoader(pack.dir, logger);

    const profile = await loader.load(pack.charId);

    expect(profile.voiceId).toBe("");
    expect(profile.voiceMissing).toBe(true);
    await pack.cleanup();
  });

  it("角色包整个缺失也不抛，按没有声音处理", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-voice-"));
    const loader = new CharacterVoiceLoader(dir, logger);

    const profile = await loader.load("nobody");

    expect(profile.voiceMissing).toBe(true);
    expect(profile.lang).toBe("zh");
    expect(profile.emotions.size).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("情感表里不合规的条目跳过，合法的保留", async () => {
    const pack = await makePack(
      { ref_audio: "ref.wav", lang: "ZH" },
      {
        joy: { vector: JOY },
        short: { vector: [1, 2, 3] },
        text: { vector: "不是数组" },
        number: 7,
      },
    );
    const loader = new CharacterVoiceLoader(pack.dir, logger);

    const profile = await loader.load(pack.charId);

    expect([...profile.emotions.keys()]).toEqual(["joy"]);
    await pack.cleanup();
  });

  it("按 char_id 缓存，invalidate 后重读", async () => {
    const pack = await makePack({ ref_audio: "ref.wav", lang: "JA" });
    const loader = new CharacterVoiceLoader(pack.dir, logger);

    const first = await loader.load(pack.charId);
    await writeFile(
      join(pack.root, "voice.json"),
      JSON.stringify({ ref_audio: "ref.wav", lang: "EN" }),
      "utf8",
    );
    const cached = await loader.load(pack.charId);
    expect(cached.lang).toBe(first.lang);

    loader.invalidate(pack.charId);
    const reloaded = await loader.load(pack.charId);
    expect(reloaded.lang).toBe("en");
    await pack.cleanup();
  });
});

describe("情感向量与语言换算", () => {
  it("ttsLangFor 只认 zh/ja/en，其余落 zh", () => {
    expect(ttsLangFor("ZH")).toBe("zh");
    expect(ttsLangFor("En")).toBe("en");
    expect(ttsLangFor("ja")).toBe("ja");
    expect(ttsLangFor("AR")).toBe("zh");
    expect(ttsLangFor("ES")).toBe("zh");
    expect(ttsLangFor("")).toBe("zh");
  });

  it("scaleEmotionVector 按强度缩放、夹到 0–1、保留 4 位小数", () => {
    const base = [0.5, 2, -1, 0.123456, 1, 0, 0, 0];
    expect(scaleEmotionVector(base, 0.5)).toEqual([0.25, 0.5, 0, 0.0617, 0.5, 0, 0, 0]);
    expect(scaleEmotionVector(base, 2)).toEqual([0.5, 1, 0, 0.1235, 1, 0, 0, 0]);
    expect(scaleEmotionVector(base, Number.NaN)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("emotionVectorFor：未知标签给零向量，缺强度用默认值", () => {
    const profile: CharacterVoiceProfile = {
      charId: "amber",
      voiceId: "ref.wav",
      lang: "zh",
      emotions: new Map([["joy", JOY]]),
      voiceMissing: false,
    };

    expect(emotionVectorFor(profile, "joy", undefined)).toEqual([0.6, 0, 0, 0, 0, 0, 0, 0]);
    expect(emotionVectorFor(profile, "nope", 1)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(emotionVectorFor(profile, undefined, 1)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(DEFAULT_EMOTION_INTENSITY).toBe(0.6);
  });

  it("与 sidecar 契约对账：emo_vector 维度与默认权重一致", async () => {
    const raw = await readFile(
      new URL("../sidecar/contracts/openapi.json", import.meta.url),
      "utf8",
    );
    const spec = JSON.parse(raw) as {
      components: {
        schemas: {
          TtsRequest: {
            properties: {
              emo_vector: { minItems: number; maxItems: number };
              emo_weight: { default: number };
            };
          };
        };
      };
    };
    const vector = spec.components.schemas.TtsRequest.properties.emo_vector;
    expect(vector.minItems).toBe(EMOTION_VECTOR_SIZE);
    expect(vector.maxItems).toBe(EMOTION_VECTOR_SIZE);
    expect(spec.components.schemas.TtsRequest.properties.emo_weight.default).toBe(
      DEFAULT_EMOTION_INTENSITY,
    );
  });
});
