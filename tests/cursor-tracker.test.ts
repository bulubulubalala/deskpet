/**
 * 文件职责：全桌面鼠标追踪的纯逻辑单测（T2.27）。
 *
 * 为什么值得测：坐标换算、窗口隐藏时暂停、静止不重复发，都是「鼠标动了但模型没反应」
 * 或「IPC 每帧狂刷」的常见根因；这里不启动 Electron。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CURSOR_POLL_MS, CursorTracker, type CursorTrackerDeps } from "../app/main/cursor-tracker";
import type { UiCursorMessage } from "../app/shared/contracts/ipc";

interface Harness {
  tracker: CursorTracker;
  sent: UiCursorMessage[];
  cursor: { current: { x: number; y: number } | null };
  bounds: { current: { x: number; y: number; width: number; height: number } | null };
  visible: { current: boolean };
}

function harness(overrides: Partial<CursorTrackerDeps> = {}): Harness {
  const sent: UiCursorMessage[] = [];
  const cursor = { current: { x: 300, y: 200 } };
  const bounds = { current: { x: 100, y: 50, width: 420, height: 800 } };
  const visible = { current: true };
  const tracker = new CursorTracker({
    cursor: () => cursor.current,
    contentBounds: () => bounds.current,
    canTrack: () => visible.current,
    send: (message) => sent.push(message),
    ...overrides,
  });
  return { tracker, sent, cursor, bounds, visible };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CursorTracker", () => {
  it("开启后立即推一帧，坐标是相对内容区的 DIP", () => {
    const h = harness();
    h.tracker.setEnabled(true);
    expect(h.sent).toEqual([{ x: 200, y: 150 }]);
    h.tracker.dispose();
  });

  it("鼠标不动不重复发；窗口移动导致相对坐标变化时补发", () => {
    vi.useFakeTimers();
    const h = harness();
    h.tracker.setEnabled(true);
    vi.advanceTimersByTime(CURSOR_POLL_MS * 3);
    expect(h.sent).toHaveLength(1);

    h.bounds.current = { x: 80, y: 50, width: 420, height: 800 };
    vi.advanceTimersByTime(CURSOR_POLL_MS);
    expect(h.sent).toEqual([
      { x: 200, y: 150 },
      { x: 220, y: 150 },
    ]);
    h.tracker.dispose();
  });

  it("窗口隐藏 / 最小化时暂停；恢复后先补一帧", () => {
    vi.useFakeTimers();
    const h = harness();
    h.tracker.setEnabled(true);
    h.visible.current = false;
    vi.advanceTimersByTime(CURSOR_POLL_MS * 4);
    expect(h.sent).toHaveLength(1);

    h.visible.current = true;
    h.cursor.current = { x: 301, y: 200 };
    vi.advanceTimersByTime(CURSOR_POLL_MS);
    expect(h.sent).toEqual([
      { x: 200, y: 150 },
      { x: 201, y: 150 },
    ]);
    h.tracker.dispose();
  });

  it("关闭后停表，再打开重新推首帧", () => {
    vi.useFakeTimers();
    const h = harness();
    h.tracker.setEnabled(true);
    h.tracker.setEnabled(false);
    h.cursor.current = { x: 400, y: 300 };
    vi.advanceTimersByTime(CURSOR_POLL_MS * 5);
    expect(h.sent).toHaveLength(1);

    h.tracker.setEnabled(true);
    expect(h.sent).toEqual([
      { x: 200, y: 150 },
      { x: 300, y: 250 },
    ]);
    h.tracker.dispose();
  });

  it("拿不到光标或窗口范围时安全跳过", () => {
    vi.useFakeTimers();
    const h = harness();
    h.cursor.current = null;
    h.tracker.setEnabled(true);
    expect(h.sent).toEqual([]);

    h.cursor.current = { x: 200, y: 100 };
    h.bounds.current = null;
    vi.advanceTimersByTime(CURSOR_POLL_MS);
    expect(h.sent).toEqual([]);
    h.tracker.dispose();
  });
});
