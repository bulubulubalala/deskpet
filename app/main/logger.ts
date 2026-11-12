/**
 * 文件职责：主进程的结构化日志（单行 JSON，字段 schema 与 sidecar 一致，CODE_STYLE §6.1）。
 *
 * 为什么不能与 sidecar 共用一个文件：两个进程各持写句柄，行会互相打断；
 * 于是主进程写 data/logs/deskpet-main.log，sidecar 写 data/logs/deskpet.log（T0.4 已落地）。
 * 依赖方向：main -> node（fs/path）；不 import electron，便于单测。
 * 谁调用：app/main/index.ts 装配时创建一个实例，engine 与 ipc 处理器共用。
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * 滚动策略（D9）：单文件 5 MiB、留 5 份，最老的一份被覆盖。
 *
 * 为什么不写 20 份：桌宠常驻后台，日志按天涨；留太多只会让「打开日志目录」变成考古。
 * 5×5 MiB 足够覆盖最近若干天的崩溃现场，而且复制诊断信息只读最后 40 行，不需要更长的历史。
 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 5;

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

/** 取文件大小；读不到（还没创建、被占用）按 0 处理，不抛错。 */
export function fileSize(logFile: string): number {
  try {
    return statSync(logFile).size;
  } catch {
    return 0;
  }
}

/**
 * 滚动一次：logFile → logFile.1，.1 → .2 …… 最老的 .keep 直接删。
 *
 * 任何一步失败都只跳过：滚动是「顺手清理」，不该因为 Windows 上文件被别的进程打开
 * （杀软、记事本）就把日志写不进去。
 */
export function shiftLogs(logFile: string, keep: number = LOG_KEEP): void {
  try {
    unlinkSync(`${logFile}.${keep}`);
  } catch {
    // 本来就没有最老的一份
  }
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${logFile}.${index}`, `${logFile}.${index + 1}`);
    } catch {
      // 缺号（上一次重启没写满）跳过
    }
  }
  try {
    renameSync(logFile, `${logFile}.1`);
  } catch {
    // 还没写过日志
  }
}

/**
 * 打开日志文件的追加句柄；拿不到就降级 stderr（CODE_STYLE §6.3 的写失败兜底）。
 *
 * 为什么是同步写（openSync + writeSync）而不是 WriteStream：
 * 滚动要求在「写满」的瞬间换文件，而流的写盘时机不可控——rename 时目标文件可能还没被创建，
 * 缓冲里的行也可能落到新文件里。一天几十行日志，同步写的代价可以忽略，换来的是可预测的落盘顺序。
 */
function openFd(logFile: string): number | null {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    return openSync(logFile, "a");
  } catch (error) {
    process.stderr.write("deskpet 主进程日志打开失败：" + String(error) + "\n");
    return null;
  }
}

export interface LoggerOptions {
  /** 单文件上限，测试里调小用来验证滚动。 */
  readonly maxBytes?: number;
  readonly keep?: number;
}

export function createMainLogger(logFile: string, options: LoggerOptions = {}): MainLogger {
  const loggerName = "deskpet.main";
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const keep = options.keep ?? LOG_KEEP;
  // 上次退出时可能已经写满：先滚动，免得这次启动继续往一个超大文件里追加
  if (fileSize(logFile) >= maxBytes) {
    shiftLogs(logFile, keep);
  }
  let fd: number | null = openFd(logFile);
  let writtenBytes = fileSize(logFile);
  // 写失败只在第一次喊一声：磁盘满/被杀软锁住时，每行都往 stderr 吼一遍反而把控制台刷爆
  let warned = false;

  const write = (level: LogLevel, event: string, message: string, fields?: LogFields): void => {
    const base = { level, logger: loggerName, message, event };
    const record: LogRecord = fields === undefined ? base : { ...base, fields };
    const line = formatLogLine(record, new Date().toISOString()) + "\n";
    const bytes = Buffer.byteLength(line);
    // 先看「写下去会不会超」，超了先滚：滚的是旧文件，这一行自然落到新文件
    if (fd !== null && writtenBytes > 0 && writtenBytes + bytes > maxBytes) {
      closeSync(fd);
      shiftLogs(logFile, keep);
      writtenBytes = 0;
      fd = openFd(logFile);
    }
    if (fd === null) {
      process.stderr.write(line);
      return;
    }
    try {
      writeSync(fd, line);
      writtenBytes += bytes;
    } catch (error) {
      if (!warned) {
        warned = true;
        process.stderr.write("deskpet 主进程日志写入失败：" + String(error) + "\n");
      }
      process.stderr.write(line);
    }
  };

  return {
    debug: (event, message, fields) => write("DEBUG", event, message, fields),
    info: (event, message, fields) => write("INFO", event, message, fields),
    warn: (event, message, fields) => write("WARN", event, message, fields),
    error: (event, message, fields) => write("ERROR", event, message, fields),
    close: () => {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
    },
  };
}
