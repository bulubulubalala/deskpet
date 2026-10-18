/**
 * 文件职责：开发者模式开关的落盘（data/dev.json，需求 §6.11 / 方案 T2.3-B1）。
 *
 * 为什么单独一个文件：这个开关既不属于 ui.json（窗口形态）也不属于 .env（模型供给）——
 * 它是「设置窗要不要显示排查面板」的界面级开关，按用户 m09634 的定案单独存一份。
 * 明确它不是安全边界：只控制显隐，看不到别人的数据，也提不了权限（方案 §3.1）。
 * 依赖方向：main -> node:fs/promises + ./ipc（只取类型）；不 import 渲染层。
 * 谁调用：app/main/ipc-handlers.ts 的 deskpet:dev:get / deskpet:dev:set。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DevModeState } from "./ipc";

/** data/ 下的文件名；与 ui.json / runtime.json 同一个目录（见 app/main/config.ts 的 dataDir）。 */
export const DEV_MODE_FILENAME = "dev.json";

/** 把读到的任意值读成开关：不是对象、字段缺失、类型不对，一律当「没开」。
 *
 * 坏的 dev.json 不该把界面永远锁在开发者模式里，所以这里从不抛错。
 */
export function parseDevMode(value: unknown): DevModeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { enabled: false };
  }
  return { enabled: (value as Record<string, unknown>)["enabled"] === true };
}

/** 读开关；文件不存在（从没开过）与解析失败都返回关闭——这是正常路径，不是错误。 */
export async function readDevMode(file: string): Promise<DevModeState> {
  try {
    return parseDevMode(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return { enabled: false };
  }
}

/** 原子写：先写 .tmp 再 rename，避免崩溃留下半截 JSON（与 ui.json / runtime.json 同一套做法）。 */
export async function writeDevMode(file: string, state: DevModeState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + ".tmp";
  await writeFile(temp, JSON.stringify(state) + "\n", "utf8");
  await rename(temp, file);
}
