/**
 * 文件职责：窗口晃动检测（T2.3-C1）的单测——把「甩窗口」与「普通拖动 / 手抖」分开。
 *
 * 为什么值得单测：这几个阈值决定「他爱晃你」这条行为记忆的真假，误判会写进长期记忆；
 * 模块本身不依赖 Electron，可以直接喂坐标序列。
 * 依赖方向：tests -> app/main/shake-detector.ts（纯逻辑，不起窗口）。
 */

import { describe, expect, it } from "vitest";

import {
  SHAKE_COOLDOWN_MS,
  SHAKE_MIN_STEP_PX,
  SHAKE_WINDOW_MS,
  ShakeDetector,
} from "../app/main/shake-detector";

/** 一次喂一批 [x, y, at]，返回命中晃动的次数。 */
function feed(detector: ShakeDetector, points: readonly [number, number, number][]): number {
  let hits = 0;
  for (const [x, y, at] of points) {
    if (detector.push(x, y, at)) {
      hits += 1;
    }
  }
  return hits;
}

/** 横向来回甩：0→100→0→100→0→100，5 段方向 = 4 次反转。 */
function horizontalShake(startAt: number, stepMs = 50): [number, number, number][] {
  return [0, 100, 0, 100, 0, 100].map((x, index) => [x, 0, startAt + index * stepMs]);
}

describe("ShakeDetector", () => {
  it("来回甩四次算一次晃动，单向拖动不算", () => {
    expect(feed(new ShakeDetector(), horizontalShake(1000))).toBe(1);
    // 一路往一个方向拖：方向只有一段，反转 0 次
    const oneWay: [number, number, number][] = [0, 100, 200, 300, 400, 500].map((x, index) => [
      x,
      0,
      1000 + index * 50,
    ]);
    expect(feed(new ShakeDetector(), oneWay)).toBe(0);
  });

  it("竖向来回甩同样算晃动（主方向取位移更大的那条轴）", () => {
    const points: [number, number, number][] = [0, 100, 0, 100, 0, 100].map((y, index) => [
      0,
      y,
      1000 + index * 50,
    ]);
    expect(feed(new ShakeDetector(), points)).toBe(1);
  });

  it("小于单步门槛的手抖不算方向样本", () => {
    const detector = new ShakeDetector();
    const jitter: [number, number, number][] = [];
    for (let index = 0; index < 40; index += 1) {
      jitter.push([index % 2 === 0 ? 0 : SHAKE_MIN_STEP_PX - 1, 0, 1000 + index * 20]);
    }
    expect(feed(detector, jitter)).toBe(0);
  });

  it("冷却期内不再命中，冷却结束后可以再命中一次", () => {
    const detector = new ShakeDetector();
    expect(feed(detector, horizontalShake(1000))).toBe(1);
    // 命中发生在 1250：冷却期内的继续甩都吞掉，避免一次甩动记成一串
    expect(feed(detector, horizontalShake(1300))).toBe(0);
    const afterCooldown = 1250 + SHAKE_COOLDOWN_MS + 50;
    expect(feed(detector, horizontalShake(afterCooldown))).toBe(1);
  });

  it("慢速来回不命中：超出判定窗口的旧样本会过期", () => {
    expect(SHAKE_WINDOW_MS).toBe(800);
    const detector = new ShakeDetector();
    // 每 1000ms 才换一次方向：每次都把上一条样本挤出窗口，反转数永远停在 0
    const points: [number, number, number][] = [0, 100, 0, 100, 0, 100, 0].map((x, index) => [
      x,
      0,
      index * 1000,
    ]);
    expect(feed(detector, points)).toBe(0);
  });

  it("reset 清空方向样本与基准点，不会把上一串接着数", () => {
    const detector = new ShakeDetector();
    // 攒到 3 次反转（还差 1 次就命中）后清空
    feed(detector, horizontalShake(1000).slice(0, 5));
    detector.reset();
    // reset 后第一条只用来定位基准点；再来 4 段方向也才 3 次反转，不该命中
    const again: [number, number, number][] = [500, 600, 500, 600, 500].map((x, index) => [
      x,
      0,
      1200 + index * 50,
    ]);
    expect(feed(detector, again)).toBe(0);
  });
});
