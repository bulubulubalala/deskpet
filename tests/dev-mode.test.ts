/**
 * 文件职责：单测 app/main/dev-mode.ts —— 开发者模式开关的落盘（T2.3-B1）。
 *
 * 为什么值得单测：坏掉的 dev.json 不该把设置窗永远锁在（或永远关在）开发者模式里，
 * 「读失败当没开」「写是原子的」这两条必须在测试里钉住；同时它不 import electron、不碰真 data 目录。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEV_MODE_FILENAME, parseDevMode, readDevMode, writeDevMode } from "../app/main/dev-mode";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deskpet-dev-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseDevMode", () => {
  it("文件名固定是 data/dev.json 里那一份", () => {
    expect(DEV_MODE_FILENAME).toBe("dev.json");
  });

  it("只有 enabled === true 才算开，别的写法都当没开", () => {
    expect(parseDevMode({ enabled: true })).toEqual({ enabled: true });
    for (const value of [{ enabled: "true" }, { enabled: 1 }, { enabled: null }, {}]) {
      expect(parseDevMode(value)).toEqual({ enabled: false });
    }
  });

  it("不是对象的值（null / 数组 / 字符串）都当没开", () => {
    for (const value of [null, undefined, [], "true", 3]) {
      expect(parseDevMode(value)).toEqual({ enabled: false });
    }
  });
});

describe("readDevMode / writeDevMode", () => {
  it("文件不存在时返回关闭，而不是抛错", async () => {
    const dir = await tempDir();
    expect(await readDevMode(join(dir, DEV_MODE_FILENAME))).toEqual({ enabled: false });
  });

  it("坏 JSON 也返回关闭（不让界面卡在开发者模式）", async () => {
    const dir = await tempDir();
    const file = join(dir, DEV_MODE_FILENAME);
    await writeFile(file, "{ 不是 JSON", "utf8");
    expect(await readDevMode(file)).toEqual({ enabled: false });
  });

  it("写出去的能读回来，且不留 .tmp", async () => {
    const dir = await tempDir();
    const file = join(dir, DEV_MODE_FILENAME);
    await writeDevMode(file, { enabled: true });
    expect(await readDevMode(file)).toEqual({ enabled: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ enabled: true });
    await writeDevMode(file, { enabled: false });
    expect(await readDevMode(file)).toEqual({ enabled: false });
    expect(await readdir(dir)).toEqual([DEV_MODE_FILENAME]);
  });

  it("目录不存在时会先建出来（首次进入开发者模式）", async () => {
    const dir = await tempDir();
    const file = join(dir, "nested", DEV_MODE_FILENAME);
    await writeDevMode(file, { enabled: true });
    expect(await readDevMode(file)).toEqual({ enabled: true });
  });
});
