/**
 * 文件职责：运行时设置的唯一真相源 `data/settings.json`（D4）——版本化文档 + 明文/密钥分区 + 原子写。
 *
 * 为什么需要它：设置窗曾经同时读写 .env、provider-settings、memory-settings、sidecar/config.py
 * 四套真相，改一处漏一处；.env 还是文本方言（注释/引号/export），写回时得靠 applyEnvUpdates 保顺序。
 * 现在只有一份 JSON 文档：values 存普通配置，secrets 存加密后的密钥；.env 只在首次启动时导入一次。
 *
 * 为什么加密不放在 Python 侧：主进程启动时就要把密钥交给 sidecar 子进程，Python 的 DPAPI 帮不上忙，
 * 还会绕成循环。改用 Electron 自带的 safeStorage（Windows 底下就是 DPAPI），由调用方注入 SecretBox，
 * 这样本模块在 WSL 单测里不碰 electron。
 *
 * 依赖方向：main -> node:fs / node:path / ./env-file（只读旧 .env 做迁移）；不 import electron。
 * 谁调用：app/main/index.ts（启动装载）、app/main/ipc-handlers.ts（设置窗读写）。
 */
import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { readEnvFile } from "./env-file";

/** 与 ui.json / dev.json 同目录（data/），便于整目录备份与导出。 */
export const SETTINGS_FILE_NAME = "settings.json";
/** 文档版本：只在结构真变了时才加。比它大的文件只读不写（旧版本别把新配置写坏）。 */
export const SETTINGS_VERSION = 1;

/** 加密后的前缀：`v1:` = SecretBox 产物；`plain:` = 没有加密后端时的降级写法（会告警）。 */
const SEALED_PREFIX = "v1:";
const PLAIN_PREFIX = "plain:";

/**
 * 哪些键算密钥：只按「名字以什么结尾」判断，不看值。
 * 覆盖 DESKPET_LLM_API_KEY / DESKPET_ASR_CLOUD_API_KEY / DESKPET_TTS_TOKEN / HF_TOKEN 这类。
 */
const SECRET_KEY_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD)$/i;

/** 判断一个键是否要进 secrets 分区（加密存放，日志与导出都不回显）。 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key.trim());
}

/**
 * 加密后端的最小接口：seal 把明文变成可落盘字符串，open 反过来。
 * available=false 表示当前平台没有可用后端（例如 Linux 未配 keyring），此时降级存明文并告警。
 */
export interface SecretBox {
  readonly available: boolean;
  seal(plain: string): string;
  open(sealed: string): string;
}

export interface SettingsDocument {
  readonly version: number;
  readonly updated_at: string;
  readonly values: Record<string, string>;
  readonly secrets: Record<string, string>;
}

export type SettingsLogLevel = "info" | "warn";

export interface SettingsStoreOptions {
  /** settings.json 的绝对路径。 */
  readonly file: string;
  /** 加密后端；null = 没有（单测与无 keyring 的 Linux）。 */
  readonly box?: SecretBox | null;
  /** 旧 .env 路径：仅当 settings.json 不存在时导入一次。 */
  readonly legacyEnvFile?: string;
  readonly now?: () => Date;
  /** 只记事件与说明，不记值（日志里永远不该出现密钥）。 */
  readonly onLog?: (level: SettingsLogLevel, event: string, message: string) => void;
  /** 注入读 .env 的实现，单测可省掉真实文件；默认用 env-file.ts 的 readEnvFile。 */
  readonly readLegacyEnv?: (path: string) => Promise<Record<string, string>>;
}

/** 文件内容不是合法设置文档（坏 JSON、结构不对）。 */
export class SettingsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsFormatError";
  }
}

/** 文件由更新版本写入：只读，不覆盖。 */
export class SettingsReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsReadOnlyError";
  }
}

/** 空文档（首次启动且没有可迁移的 .env）。 */
export function emptyDocument(now: Date): SettingsDocument {
  return { version: SETTINGS_VERSION, updated_at: now.toISOString(), values: {}, secrets: {} };
}

