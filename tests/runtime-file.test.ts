/**
 * 文件职责：runtime.json 解析与端口握手的单测（合法/损坏/缺失/超时/进程探活）。
 *
 * 为什么坏文件用例要检查 token 不外泄：错误信息会进日志与界面，令牌不能跟着跑出去（CODE_STYLE §6.2）。
 * 依赖方向：tests -> app/main/runtime-file.ts + node 临时目录。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isProcessAlive,
  parseRuntime,
  readRuntime,
  RuntimeFileError,
  waitForRuntime,
} from "../app/main/runtime-file";

const VALID = {
  pid: 1234,
  host: "127.0.0.1",
  port: 8737,
  token: "unit-test-token",
  started_at: "2026-01-01T00:00:00Z",
  version: "0.1.0",
};

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "deskpet-runtime-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runtime.json", () => {
  it("解析合法内容", () => {
    expect(parseRuntime(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("坏 JSON 抛 RuntimeFileError", () => {
    expect(() => parseRuntime("{")).toThrow(RuntimeFileError);
    expect(() => parseRuntime("[]")).toThrow(RuntimeFileError);
  });

  it("字段缺失时报出坏字段名，但绝不回显 token", () => {
    const broken = JSON.stringify({ ...VALID, port: "不是数字", token: "secret-value" });
    try {
      parseRuntime(broken);
      throw new Error("本该抛错");
    } catch (error) {
      const text = String(error);
      expect(text).toContain("port");
      expect(text).not.toContain("secret-value");
    }
  });

  it("文件缺失或内容损坏时 readRuntime 返回 null", async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, "runtime.json");
      expect(await readRuntime(missing)).toBeNull();
      await writeFile(missing, "not json at all", "utf8");
      expect(await readRuntime(missing)).toBeNull();
      await writeFile(missing, JSON.stringify(VALID), "utf8");
      expect(await readRuntime(missing)).toEqual(VALID);
    });
  });

  it("waitForRuntime 用注入的时钟与休眠轮询，超时报错、等到就返回", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "runtime.json");
      let now = 0;
      await expect(
        waitForRuntime(path, {
          timeoutMs: 300,
          intervalMs: 100,
          now: () => now,
          sleep: (ms: number) => {
            now += ms;
            return Promise.resolve();
          },
        }),
      ).rejects.toThrow(RuntimeFileError);

      // 第三跳才写出文件：验证它确实在等，而不是一读不到就放弃
      now = 0;
      const pending = waitForRuntime(path, {
        timeoutMs: 1000,
        intervalMs: 100,
        now: () => now,
        sleep: async (ms: number) => {
          if (now >= 100) {
            await writeFile(path, JSON.stringify(VALID), "utf8");
          }
          now += ms;
        },
      });
      await expect(pending).resolves.toEqual(VALID);
    });
  });

  it("isProcessAlive：自己活着，非法 pid 一律算死", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
