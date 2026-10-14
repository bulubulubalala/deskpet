/**
 * 文件职责：主进程的结构化日志（单行 JSON，字段 schema 与 sidecar 一致，CODE_STYLE §6.1）。
 *
 * 为什么不能与 sidecar 共用一个文件：两个进程各持写句柄，行会互相打断；
 * 于是主进程写 data/logs/deskpet-main.log，sidecar 写 data/logs/deskpet.log（T0.4 已落地）。
 * 依赖方向：main -> node（fs/path）；不 import electron，便于单测。
 * 谁调用：app/main/index.ts 装配时创建一个实例，engine 与 ipc 处理器共用。
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** 业务字段：值只写短标量；提示词、记忆正文、OCR 原文这类长文本不要进日志（CODE_STYLE §6.2）。 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * 敏感键名单，与 sidecar/core/logging.py 的 SENSITIVE_KEYS 同源（CODE_STYLE §6.2）。
 * 两边各存一份是刻意的：主进程不该为了打日志去启动 Python 解释器。
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "api_key",
  "apikey",
  "authorization",
  "token",
  "password",
  "prompt",
  "messages",
  "conversation",
  "memory_text",
  "memory_body",
  "ocr_text",
  "screen_text",
  "ref_audio_path",
  "reference_audio",
]);

/** 脱敏占位值，与 sidecar 侧完全一致，方便一条 grep 同时查两边。 */
export const REDACTED = "[已脱敏]";

export interface MainLogger {
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
  close(): void;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly logger: string;
  readonly message: string;
  readonly event: string;
  readonly fields?: LogFields;
}

/** 敏感字段的值换成 [已脱敏]，键名保留——排查时能看出「字段到底有没有传」。 */
export function redactFields(fields?: LogFields): Record<string, unknown> {
  if (fields === undefined) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SENSITIVE_KEYS.has(key) ? REDACTED : value;
  }
  return out;
}

/** 拼一行日志；ts 由调用方传入，测试里可以固定时间戳。 */
export function formatLogLine(record: LogRecord, ts: string): string {
  return JSON.stringify({
    ts,
    level: record.level,
    logger: record.logger,
    message: record.message,
    module: record.logger,
    event: record.event,
    ...redactFields(record.fields),
  });
}

/** 打开日志文件；拿不到文件不抛错，降级到 stderr（CODE_STYLE §6.3 的写失败兜底）。 */
function openStream(logFile: string): WriteStream | null {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const stream = createWriteStream(logFile, { flags: "a", encoding: "utf8" });
    stream.on("error", (error: unknown) => {
      // 写日志失败绝不让业务带崩：降到 stderr，照样留下痕迹
      process.stderr.write("deskpet 主进程日志写入失败：" + String(error) + "\n");
    });
    return stream;
  } catch (error) {
    process.stderr.write("deskpet 主进程日志打开失败：" + String(error) + "\n");
    return null;
  }
}

export function createMainLogger(logFile: string): MainLogger {
  const loggerName = "deskpet.main";
  let stream: WriteStream | null = openStream(logFile);

  const write = (level: LogLevel, event: string, message: string, fields?: LogFields): void => {
    const base = { level, logger: loggerName, message, event };
    const record: LogRecord = fields === undefined ? base : { ...base, fields };
    const line = formatLogLine(record, new Date().toISOString()) + "\n";
    if (stream === null) {
      process.stderr.write(line);
      return;
    }
    stream.write(line);
  };

  return {
    debug: (event, message, fields) => write("DEBUG", event, message, fields),
    info: (event, message, fields) => write("INFO", event, message, fields),
    warn: (event, message, fields) => write("WARN", event, message, fields),
    error: (event, message, fields) => write("ERROR", event, message, fields),
    close: () => {
      stream?.end();
      stream = null;
    },
  };
}
