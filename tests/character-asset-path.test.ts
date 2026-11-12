import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCharacterAssetPath } from "../app/main/character-asset-path";

describe("character asset protocol path", () => {
  // 用当前平台的绝对路径：写死 D:\ 的用例在 Linux CI 上必然失败（M1 门禁要两边都能跑）。
  const root = join(process.cwd(), "characters");

  it("resolves model files inside one character pack", () => {
    expect(
      resolveCharacterAssetPath(root, "deskpet-asset://character/snow/model/model.model3.json"),
    ).toMatchObject({
      charId: "snow",
      relative: "model/model.model3.json",
      filePath: join(root, "snow", "model", "model.model3.json"),
      mime: "application/json; charset=utf-8",
    });
  });

  it("maps textures to image mime types", () => {
    expect(
      resolveCharacterAssetPath(
        root,
        "deskpet-asset://character/snow/model/model.4096/texture_00.png",
      )?.mime,
    ).toBe("image/png");
  });

  it("rejects traversal, absolute paths and bad hosts", () => {
    expect(resolveCharacterAssetPath(root, "deskpet-asset://character/snow/../../.env")).toBeNull();
    expect(
      resolveCharacterAssetPath(root, "deskpet-asset://evil/snow/model/model.moc3"),
    ).toBeNull();
    expect(resolveCharacterAssetPath(root, "deskpet-asset://character/../secret")).toBeNull();
    expect(resolveCharacterAssetPath(root, "https://character/snow/x")).toBeNull();
  });

  it("rejects encoded traversal and malformed urls", () => {
    expect(
      resolveCharacterAssetPath(root, "deskpet-asset://character/snow/%2e%2e/%2e%2e/.env"),
    ).toBeNull();
    expect(resolveCharacterAssetPath(root, "not a url")).toBeNull();
  });
});
