/**
 * 文件职责：readCharacterAppearance 的单测（T2.4）——appearance.json → 渲染层要的投影。
 *
 * 为什么单测：这条通道是 Stage 抽象层选实现（PNG / Live2D）的唯一依据，坏值必须退成
 * 安全计划（不能把 undefined / 非法 stage 递给渲染层），所以每个回退分支都要钉住。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readCharacterAppearance } from "../app/main/character-assets";

async function writeAppearance(root: string, charId: string, body: unknown): Promise<void> {
  const dir = join(root, charId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "appearance.json"),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

describe("readCharacterAppearance", () => {
  it("读出投影字段，未知 stage 归为 png，映射表只留字符串", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-app-"));
    await writeAppearance(root, "amber", {
      stage: "weird",
      portrait: "assets/portrait.png",
      model: 42,
      png_fallback: null,
      motions: { idle: "M_idle", bad: 3 },
      expressions: { 喜: "expr_happy.png" },
      acts: { wave: { live2d: "M_wave", png: "bounce" } },
    });

    expect(await readCharacterAppearance(root, "amber")).toEqual({
      stage: "png",
      portrait: "assets/portrait.png",
      model: null,
      png_fallback: null,
      motions: { idle: "M_idle" },
      expressions: { 喜: "expr_happy.png" },
      acts: { wave: { live2d: "M_wave", png: "bounce" } },
    });
  });

  it("live2d / hybrid 如实保留，供工厂决定回退", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-app-"));
    await writeAppearance(root, "l2d", { stage: "live2d", model: "model/foo.model3.json" });
    await writeAppearance(root, "hyb", { stage: "hybrid" });
    expect((await readCharacterAppearance(root, "l2d"))?.stage).toBe("live2d");
    expect((await readCharacterAppearance(root, "hyb"))?.stage).toBe("hybrid");
  });

  it("缺文件 / 坏 JSON / 非法 char_id 都返回 null", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-app-"));
    await writeAppearance(root, "broken", "{ 不是 JSON");
    expect(await readCharacterAppearance(root, "missing")).toBeNull();
    expect(await readCharacterAppearance(root, "broken")).toBeNull();
    expect(await readCharacterAppearance(root, "../escape")).toBeNull();
  });
});