function asStringMap(raw: unknown, field: string): Record<string, string> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SettingsFormatError(`${field} 必须是对象`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new SettingsFormatError(`${field}.${key} 必须是字符串`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 解析设置文档。容错边界：字段类型不对算坏文件（宁可备份重来），多余字段忽略（向前兼容）。
 * version 比当前大不算错——照常读出 values，但由调用方置为只读，避免旧版本写坏新配置。
 */
export function parseSettingsDocument(text: string): SettingsDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    throw new SettingsFormatError(
      "不是合法 JSON：" + (error instanceof Error ? error.message : ""),
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettingsFormatError("顶层必须是对象");
  }
  const record = raw as Record<string, unknown>;
  const version = record["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new SettingsFormatError("version 必须是正整数");
  }
  const updated = record["updated_at"];
  return {
    version,
    updated_at: typeof updated === "string" ? updated : "",
    values: asStringMap(record["values"], "values"),
    secrets: asStringMap(record["secrets"], "secrets"),
  };
}

/** 序列化：键排序 + 两空格缩进，让 git diff 与人工查看都可读。 */
export function serializeSettingsDocument(document: SettingsDocument): string {
  const sortMap = (map: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const key of Object.keys(map).sort()) {
      out[key] = map[key] ?? "";
    }
    return out;
  };
  return (
    JSON.stringify(
      {
        version: document.version,
        updated_at: document.updated_at,
        values: sortMap(document.values),
        secrets: sortMap(document.secrets),
      },
      null,
      2,
    ) + "\n"
  );
}

function sealValue(
  plain: string,
  box: SecretBox | null,
  onLog?: SettingsStoreOptions["onLog"],
): string {
  if (box !== null && box.available) {
    try {
      return SEALED_PREFIX + box.seal(plain);
    } catch (error: unknown) {
      onLog?.(
        "warn",
        "settings.seal_failed",
        "密钥加密失败，本次以降级方式保存：" + describe(error),
      );
    }
  }
  onLog?.(
    "warn",
    "settings.plaintext_secret",
    "当前环境没有可用的加密后端（safeStorage 不可用），密钥将以明文形式保存在 settings.json",
  );
  return PLAIN_PREFIX + plain;
}

/** 把一份「键值表」（.env 解析结果或进程环境）切成 values / secrets 两个分区。 */
export function documentFromEnv(
  env: Readonly<Record<string, string>>,
  box: SecretBox | null,
  now: Date,
  onLog?: SettingsStoreOptions["onLog"],
): SettingsDocument {
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === "") {
      continue;
    }
    if (isSecretKey(key)) {
      secrets[key] = sealValue(value, box, onLog);
    } else {
      values[key] = value;
    }
  }
  return { version: SETTINGS_VERSION, updated_at: now.toISOString(), values, secrets };
}

/**
 * 把文档还原成「环境变量表」（secrets 解密）。
 *
 * 解不开的密钥跳过并回调 onProblem：宁可让 sidecar 报「未配置」，也不能把密文当密钥发出去
 * （那会变成一条永远 401 的诡异故障）。
 */
