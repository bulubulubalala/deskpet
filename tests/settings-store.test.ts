/**
 * 文件职责：单测 app/main/settings-store.ts（D4 的唯一真相源：迁移、加密分区、原子写、只读保护）。
 *
 * 为什么这些用例值得存在：设置文件是「改了没用 / 密钥丢了 / 升级被旧版本写坏」这类
 * 最难复现的故障的现场，所以每条容错分支都要有断言，而不是只测 happy path。
 * 依赖方向：tests -> app/main（不 import electron；加密后端用假 SecretBox）。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isSecretKey,
  parseSettingsDocument,
  SettingsReadOnlyError,
  SettingsStore,
  SETTINGS_VERSION,
  type SecretBox,
} from "../app/main/settings-store";

const NOW = new Date("2026-11-09T10:00:00Z");

// 假加密：base64 之后磁盘上就看不到明文（真实现是 safeStorage/DPAPI）。
const encode = (plain: string): string => "b64:" + Buffer.from(plain, "utf8").toString("base64");
const decode = (sealed: string): string => {
  if (!sealed.startsWith("b64:")) {
    throw new Error("不是本测试的密文");
  }
  return Buffer.from(sealed.slice(4), "base64").toString("utf8");
};

const fakeBox: SecretBox = {
  available: true,
  seal: encode,
  open: decode,
};

const brokenBox: SecretBox = {
  available: true,
  seal: encode,
  open: (): string => {
    throw new Error("DPAPI 换了用户");
  },
};

let dir = "";
let file = "";
let envFile = "";
let warnings: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deskpet-settings-"));
  file = join(dir, "data", "settings.json");
  envFile = join(dir, ".env");
  warnings = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 直接往设置文件位置写内容（父目录按需创建），用于构造坏文件与未来版本。 */
async function writeSettingsFile(text: string): Promise<void> {
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(file, text, "utf8");
}

async function openStore(overrides: Partial<Parameters<typeof SettingsStore.open>[0]> = {}) {
  return SettingsStore.open({
    file,
    box: fakeBox,
    legacyEnvFile: envFile,
    now: (): Date => NOW,
    onLog: (level, event): void => {
      if (level === "warn") {
        warnings.push(event);
      }
    },
    ...overrides,
  });
}

describe("isSecretKey", () => {
  it("按结尾识别密钥，普通配置不误判", () => {
    expect(isSecretKey("DESKPET_LLM_API_KEY")).toBe(true);
    expect(isSecretKey("DESKPET_TTS_TOKEN")).toBe(true);
    expect(isSecretKey("HF_TOKEN")).toBe(true);
    expect(isSecretKey("DESKPET_DB_PASSWORD")).toBe(true);
    expect(isSecretKey("DESKPET_LLM_BASE_URL")).toBe(false);
    expect(isSecretKey("DESKPET_LLM_MODEL")).toBe(false);
  });
});

describe("首次启动迁移", () => {
  it("把旧 .env 导入 settings.json：普通值进 values，密钥加密进 secrets", async () => {
    await writeFile(
      envFile,
      ["DESKPET_LLM_PROVIDER=cloud", "DESKPET_LLM_API_KEY=sk-secret", "EMPTY="].join("\n"),
      "utf8",
    );
    const store = await openStore();
    expect(store.migratedFromEnv).toBe(true);
    expect(store.toEnv()).toEqual({
      DESKPET_LLM_PROVIDER: "cloud",
      DESKPET_LLM_API_KEY: "sk-secret",
    });
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("sk-secret");
    expect(text).toContain("v1:" + encode("sk-secret"));
    expect(JSON.parse(text)).toMatchObject({
      version: SETTINGS_VERSION,
      values: { DESKPET_LLM_PROVIDER: "cloud" },
    });
  });

  it("没有 .env 也没有设置文件时为空仓库，且不凭空空建文件", async () => {
    const store = await openStore();
    expect(store.toEnv()).toEqual({});
    expect(store.migratedFromEnv).toBe(false);
    await expect(stat(file)).rejects.toThrow();
  });

  it("设置文件已存在时不再读 .env（旧文件只当迁移来源）", async () => {
    await writeFile(envFile, "DESKPET_LLM_MODEL=from-env", "utf8");
    const first = await openStore();
    await first.update({ DESKPET_LLM_MODEL: "from-settings" });
    await writeFile(envFile, "DESKPET_LLM_MODEL=from-env-again", "utf8");
    const second = await openStore();
    expect(second.migratedFromEnv).toBe(false);
    expect(second.get("DESKPET_LLM_MODEL")).toBe("from-settings");
  });
});

