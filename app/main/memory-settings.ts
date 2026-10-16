/**
 * 文件职责：「记忆」设置里的 .env 映射（T2.1c）——行为记忆总开关的读写纯函数。
 *
 * 为什么单独一份：界面只认 IPC 契约里的布尔量，.env 的键名与真假写法属于 sidecar 的配置
 * 方言（config.py 的 _bool_flag）。把这两件事收在纯函数里，设置窗与单测都不必碰 fs。
 * 谁调用：app/main/ipc-handlers.ts 的 deskpet:memory:behavior 通道。
 */

/** 行为记忆开关在 .env 里的键名，与 sidecar/config.py 的 _load_memory_settings 对齐。 */
export const MEMORY_BEHAVIOR_KEY = "DESKPET_MEMORY_BEHAVIOR_ENABLED";

const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

/**
 * 读 .env 里的开关值，得到界面上该勾还是该取消。
 *
 * 三种情况都返回 true（与 sidecar 的默认值一致）：键不存在、键是空串、键是非法值。
 * 非法值不在这里报错——sidecar 启动时 _bool_flag 会直接抛，界面上多说一句只会误导用户。
 */
export function parseBehaviorEnabled(env: Record<string, string>): boolean {
  const raw = (env[MEMORY_BEHAVIOR_KEY] ?? "").trim().toLowerCase();
  if (raw === "") {
    return true;
  }
  if (TRUTHY.includes(raw)) {
    return true;
  }
  if (FALSY.includes(raw)) {
    return false;
  }
  return true;
}

/**
 * 把界面的勾选翻译成 updateEnvFile 的入参。
 *
 * 一律写成 true / false 两个词（不写 1 / 0）：.env 是给人看的，读起来不用再想一遍。
 */
export function behaviorEnvUpdate(enabled: boolean): Record<string, string> {
  return { [MEMORY_BEHAVIOR_KEY]: enabled ? "true" : "false" };
}
