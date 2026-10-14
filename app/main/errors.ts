/**
 * 文件职责：主进程侧的错误小工具（把任意抛出物收敛成可读文本）。
 *
 * 为什么独立成一个模块：日志、UI、IPC 返回值都要「一句话说清哪里坏了」，
 * 各写一遍 String(error) 会出现 undefined、[object Object] 这类废话（CODE_STYLE §6.4）。
 * 依赖方向：main 内部纯模块，不 import electron。
 * 谁调用：app/main/engine.ts、app/main/sidecar-process.ts。
 */

/** 把任意抛出物收敛成 Error 的 message；非 Error 一律 String()，保证日志里不是 "undefined"。 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
