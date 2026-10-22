/**
 * 文件职责：单测 app/main/pack-editor.ts —— 自建角色包的校验与落盘（T2.3-D）。
 *
 * 为什么值得单测：写进 characters/ 的东西会被 character_store 读回来当角色用，`char_id` 同时是
 * 目录名（写歪了要么生成非法角色、要么覆盖别人的包），图片与字段的夹取规则也必须钉死；
 * 这个模块刻意不 import electron，所以能在 vitest 里直接跑。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PackRegionDraft, PackSaveRequest } from "../app/main/ipc";
import {
  buildPackFiles,
  decodeImageDataUrl,
  imageExtension,
  loadCharacterPack,
  normalizeRegions,
  readImageAsDataUrl,
  saveCharacterPack,
  saveCharacterCard,
  saveCharacterRegions,
  validatePackId,
} from "../app/main/pack-editor";

/** 1×1 的合法 PNG（只用来过文件头校验，内容无所谓）。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = "data:image/png;base64," + PNG_BASE64;

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deskpet-pack-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function region(partial: Partial<PackRegionDraft> = {}): PackRegionDraft {
  return {
    id: "",
    name: "head",
    rect: [0.1, 0.1, 0.2, 0.2],
    color: "#ff6b6b",
    act: "",
    ...partial,
  };
}

function request(partial: Partial<PackSaveRequest> = {}): PackSaveRequest {
  return {
    char_id: "yukari",
    display_name: "紫",
    description: "测试角色",
    personality: "冷淡",
    speaking_style: "短句",
    portrait_data_url: PNG_DATA_URL,
    regions: [region()],
    ...partial,
  };
}

describe("validatePackId", () => {
  it("合法目录名放行（字母开头，允许数字 / 下划线 / 短横）", () => {
    for (const id of ["amber", "snow2", "momo_2", "a-b", "A".repeat(64)]) {
      expect(validatePackId(id)).toBeNull();
    }
  });

  it("空、中文、下划线或点开头、太长、带空格都拒绝", () => {
    for (const id of ["", "   ", "琥珀", "_amber", ".amber", "a".repeat(65), "a b", "a/b"]) {
      expect(validatePackId(id)).not.toBeNull();
    }
  });
});

describe("imageExtension", () => {
  it("jpeg / webp 用真实扩展名，其余回退 png", () => {
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/webp")).toBe("webp");
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/gif")).toBe("png");
  });
});

describe("decodeImageDataUrl", () => {
  it("合法 PNG 解出字节", () => {
    const image = decodeImageDataUrl(PNG_DATA_URL);
    expect(image?.mime).toBe("image/png");
    expect(image?.data.byteLength).toBeGreaterThan(0);
  });

  it("data URL 形状不对、mime 不认、文件头对不上都回 null", () => {
    expect(decodeImageDataUrl("")).toBeNull();
    expect(decodeImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(decodeImageDataUrl("data:text/plain;base64," + PNG_BASE64)).toBeNull();
    // mime 说是 png，字节却是 jpeg：骗人的扩展名不能进角色包
    expect(decodeImageDataUrl("data:image/png;base64,/9j/4AAQSkZJRg==")).toBeNull();
    // RIFF 开头但不是 WEBP（比如 wav）也要挡掉
    const fakeWebp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WAVE"),
    ]);
    expect(decodeImageDataUrl("data:image/webp;base64," + fakeWebp.toString("base64"))).toBeNull();
  });
});

describe("normalizeRegions", () => {
  it("矩形夹到 0–1、空名字补「部位 N」、非法颜色回退", () => {
    const result = normalizeRegions([
      region({ name: "   ", rect: [-0.5, 0.9, 2, 2], color: "red" }),
      region({ name: "手", rect: [0.4, 0.4, 0.001, 0.001], color: "#00ff00" }),
    ]);
    expect(result[0]?.name).toBe("部位 1");
    expect(result[0]?.color).toBe("#ffb347");
    const first = result[0]?.rect ?? [0, 0, 0, 0];
    expect(first[0]).toBe(0);
    expect(first[1]).toBeLessThanOrEqual(1);
    expect(first[2]).toBeLessThanOrEqual(1);
    // 太小的框被抬到最小边长，且不越出右 / 下边界
    const second = result[1]?.rect ?? [0, 0, 0, 0];
    expect(second[2]).toBeGreaterThanOrEqual(0.02);
    expect(second[2]).toBeLessThanOrEqual(1 - second[0]);
  });

  it("同一个名字重复时 id 自动加后缀（dir 里不能有两份同名 hits 条目）", () => {
    const result = normalizeRegions([region(), region(), region()]);
    expect(result.map((item) => item.id)).toEqual(["head", "head-2", "head-3"]);
  });

  it("默认的「身体」框 id 固定是 body（char_hits 里要看得懂）", () => {
    const result = normalizeRegions([region({ name: "身体" }), region({ name: "身体" })]);
    expect(result.map((item) => item.id)).toEqual(["body", "body-2"]);
  });

  it("中文名没有 ascii 部分就退成 regionN，而不是空 id", () => {
    const result = normalizeRegions([region({ name: "头" })]);
    expect(result[0]?.id).toBe("region1");
    expect(result[0]?.name).toBe("头");
  });
});

describe("buildPackFiles", () => {
  it("生成四份 JSON：card 兜底、appearance 的 acts 由部位去重、hits 用归一化后的框", () => {
    const built = buildPackFiles(
      request({
        display_name: "  ",
        personality: "  ",
        regions: [
          region({ name: "head", act: "blush" }),
          region({ name: "hand", act: "blush", rect: [0.5, 0.5, 0.2, 0.2] }),
          region({ name: "leg", act: "" }),
        ],
      }),
      "image/png",
    );
    expect(built.portraitName).toBe("assets/portrait.png");
    expect(built.files.map((file) => file.name)).toEqual([
      "card.json",
      "pack.json",
      "appearance.json",
      "hits.json",
    ]);
    const card = JSON.parse(built.files[0]?.content ?? "{}") as Record<string, unknown>;
    expect(card["display_name"]).toBe("yukari");
    expect(card["name"]).toBe("yukari");
    expect(card["personality"]).toBeTruthy();
    expect(card["speaking_style"]).toBeTruthy();
    const pack = JSON.parse(built.files[1]?.content ?? "{}") as Record<string, unknown>;
    expect(pack["char_id"]).toBe("yukari");
    const appearance = JSON.parse(built.files[2]?.content ?? "{}") as Record<string, unknown>;
    expect(appearance["portrait"]).toBe("assets/portrait.png");
    expect(appearance["stage"]).toBe("png");
    expect(Object.keys(appearance["acts"] as Record<string, unknown>)).toEqual(["blush"]);
    const hits = JSON.parse(built.files[3]?.content ?? "{}") as {
      version?: number;
      regions?: { id?: string; act?: string }[];
    };
    expect(hits.version).toBe(2);
    expect(hits.regions?.map((item) => item.id)).toEqual(["head", "hand", "leg"]);
  });

  it("jpeg 素材写成 assets/portrait.jpg（别把 jpg 写成 .png）", () => {
    expect(buildPackFiles(request(), "image/jpeg").portraitName).toBe("assets/portrait.jpg");
  });
});

describe("readImageAsDataUrl", () => {
  it("读得回来就带 mime 前缀，按扩展名判类型", async () => {
    const dir = await tempDir();
    const png = join(dir, "portrait.png");
    await writeFile(png, Buffer.from(PNG_BASE64, "base64"));
    expect(await readImageAsDataUrl(png)).toBe(PNG_DATA_URL);
    const jpg = join(dir, "portrait.jpg");
    await writeFile(jpg, Buffer.from(PNG_BASE64, "base64"));
    expect((await readImageAsDataUrl(jpg)).startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("空文件直接报错（空图进不了角色包）", async () => {
    const dir = await tempDir();
    const empty = join(dir, "empty.png");
    await writeFile(empty, "");
    await expect(readImageAsDataUrl(empty)).rejects.toThrow();
  });
});

describe("saveCharacterPack", () => {
  it("落盘 assets/portrait.png 与四份 JSON，并回报文件清单", async () => {
    const dir = await tempDir();
    const result = await saveCharacterPack(dir, request());
    expect(result.ok).toBe(true);
    expect(result.error).toBe("");
    expect(result.files).toEqual([
      "assets/portrait.png",
      "card.json",
      "pack.json",
      "appearance.json",
      "hits.json",
    ]);
    const root = join(dir, "yukari");
    expect((await readdir(root)).sort()).toEqual([
      "appearance.json",
      "assets",
      "card.json",
      "hits.json",
      "pack.json",
    ]);
    expect(await readdir(join(root, "assets"))).toEqual(["portrait.png"]);
    const hits = JSON.parse(await readFile(join(root, "hits.json"), "utf8")) as {
      regions?: { id?: string }[];
    };
    expect(hits.regions?.[0]?.id).toBe("head");
  });

  it("目录已存在时拒绝覆盖（不碰别人的角色包）", async () => {
    const dir = await tempDir();
    await saveCharacterPack(dir, request());
    const again = await saveCharacterPack(dir, request({ display_name: "改过的名字" }));
    expect(again.ok).toBe(false);
    expect(again.error).toContain("已经存在");
    const card = JSON.parse(await readFile(join(dir, "yukari", "card.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(card["display_name"]).toBe("紫");
  });

  it("非法 char_id / 非法图片都在写盘前就失败", async () => {
    const dir = await tempDir();
    const badId = await saveCharacterPack(dir, request({ char_id: "_amber" }));
    expect(badId.ok).toBe(false);
    const badImage = await saveCharacterPack(dir, request({ portrait_data_url: "nope" }));
    expect(badImage.ok).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("loadCharacterPack / saveCharacterRegions（T2.5 编辑当前角色部位）", () => {
  async function makePack(): Promise<{ dir: string; root: string }> {
    const dir = await tempDir();
    const created = await saveCharacterPack(
      dir,
      request({
        regions: [
          region({
            id: "",
            name: "head",
            rect: [0.1, 0.1, 0.3, 0.2],
            color: "#ff6b6b",
            act: "blush",
          }),
          region({
            id: "",
            name: "hand",
            rect: [0.5, 0.5, 0.2, 0.2],
            color: "#4ecdc4",
            act: "wave",
          }),
        ],
      }),
    );
    expect(created.ok).toBe(true);
    return { dir, root: join(dir, "yukari") };
  }

  it("读取现有包：展示字段 + 立绘 data URL + 部位（id 保留）", async () => {
    const { dir } = await makePack();
    const loaded = await loadCharacterPack(dir, "yukari");
    expect(loaded.ok).toBe(true);
    expect(loaded.char_id).toBe("yukari");
    expect(loaded.display_name).toBe("紫");
    expect(loaded.description).toBe("测试角色");
    expect(loaded.portrait_data_url?.startsWith("data:image/png;base64,")).toBe(true);
    expect(loaded.regions.map((item) => item.id)).toEqual(["head", "hand"]);
    expect(loaded.regions[1]?.act).toBe("wave");
  });

  it("只写 hits.json：id 保留、其它文件一个字节都不动、无 .tmp 残留", async () => {
    const { dir, root } = await makePack();
    const cardBefore = await readFile(join(root, "card.json"), "utf8");
    const voicePath = join(root, "voice.json");
    await writeFile(voicePath, '{"engine":"indextts"}\n', "utf8");
    const voiceBefore = await readFile(voicePath, "utf8");

    const loaded = await loadCharacterPack(dir, "yukari");
    const regions = loaded.regions.map((item) => {
      const [x = 0, y = 0, w = 0, h = 0] = item.rect;
      return { ...item, rect: [x, y + 0.1, w, h] as [number, number, number, number] };
    });
    const result = await saveCharacterRegions(dir, { char_id: "yukari", regions });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["hits.json"]);
    const hits = JSON.parse(await readFile(join(root, "hits.json"), "utf8")) as {
      version?: number;
      regions?: { id?: string; rect?: number[] }[];
    };
    expect(hits.version).toBe(2);
    expect(hits.regions?.map((item) => item.id)).toEqual(["head", "hand"]);
    expect(hits.regions?.[0]?.rect?.[1]).toBeCloseTo(0.2, 4);
    expect(await readFile(join(root, "card.json"), "utf8")).toBe(cardBefore);
    expect(await readFile(voicePath, "utf8")).toBe(voiceBefore);
    expect(await readdir(root)).not.toContain("hits.json.tmp");
  });

  it("改名不换 id；新框才按名字派生 id", async () => {
    const { dir, root } = await makePack();
    const loaded = await loadCharacterPack(dir, "yukari");
    const regions = loaded.regions.map((item, index) =>
      index === 0 ? { ...item, name: "脑袋" } : item,
    );
    regions.push({
      id: "",
      name: "tail",
      rect: [0.1, 0.7, 0.2, 0.2],
      color: "#ffb347",
      act: "",
    });
    const result = await saveCharacterRegions(dir, { char_id: "yukari", regions });
    expect(result.ok).toBe(true);
    const hits = JSON.parse(await readFile(join(root, "hits.json"), "utf8")) as {
      regions?: { id?: string; name?: string }[];
    };
    expect(hits.regions?.[0]?.id).toBe("head");
    expect(hits.regions?.[0]?.name).toBe("脑袋");
    expect(hits.regions?.[2]?.id).toBe("tail");
  });

  it("目录不存在 / 坏 id 都拒绝，且不留下文件", async () => {
    const dir = await tempDir();
    const missing = await saveCharacterRegions(dir, { char_id: "nope", regions: [] });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("找不到角色包");
    const badId = await loadCharacterPack(dir, "../escape");
    expect(badId.ok).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it("角色卡只改 card / pack，立绘与 hits 逐字节不变（T2.7）", async () => {
    const { dir, root } = await makePack();
    const beforeHits = await readFile(join(root, "hits.json"), "utf8");
    const beforePortrait = await readFile(join(root, "assets", "portrait.png"));
    const result = await saveCharacterCard(dir, {
      char_id: "yukari",
      display_name: "紫大人",
      description: "改过的简介",
      personality: "改过的人格",
      speaking_style: "改过的说话风格",
    });
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["card.json", "pack.json"]);
    const card = JSON.parse(await readFile(join(root, "card.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(card["display_name"]).toBe("紫大人");
    expect(card["description"]).toBe("改过的简介");
    expect(card["personality"]).toBe("改过的人格");
    expect(card["speaking_style"]).toBe("改过的说话风格");
    const pack = JSON.parse(await readFile(join(root, "pack.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pack["display_name"]).toBe("紫大人");
    expect(await readFile(join(root, "hits.json"), "utf8")).toBe(beforeHits);
    expect(await readFile(join(root, "assets", "portrait.png"))).toEqual(beforePortrait);
    expect(await readdir(root)).not.toContain("card.json.tmp");
    expect(await readdir(root)).not.toContain("pack.json.tmp");
  });

  it("立绘缺失时仍能读卡片（卡模式不依赖立绘，T2.7）", async () => {
    const { dir, root } = await makePack();
    await rm(join(root, "assets", "portrait.png"));
    const loaded = await loadCharacterPack(dir, "yukari");
    expect(loaded.ok).toBe(true);
    expect(loaded.portrait_data_url).toBeNull();
    expect(loaded.display_name).toBe("紫");
  });

  it("角色卡空人格保留原文；目录不存在拒绝", async () => {
    const { dir, root } = await makePack();
    const before = JSON.parse(await readFile(join(root, "card.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const result = await saveCharacterCard(dir, {
      char_id: "yukari",
      display_name: "紫",
      description: "",
      personality: "",
      speaking_style: "",
    });
    expect(result.ok).toBe(true);
    const after = JSON.parse(await readFile(join(root, "card.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(after["personality"]).toBe(before["personality"]);
    expect(after["speaking_style"]).toBe(before["speaking_style"]);
    expect(after["description"]).toBe("");
    const missing = await saveCharacterCard(dir, {
      char_id: "nope",
      display_name: "x",
      description: "",
      personality: "",
      speaking_style: "",
    });
    expect(missing.ok).toBe(false);
  });
});