describe("update 语义", () => {
  it("null 不改、空串删除、其它值覆盖，并原子落盘（不留 .tmp）", async () => {
    const store = await openStore();
    await store.update({ DESKPET_LLM_PROVIDER: "cloud", DESKPET_TTS_URL: "http://127.0.0.1:1" });
    const env = await store.update({
      DESKPET_LLM_PROVIDER: null,
      DESKPET_TTS_URL: "",
      DESKPET_LLM_MODEL: "m1",
    });
    expect(env).toEqual({ DESKPET_LLM_PROVIDER: "cloud", DESKPET_LLM_MODEL: "m1" });
    const names = await readdir(join(dir, "data"));
    expect(names).toEqual(["settings.json"]);
    const reloaded = await openStore();
    expect(reloaded.toEnv()).toEqual({ DESKPET_LLM_PROVIDER: "cloud", DESKPET_LLM_MODEL: "m1" });
  });

  it("并发写不会互相覆盖（写操作串成一条链）", async () => {
    const store = await openStore();
    await Promise.all([store.update({ A: "1" }), store.update({ B: "2" })]);
    const reloaded = await openStore();
    expect(reloaded.toEnv()).toEqual({ A: "1", B: "2" });
  });
});

describe("容错", () => {
  it("坏 JSON 备份成 .corrupt-* 后从 .env 重建", async () => {
    await writeSettingsFile("not json");
    await writeFile(envFile, "DESKPET_LLM_MODEL=m", "utf8");
    const store = await openStore();
    expect(store.get("DESKPET_LLM_MODEL")).toBe("m");
    expect(warnings).toContain("settings.corrupt");
    const names = await readdir(join(dir, "data"));
    expect(names.some((name) => name.startsWith("settings.json.corrupt-"))).toBe(true);
  });

  it("版本高于本程序时只读，读得到值但 write 被拒", async () => {
    await writeSettingsFile(
      JSON.stringify({ version: 99, updated_at: "", values: { A: "1" }, secrets: {} }),
    );
    const store = await openStore();
    expect(store.isReadOnly).toBe(true);
    expect(store.get("A")).toBe("1");
    await expect(store.update({ A: "2" })).rejects.toBeInstanceOf(SettingsReadOnlyError);
  });

  it("没有加密后端时降级存明文并告警，读回来仍是原值", async () => {
    const store = await openStore({ box: null });
    await store.update({ DESKPET_LLM_API_KEY: "sk-plain" });
    expect(store.get("DESKPET_LLM_API_KEY")).toBe("sk-plain");
    const text = await readFile(file, "utf8");
    expect(text).toContain("plain:sk-plain");
    expect(warnings).toContain("settings.plaintext_secret");
    const reloaded = await openStore({ box: null });
    expect(reloaded.get("DESKPET_LLM_API_KEY")).toBe("sk-plain");
  });

  it("密钥解不开时按未配置处理并告警，不把密文当密钥发出去", async () => {
    const store = await openStore();
    await store.update({ DESKPET_LLM_API_KEY: "sk-secret" });
    const reloaded = await openStore({ box: brokenBox });
    expect(reloaded.get("DESKPET_LLM_API_KEY")).toBeUndefined();
    expect(warnings).toContain("settings.secret_unreadable");
  });
});

describe("parseSettingsDocument", () => {
  it("缺省字段按空处理，结构不对抛错", () => {
    expect(parseSettingsDocument(JSON.stringify({ version: 1 }))).toMatchObject({
      version: 1,
      values: {},
      secrets: {},
    });
    expect(() => parseSettingsDocument("[]")).toThrow(/顶层必须是对象/);
    expect(() => parseSettingsDocument(JSON.stringify({ version: 0 }))).toThrow(/正整数/);
    expect(() => parseSettingsDocument(JSON.stringify({ version: 1, values: { A: 1 } }))).toThrow(
      /values\.A 必须是字符串/,
    );
  });
});
