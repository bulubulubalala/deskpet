/**
 * 文件职责：character-list 的单测——扫描 characters/ 列出可选角色。
 *
 * 为什么容忍坏包：枚举只是为了填角色切换弹出层，坏包该由导入流程报错（M2），
 * 不能让一个半成品目录把整份列表弄空。
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listCharacters } from "../app/main/character-list";

async function makeCharacter(root: string, name: string, card: unknown): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (card !== null) {
    await writeFile(join(dir, "card.json"), JSON.stringify(card), "utf8");
  }
}

describe("listCharacters", () => {
  it("列出完整角色包，跳过坏包与保留目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-chars-"));
    await makeCharacter(root, "snow", { display_name: "小雪" });
    await makeCharacter(root, "amber", { display_name: "琥珀" });
    await makeCharacter(root, "broken", { display_name: "坏包" });
    await writeFile(join(root, "broken", "card.json"), "{ 不是 JSON", "utf8");
    await makeCharacter(root, "no_card", null);
    await makeCharacter(root, "_shared", { display_name: "保留位" });

    expect(await listCharacters(root)).toEqual([
      { char_id: "amber", display_name: "琥珀" },
      { char_id: "snow", display_name: "小雪" },
    ]);
  });

  it("缺少 display_name 的角色包不算可选角色", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-chars-"));
    await makeCharacter(root, "nameless", { name: "nameless" });
    expect(await listCharacters(root)).toEqual([]);
  });

  it("目录不存在等价于没有角色", async () => {
    const root = await mkdtemp(join(tmpdir(), "deskpet-chars-"));
    expect(await listCharacters(join(root, "missing"))).toEqual([]);
  });
});
