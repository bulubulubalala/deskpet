/**
 * 文件职责：UiController 的单测——用假窗口验证「状态 → 窗口 → 存档 → 广播」这条链。
 *
 * 为什么用假窗口：控制器只认 PetWindowHandle，所以穿透 / 缩放 / 置顶的语义可以在这里测，
 * 而不必拉起 Electron（真窗口只有打包冒烟才验证）。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CharacterSummary, UiStatePayload } from "../app/main/ipc";
import type { MainLogger } from "../app/main/logger";
import {
  DRAG_POLL_MS,
  UiController,
  type PetWindowHandle,
  type WorkArea,
} from "../app/main/ui-controller";

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
  /** setContentSize 的调用次数：渲染层每换一行都会上报，重复套用要能查出来。 */
  sizeCalls = 0;

  /** 窗口当前左上角（拖动改的就是它）与最后一次被问到的外框。 */
  position = { x: 0, y: 0 };
  bounds = { x: 0, y: 0, width: 400, height: 500 };
  /** setPosition 的调用序列：拖动时位置由主进程按系统光标算（T2.2 用户反馈第五轮）。 */
  readonly placements: { x: number; y: number }[] = [];

  setContentSize(width: number, height: number): void {
    this.size = { width, height };
    this.sizeCalls += 1;
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds;
  }

  setPosition(x: number, y: number): void {
    this.position = { x, y };
    this.placements.push({ x, y });
  }

  setClickThrough(enabled: boolean): void {
    this.clickThrough = enabled;
  }

  setAlwaysOnTop(enabled: boolean): void {
    this.alwaysOnTop = enabled;
  }

  /** hide() 的调用次数：最小化到托盘只该隐藏窗口，不能销毁它（T2.3-C2c）。 */
  hideCalls = 0;

  hide(): void {
    this.hideCalls += 1;
  }
}

interface Harness {
  readonly controller: UiController;
  readonly window: FakeWindow;
  readonly broadcast: UiStatePayload[];
  readonly stateFile: string;
  readonly logger: FakeLogger;
  readonly opened: string[];
  /** 测试可以把它设成 null 模拟「拿不到显示器工作区」。 */
  readonly area: { current: WorkArea | null };
  /** 测试可以改它模拟系统光标；null 表示读不到光标（拖动应被整体忽略）。 */
  readonly cursor: { current: { x: number; y: number } | null };
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
  const area: { current: WorkArea | null } = {
    current: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  const cursor = { current: { x: 0, y: 0 } as { x: number; y: number } | null };
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
    workArea: () => area.current,
    cursor: () => cursor.current,
  });
  return { controller, window, broadcast, stateFile, logger, opened, area, cursor };
}

