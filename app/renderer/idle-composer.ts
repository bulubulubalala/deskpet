/**
 * 文件职责：待机编排的纯随机决策——隔多久动一下、动哪个。
 *
 * 为什么随机而不是固定循环：固定间隔的 Idle 看着像机器人；8–25s 的随机间隔
 * 才像「自己在发呆，偶尔换个姿势」。
 * 谁调用：app/renderer/index.ts 的 scheduleIdle。
 */

/** 待机动作的间隔区间（毫秒）。 */
export const IDLE_MIN_MS = 8000;
export const IDLE_MAX_MS = 25000;

/** 待机时能播的动作（都是角色包 appearance.motions 里已有的键）。 */
export const IDLE_ACTS = ["idle", "blink", "nod"] as const;

/** 抽签权重：多数时候只是换个待机循环，偶尔眨眼 / 点一下头。 */
export const IDLE_WEIGHTS: readonly (readonly [string, number])[] = [
  ["idle", 0.5],
  ["blink", 0.3],
  ["nod", 0.2],
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

/** 下一次待机动作的等待时间；random 由调用方注入，便于单测。 */
export function nextIdleDelay(random: () => number): number {
  const span = IDLE_MAX_MS - IDLE_MIN_MS;
  return IDLE_MIN_MS + Math.round(clamp01(random()) * span);
}

/** 抽一个待机动作；random 落在 [0,1)，按 IDLE_WEIGHTS 分段。 */
export function pickIdleAct(random: () => number): string {
  const roll = clamp01(random());
  let acc = 0;
  for (const [act, weight] of IDLE_WEIGHTS) {
    acc += weight;
    if (roll < acc) {
      return act;
    }
  }
  // roll 恰好为 1（调用方给了越界值）时落在最后一档，而不是回到第一个动作：
  // 权重区间的右端属于最后一个动作，这样 [0,1] 全覆盖、不会出现「抽了却像没抽」。
  return IDLE_ACTS[IDLE_ACTS.length - 1] ?? "idle";
}
