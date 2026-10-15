/**
 * 文件职责：按角色包读「怎么说话」的两小块数据——voice.json 与 emotion_map.json（§6.1）。
 *
 * 为什么主进程也要读角色包：/tts 的入参是 voice_id + emo_vector（§6.12），而「参考音路径」
 * 与「情感标签 → 8 维向量」只存在于角色包里；sidecar 的 chat 流只给情感**标签**（§6.2）。
 * 主进程多取一次这两份小文件，比改已冻结的 §6.12（在 /tts 里塞 char_id 二次查表）更省事。
 * 权威校验仍在 sidecar 的 character_store：这里只做「读得出就用，读不出就静音」——
 * 任何坏数据都降级成纯文字，绝不拦住对话（§6.7「能自愈的别打扰用户」）。
 * 依赖方向：main -> node:fs + ./logger；谁调用：app/main/chat-orchestrator.ts。
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { MainLogger } from "./logger";

/** 与 sidecar/contracts/api_models.py 的 EMOTION_VECTOR_DIMENSIONS 同长（锚点测试会对账）。 */
export const EMOTION_VECTOR_SIZE = 8;
/** 台词没给 intensity 时的默认强度；0.6 与 sidecar 的 TtsRequest.emo_weight 默认值一致。 */
export const DEFAULT_EMOTION_INTENSITY = 0.6;
/** /tts 的 lang 只收这三种（T1.5 契约）；角色包的 ZH/EN/JA/AR/ES 要在这里收窄。 */
export const TTS_LANGS = ["zh", "ja", "en"] as const;
export type TtsLang = (typeof TTS_LANGS)[number];

export interface CharacterVoiceProfile {
  readonly charId: string;
  /** 给 /tts 的 voice_id：参考音绝对路径（适配器 resolve_voice 接受路径）。 */
  readonly voiceId: string;
  readonly lang: TtsLang;
  readonly emotions: ReadonlyMap<string, readonly number[]>;
  /** 没有可用参考音：这一轮只能纯文字（不是错误，是角色包还没配声音）。 */
  readonly voiceMissing: boolean;
}

const ZERO_VECTOR: readonly number[] = Object.freeze(
  Array.from({ length: EMOTION_VECTOR_SIZE }, () => 0),
);

const LANG_MAP: Record<string, TtsLang> = { ZH: "zh", EN: "en", JA: "ja" };

/** 角色包 voice.json 的 lang 支持 ZH/EN/JA/AR/ES；/tts 只认 zh/ja/en，其余按 zh 处理。 */
export function ttsLangFor(packLang: string): TtsLang {
  return LANG_MAP[packLang.toUpperCase()] ?? "zh";
}

function isVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMOTION_VECTOR_SIZE &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/** 把 8 维基向量按 intensity 缩放并夹到 0–1：IndexTTS 不接受别的量纲（§6.1 的校验同理）。 */
export function scaleEmotionVector(base: readonly number[], intensity: number): number[] {
  const ratio = Number.isFinite(intensity) ? Math.min(Math.max(intensity, 0), 1) : 0;
  return base.map((item) => Math.round(Math.min(Math.max(item, 0), 1) * ratio * 10000) / 10000);
}

/** 台词里的情感标签 → 可直接喂 /tts 的向量；未知标签按中性处理（台词照说，只是不带情绪）。 */
export function emotionVectorFor(
  profile: CharacterVoiceProfile,
  label: string | undefined,
  intensity: number | undefined,
): number[] {
  const base = (label === undefined ? undefined : profile.emotions.get(label)) ?? ZERO_VECTOR;
  const ratio = intensity ?? DEFAULT_EMOTION_INTENSITY;
  return scaleEmotionVector(base, ratio);
}

export class CharacterVoiceLoader {
  private readonly cache = new Map<string, CharacterVoiceProfile>();

  constructor(
    private readonly charactersDir: string,
    private readonly logger: MainLogger,
  ) {}

  /** 读一份角色包的音色配置；结果按 char_id 缓存（热重载是 M3 编辑器阶段的事）。 */
  async load(charId: string): Promise<CharacterVoiceProfile> {
    const cached = this.cache.get(charId);
    if (cached !== undefined) {
      return cached;
    }
    const profile = await this.readProfile(charId);
    this.cache.set(charId, profile);
    return profile;
  }

  /** 角色包换了之后由调用方显式失效；不传 charId 表示全清。 */
  invalidate(charId?: string): void {
    if (charId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(charId);
  }

  private async readProfile(charId: string): Promise<CharacterVoiceProfile> {
    const root = join(this.charactersDir, charId);
    const voice = await this.readJson(join(root, "voice.json"));
    const rawRef = typeof voice["ref_audio"] === "string" ? voice["ref_audio"] : "";
    const candidate = rawRef === "" ? "" : isAbsolute(rawRef) ? rawRef : join(root, rawRef);
    const refAudio = candidate !== "" && (await this.exists(candidate)) ? candidate : "";
    const emotions = await this.readEmotions(join(root, "emotion_map.json"));
    const rawLang = typeof voice["lang"] === "string" ? voice["lang"] : "ZH";
    const profile: CharacterVoiceProfile = {
      charId,
      voiceId: refAudio,
      lang: ttsLangFor(rawLang),
      emotions,
      voiceMissing: refAudio === "",
    };
    this.logger.info("pack.voice_loaded", "已读角色音色配置：" + charId, {
      module: "tts",
      fields: {
        charId,
        lang: profile.lang,
        emotionTags: emotions.size,
        voiceMissing: profile.voiceMissing,
      },
    });
    return profile;
  }

  private async readEmotions(path: string): Promise<ReadonlyMap<string, readonly number[]>> {
    const data = await this.readJson(path);
    const emotions = new Map<string, readonly number[]>();
    for (const [tag, entry] of Object.entries(data)) {
      const vector =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)["vector"]
          : undefined;
      if (isVector(vector)) {
        emotions.set(tag, vector);
      } else {
        this.logger.warn("pack.emotion_skipped", "情感条目缺少合法的 8 维向量，已跳过：" + tag);
      }
    }
    return emotions;
  }

  private async readJson(path: string): Promise<Record<string, unknown>> {
    try {
      const text = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (error) {
      // 文件不存在也是走这里：角色包还没配声音，属于正常降级而不是故障
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.debug("pack.read_missed", "角色包文件读不到（按无声音处理）：" + path, {
        fields: { detail },
      });
      return {};
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const info = await stat(path);
      return info.isFile();
    } catch {
      return false;
    }
  }
}
