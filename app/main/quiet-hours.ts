/**
 * 文件职责：判断「现在算不算免打扰时段」。
 *
 * 为什么单独一个文件：这是个纯粹的整数比较，却决定主进程要不要主动开口，
 * 放在 1133 行的组合根里既不好读也不好测（跨午夜那段最容易写反）。
 * 依赖方向：main/* -> 本文件；本文件不 import electron、不读时钟以外的东西。
 */
import type { CompanionSettings } from "../shared/contracts/ipc";

/** 负数的起止表示「没设免打扰」；起止相同表示整天都算。 */
export function quietHoursContain(start: number, end: number, hour: number): boolean {
  if (start < 0 || end < 0) {
    return false;
  }
  if (start === end) {
    return true;
  }
  // 跨午夜（22 点到 7 点）是或的关系，不是且
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function inQuietHours(companion: CompanionSettings): boolean {
  return quietHoursContain(
    companion.quiet_hours_start,
    companion.quiet_hours_end,
    new Date().getHours(),
  );
}