describe("UiController", () => {
  it("load 读存档，applyToWindow 套用尺寸 / 置顶 / 穿透", async () => {
    const initial = {
      scale: 2,
      always_on_top: true,
      stage_width: 400,
      stage_height: 600,
    };
    const h = await harness(JSON.stringify(initial));
    const state = await h.controller.load();
    expect(state.scale).toBe(2);
    expect(state.stage_width).toBe(400);
    h.controller.applyToWindow();
    // 400×600 的立绘 2× 会超过显示上限（420×630），按等比缩回；加聊天条 92 → 722
    expect(h.window.size).toEqual({ width: 420, height: 722 });
    expect(h.window.alwaysOnTop).toBe(true);
    expect(h.window.clickThrough).toBe(true);
  });

  it("setState 改缩放会立刻改窗口、落盘并广播", async () => {
    const h = await harness();
    await h.controller.load();
    const next = await h.controller.setState({ scale: 1.5, always_on_top: true });
    expect(next.scale).toBe(1.5);
    // 没上报过包围盒，用占位图 128×128：1.5× 立绘 192 比两个下限都小，宽度取 400；高 240 + 92
    expect(h.window.size).toEqual({ width: 400, height: 332 });
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
      workArea: () => h.area.current,
      cursor: () => h.cursor.current,
    });
    await expect(broken.setState({ scale: 1.2 })).resolves.toBeDefined();
  });

  it("noteMetrics 按素材包围盒改窗口并把包围盒落盘，聊天条高度只影响本次窗口", async () => {
    const h = await harness();
    await h.controller.load();
    h.controller.applyToWindow();
    const before = h.window.sizeCalls;
    h.controller.noteMetrics({ stage_width: 512, stage_height: 768, chatbar_height: 92 });
    // 512×768 超过显示上限，等比缩到 420×630；加聊天条 92
    expect(h.window.size).toEqual({ width: 420, height: 630 + 92 });
    expect(h.window.sizeCalls).toBe(before + 1);
    await h.controller.flush();
    const raw = JSON.parse(await readFile(h.stateFile, "utf8")) as UiStatePayload;
    expect(raw.stage_width).toBe(512);
    expect(raw.stage_height).toBe(768);
    // 输入框长高：只改窗口高度；聊天条高度是瞬时量，不落盘也不广播
    h.controller.noteMetrics({ stage_width: 512, stage_height: 768, chatbar_height: 132 });
    expect(h.window.size).toEqual({ width: 420, height: 630 + 132 });
    expect(h.broadcast).toHaveLength(0);
    const after = JSON.parse(await readFile(h.stateFile, "utf8")) as Record<string, unknown>;
    expect("chatbar_height" in after).toBe(false);
  });

  it("noteMetrics 的坏值被夹住，同一尺寸不重复改窗口", async () => {
    const h = await harness();
    await h.controller.load();
    h.controller.noteMetrics({ stage_width: Number.NaN, stage_height: -5, chatbar_height: 9999 });
    // 包围盒退回占位图 128×128（宽仍踩 400 下限），聊天条高度夹到上限 320
    expect(h.window.size).toEqual({ width: 400, height: 240 + 320 });
    expect(h.controller.getState().stage_width).toBe(128);
    const calls = h.window.sizeCalls;
    h.controller.noteMetrics({ stage_width: 128, stage_height: 128, chatbar_height: 320 });
    expect(h.window.sizeCalls).toBe(calls);
  });

  it("拖动跟随系统光标：抓点偏置固定，同位置不重复摆，endDrag 后不再跟（T2.2 用户反馈第五轮）", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness();
      await h.controller.load();
      h.window.bounds = { x: 100, y: 200, width: 400, height: 500 };
      h.cursor.current = { x: 160, y: 260 };
      h.controller.beginDrag();
      expect(h.controller.isDragging()).toBe(true);
      // 抓点偏置 = 光标 − 窗口左上角 = (60, 60)；按下本身不移动窗口
      expect(h.window.placements).toEqual([]);
      h.cursor.current = { x: 400, y: 500 };
      h.controller.stepDrag();
      expect(h.window.position).toEqual({ x: 340, y: 440 });
      // 同一位置不重复 setPosition（光标停着时不该刷窗口消息）
      h.controller.stepDrag();
      expect(h.window.placements).toEqual([{ x: 340, y: 440 }]);
      // 定时器确实在跟：推进一个周期就追上新的光标位置
      h.cursor.current = { x: 401, y: 501 };
      vi.advanceTimersByTime(DRAG_POLL_MS);
      expect(h.window.position).toEqual({ x: 341, y: 441 });
      // 松手前最后对一次光标：快速甩动时轮询会落后，endDrag 要把窗口补到最后位置
      h.cursor.current = { x: 460, y: 560 };
      h.controller.endDrag();
      expect(h.window.position).toEqual({ x: 400, y: 500 });
      expect(h.controller.isDragging()).toBe(false);
      h.cursor.current = { x: 900, y: 900 };
      vi.advanceTimersByTime(DRAG_POLL_MS * 5);
      expect(h.window.position).toEqual({ x: 400, y: 500 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("拿不到窗口或光标时拖动整体忽略（T2.2 用户反馈第五轮）", async () => {
    const h = await harness();
    await h.controller.load();
    h.cursor.current = null;
    h.controller.beginDrag();
    expect(h.controller.isDragging()).toBe(false);
    h.controller.endDrag();
    expect(h.window.placements).toEqual([]);
  });

  it("resetPosition 用工作区居中并落盘，拿不到窗口或工作区时返回 false（T2.2）", async () => {
    const h = await harness();
    await h.controller.load();
    h.window.bounds = { x: 100, y: 50, width: 400, height: 500 };
    expect(h.controller.resetPosition()).toBe(true);
    expect(h.window.position).toEqual({ x: 760, y: 270 });
    await h.controller.flush();
    const raw = JSON.parse(await readFile(h.stateFile, "utf8")) as UiStatePayload;
    expect(raw.x).toBe(760);
    expect(raw.y).toBe(270);
    h.area.current = null;
    expect(h.controller.resetPosition()).toBe(false);
  });

  it("minimize 只隐藏窗口，不动尺寸与位置（T2.3-C2c）", async () => {
    const h = await harness();
    await h.controller.load();
    const before = h.window.sizeCalls;
    h.controller.minimize();
    expect(h.window.hideCalls).toBe(1);
    expect(h.window.sizeCalls).toBe(before);
    expect(h.window.placements).toEqual([]);
  });

  it("characters 透传角色列表，openSettings 只转发一次", async () => {
    const h = await harness();
    await h.controller.load();
    expect(await h.controller.characters()).toEqual([{ char_id: "amber", display_name: "琥珀" }]);
    h.controller.openSettings();
    expect(h.opened).toEqual(["settings"]);
  });
});
