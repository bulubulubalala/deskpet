/**
 * 文件职责：UiController 的单测——用假窗口验证「状态 → 窗口 → 存档 → 广播」这条链。
 *
 * 为什么用假窗口：控制器只认 PetWindowHandle，所以穿透 / 缩放 / 置顶的语义可以在这里测，
 * 而不必拉起 Electron（真窗口只有打包冒烟才验证）。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CharacterSummary, UiStatePayload } from "../app/main/ipc";
import type { MainLogger } from "../app/main/logger";
import { UiController, type PetWindowHandle } from "../app/main/ui-controller";

interface FakeLogger extends MainLogger {
  readonly warnings: string[];
}

function fakeLogger(): FakeLogger {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (_event, message) => {
      warnings.push(message);
    },
    error: () => undefined,
    close: () => undefined,
  };
}

class FakeWindow implements PetWindowHandle {
  size: { width: number; height: number } | null = null;
  clickThrough: boolean | null = null;
  alwaysOnTop: boolean | null = null;

  setContentSize(width: number, height: number): void {
    this.size = { width, height };
  }

  setClickThrough(enabled: boolean): void {
    this.clickThrough = enabled;
  }

  setAlwaysOnTop(enabled: boolean): void {
    this.alwaysOnTop = enabled;
  }
}

interface Harness {
  readonly controller: UiController;
  readonly window: FakeWindow;
  readonly broadcast: UiStatePayload[];
  readonly stateFile: string;
  readonly logger: FakeLogger;
  readonly opened: string[];
}

async function harness(initial?: string): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "deskpet-ui-ctl-"));
  const stateFile = join(dir, "ui.json");
  if (initial !== undefined) {
    await import("node:fs/promises").then((fs) => fs.writeFile(stateFile, initial, "utf8"));
  }
  const window = new FakeWindow();
  const broadcast: UiStatePayload[] = [];
  const opened: string[] = [];
  const logger = fakeLogger();
  const characters: readonly CharacterSummary[] = [{ char_id: "amber", display_name: "琥珀" }];
  const controller = new UiController({
    stateFile,
    window: () => window,
    broadcast: (state) => {
      broadcast.push(state);
    },
    openSettings: () => {
      opened.push("settings");
    },
    listCharacters: () => Promise.resolve(characters),
    logger,
  });
  return { controller, window, broadcast, stateFile, logger, opened };
}

describe("UiController", () => {
  it("load 读存档，applyToWindow 套用尺寸 / 置顶 / 穿透", async () => {
    const h = await harness(JSON.stringify({ scale: 2, always_on_top: true }));
    const state = await h.controller.load();
    expect(state.scale).toBe(2);
    h.controller.applyToWindow();
    expect(h.window.size).toEqual({ width: 640, height: 896 });
    expect(h.window.alwaysOnTop).toBe(true);
    expect(h.window.clickThrough).toBe(true);
  });

  it("setState 改缩放会立刻改窗口、落盘并广播", async () => {
    const h = await harness();
    await h.controller.load();
    const next = await h.controller.setState({ scale: 1.5, always_on_top: true });
    expect(next.scale).toBe(1.5);
    expect(h.window.size).toEqual({ width: 480, height: 686 });
    expect(h.window.alwaysOnTop).toBe(true);
    expect(h.broadcast).toHaveLength(1);
    const raw = JSON.parse(await readFile(h.stateFile, "utf8")) as UiStatePayload;
    expect(raw.scale).toBe(1.5);
  });

  it("指针进入命中区时临时关掉穿透，离开后恢复", async () => {
    const h = await harness();
    await h.controller.load();
    h.controller.applyToWindow();
    expect(h.window.clickThrough).toBe(true);
    h.controller.setPointerInside(true);
    expect(h.window.clickThrough).toBe(false);
    h.controller.setPointerInside(false);
    expect(h.window.clickThrough).toBe(true);
  });

  it("关掉穿透开关后窗口始终可点", async () => {
    const h = await harness();
    await h.controller.load();
    await h.controller.setState({ click_through: false });
    expect(h.window.clickThrough).toBe(false);
    h.controller.setPointerInside(true);
    h.controller.setPointerInside(false);
    expect(h.window.clickThrough).toBe(false);
  });

  it("noteMoved 记住位置且不广播", async () => {
    const h = await harness();
    await h.controller.load();
    h.controller.noteMoved(120, 240);
    h.controller.noteMoved(120, 240);
    // 拖动回写是异步串行的，测试必须等落盘队列排空后再读文件
    await h.controller.flush();
    expect(h.controller.getState().x).toBe(120);
    expect(h.broadcast).toHaveLength(0);
    const raw = JSON.parse(await readFile(h.stateFile, "utf8")) as UiStatePayload;
    expect(raw.y).toBe(240);
  });

  it("写盘失败只记日志，不抛给调用方", async () => {
    const h = await harness();
    await h.controller.load();
    // 把状态文件换成一个「父路径是文件」的非法路径，逼 writeUiState 抛错
    const badFile = join(h.stateFile, "nested", "ui.json");
    const broken = new UiController({
      stateFile: badFile,
      window: () => h.window,
      broadcast: () => undefined,
      openSettings: () => undefined,
      listCharacters: () => Promise.resolve([]),
      logger: h.logger,
    });
    await expect(broken.setState({ scale: 1.2 })).resolves.toBeDefined();
  });

  it("characters 透传角色列表，openSettings 只转发一次", async () => {
    const h = await harness();
    await h.controller.load();
    expect(await h.controller.characters()).toEqual([{ char_id: "amber", display_name: "琥珀" }]);
    h.controller.openSettings();
    expect(h.opened).toEqual(["settings"]);
  });
});