export function documentToEnv(
  document: SettingsDocument,
  box: SecretBox | null,
  onProblem?: (key: string, message: string) => void,
): Record<string, string> {
  const out: Record<string, string> = { ...document.values };
  for (const [key, raw] of Object.entries(document.secrets)) {
    if (raw.startsWith(PLAIN_PREFIX)) {
      out[key] = raw.slice(PLAIN_PREFIX.length);
      continue;
    }
    if (!raw.startsWith(SEALED_PREFIX)) {
      // 老文件或手工编辑过的条目：当成明文，至少不丢配置
      out[key] = raw;
      continue;
    }
    const sealed = raw.slice(SEALED_PREFIX.length);
    if (box === null || !box.available) {
      onProblem?.(key, "当前环境没有可用的加密后端，无法解密");
      continue;
    }
    try {
      out[key] = box.open(sealed);
    } catch (error: unknown) {
      onProblem?.(key, "解密失败：" + describe(error));
    }
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampForName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

/**
 * 设置仓库：内存里持有当前文档，`update` 改内存后原子落盘（写 .tmp 再 rename）。
 *
 * 并发语义：写操作串成一条链，避免两个 IPC 同时写同一个文件互相覆盖；
 * 某次写失败不会污染后续写（链尾 catch 掉再继续）。
 */
export class SettingsStore {
  private readonly file: string;
  private readonly box: SecretBox | null;
  private readonly legacyEnvFile: string;
  private readonly now: () => Date;
  private readonly onLog: SettingsStoreOptions["onLog"];
  private readonly readLegacyEnv: (path: string) => Promise<Record<string, string>>;
  private document: SettingsDocument;
  private env: Record<string, string>;
  private readOnly = false;
  private importedFromEnv = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: SettingsStoreOptions) {
    this.file = options.file;
    this.box = options.box ?? null;
    this.legacyEnvFile = options.legacyEnvFile ?? "";
    this.now = options.now ?? ((): Date => new Date());
    this.onLog = options.onLog;
    this.readLegacyEnv = options.readLegacyEnv ?? readEnvFile;
    this.document = emptyDocument(this.now());
    this.env = {};
  }

  /** 装载：settings.json 优先；不存在才尝试从旧 .env 导入一次；坏文件备份后重建。 */
  static async open(options: SettingsStoreOptions): Promise<SettingsStore> {
    const store = new SettingsStore(options);
    await store.load();
    return store;
  }

  /** 这份设置在磁盘上的位置（界面展示「写入位置」用）。 */
  get path(): string {
    return this.file;
  }

  /** 是否因版本更新而只读（此时 update 会抛 SettingsReadOnlyError）。 */
  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** 本次启动是否从旧 .env 迁移过（用于启动日志说明「.env 以后不再读了」）。 */
  get migratedFromEnv(): boolean {
    return this.importedFromEnv;
  }

  /** 读一个键（已解密）。 */
  get(key: string): string | undefined {
    return this.env[key];
  }

  /** 全量环境表副本（已解密）。 */
  toEnv(): Record<string, string> {
    return { ...this.env };
  }

  /**
   * 应用一批改动并落盘，返回改动后的全量环境表。
   *
   * 语义与老的 applyEnvUpdates 保持一致：null = 这一项不改（界面留空时的默认行为）、
   * "" = 删除 / 清空、其它字符串 = 覆盖。密钥自动进 secrets 分区。
   */
  async update(patch: Readonly<Record<string, string | null>>): Promise<Record<string, string>> {
    if (this.readOnly) {
      throw new SettingsReadOnlyError(
        "设置文件由更新版本的 deskpet 写入，本次不覆盖；请升级程序后再改设置",
      );
    }
    const values = { ...this.document.values };
    const secrets = { ...this.document.secrets };
    let changed = 0;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        continue;
      }
      changed += 1;
      if (value === "") {
        delete values[key];
        delete secrets[key];
        continue;
      }
      if (isSecretKey(key)) {
        delete values[key];
        secrets[key] = sealValue(value, this.box, this.onLog);
      } else {
        delete secrets[key];
        values[key] = value;
      }
    }
    if (changed > 0) {
      this.document = {
        version: SETTINGS_VERSION,
        updated_at: this.now().toISOString(),
        values,
        secrets,
      };
      this.env = this.rebuildEnv();
      await this.flush();
    }
    return this.toEnv();
  }

  private async load(): Promise<void> {
    const text = await this.readText();
    if (text !== null) {
      try {
        const document = parseSettingsDocument(text);
        this.document = document;
        this.readOnly = document.version > SETTINGS_VERSION;
        this.env = this.rebuildEnv();
        if (this.readOnly) {
          this.onLog?.(
            "warn",
            "settings.read_only",
            `设置文件版本 ${document.version} 高于本程序支持的 ${SETTINGS_VERSION}，本次只读`,
          );
        }
        return;
      } catch (error: unknown) {
        const backup = `${this.file}.corrupt-${timestampForName(this.now())}`;
        try {
          await rename(this.file, backup);
        } catch {
          // 备份失败也不拦启动：下面会写一份新的覆盖它
        }
        this.onLog?.(
          "warn",
          "settings.corrupt",
          `设置文件读不动，已备份为 ${backup}，将尝试从旧 .env 重建：` + describe(error),
        );
      }
    }

    const legacy = this.legacyEnvFile === "" ? {} : await this.readLegacyEnv(this.legacyEnvFile);
    if (Object.keys(legacy).length > 0) {
      this.document = documentFromEnv(legacy, this.box, this.now(), this.onLog);
      this.env = this.rebuildEnv();
      this.importedFromEnv = true;
      this.onLog?.(
        "info",
        "settings.imported_from_env",
        `已把旧 .env 的 ${Object.keys(legacy).length} 项配置导入 ${this.file}；以后 .env 不再被读取`,
      );
      try {
        await this.flush();
      } catch (error: unknown) {
        this.onLog?.("warn", "settings.import_failed", "导入后的设置写盘失败：" + describe(error));
      }
      return;
    }

    this.document = emptyDocument(this.now());
    this.env = {};
  }

  private rebuildEnv(): Record<string, string> {
    return documentToEnv(this.document, this.box, (key, message) => {
      this.onLog?.(
        "warn",
        "settings.secret_unreadable",
        `密钥 ${key} ${message}；本次按未配置处理`,
      );
    });
  }

  private async readText(): Promise<string | null> {
    try {
      return await readFile(this.file, "utf8");
    } catch {
      return null;
    }
  }

  /** 原子写：先写同目录 .tmp，再 rename 覆盖。写失败时原文件不受影响。 */
  private async flush(): Promise<void> {
    const snapshot = serializeSettingsDocument(this.document);
    this.writeQueue = this.writeQueue
      .catch(() => {
        // 上一次写失败不该卡住这次
      })
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        await writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(temp, this.file);
      });
    await this.writeQueue;
  }
}
