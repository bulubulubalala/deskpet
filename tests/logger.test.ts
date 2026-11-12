import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMainLogger,
  fileSize,
  formatLogLine,
  redactFields,
  REDACTED,
  shiftLogs,
} from "../app/main/logger";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deskpet-logger-"));
  dirs.push(dir);
  return dir;
}

/** 日志是异步写盘：断言前给 Node 一点时间把队列冲出去。 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
}

afterEach(async () => {
  await settle();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("formatLogLine", () => {
  it("单行 JSON，含 ts/level/event 与脱敏后的字段", () => {
    const line = formatLogLine(
      {
        level: "INFO",
        logger: "deskpet.main",
        message: "配置已更新",
        event: "ipc.providers_set",
        fields: { api_key: "sk-123", changed: 2 },
      },
      "2026-11-09T03:00:00.000Z",
    );
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["ts"]).toBe("2026-11-09T03:00:00.000Z");
    expect(parsed["level"]).toBe("INFO");
    expect(parsed["event"]).toBe("ipc.providers_set");
    expect(parsed["api_key"]).toBe(REDACTED);
    expect(parsed["changed"]).toBe(2);
  });
});

describe("redactFields", () => {
  it("敏感键换值留名，未列出的键原样", () => {
    expect(redactFields({ token: "abc", port: 8737 })).toEqual({
      token: REDACTED,
      port: 8737,
    });
  });

  it("没有字段时返回空对象（不写 undefined）", () => {
    expect(redactFields(undefined)).toEqual({});
  });
});

describe("fileSize", () => {
  it("文件不存在按 0 算", () => {
    expect(fileSize(join(tempDir(), "missing.log"))).toBe(0);
  });
});

describe("shiftLogs", () => {
  it("按序号后移，超出 keep 的最老一份被删", () => {
    const dir = tempDir();
    const log = join(dir, "deskpet-main.log");
    writeFileSync(log, "new");
    writeFileSync(`${log}.1`, "mid");
    writeFileSync(`${log}.2`, "old");

    shiftLogs(log, 2);

    expect(readdirSync(dir).sort()).toEqual(["deskpet-main.log.1", "deskpet-main.log.2"]);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("new");
    expect(readFileSync(`${log}.2`, "utf8")).toBe("mid");
  });

  it("什么都没有时静默返回，不抛错", () => {
    const log = join(tempDir(), "deskpet-main.log");
    expect(() => shiftLogs(log, 3)).not.toThrow();
  });
});

describe("createMainLogger 滚动", () => {
  it("启动时文件已超标就先滚动再写", async () => {
    const dir = tempDir();
    const log = join(dir, "deskpet-main.log");
    writeFileSync(log, "x".repeat(300));

    const logger = createMainLogger(log, { maxBytes: 200, keep: 3 });
    logger.info("boot", "启动");
    logger.close();
    await settle();

    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(300));
    expect(readFileSync(log, "utf8")).toContain("启动");
  });

  it("运行中跨过上限也会滚动，不让单文件无限长", async () => {
    const dir = tempDir();
    const log = join(dir, "deskpet-main.log");
    const logger = createMainLogger(log, { maxBytes: 200, keep: 3 });
    for (let index = 0; index < 6; index += 1) {
      logger.info("tick", "第 " + index + " 行，故意写长一点好尽快超标 ".repeat(3));
    }
    logger.close();
    await settle();

    // 单行可能比上限还长（不能把一行劈成两半），所以只要求「不会越滚越大」
    expect(readdirSync(dir).length).toBeGreaterThan(1);
    expect(readdirSync(dir).length).toBeLessThanOrEqual(4);
    expect(fileSize(log)).toBeLessThan(600);
  });
});
