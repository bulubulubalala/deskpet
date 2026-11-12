/**
 * 文件职责：主窗里最常做的一件事——按 id 找元素。
 *
 * 为什么单独一个文件：主窗脚本几乎每个功能都要找 DOM，把它留在入口文件里，
 * 拆出去的模块就只能反过来 import 入口（会造成循环依赖）。放这里，谁都能用，且不依赖任何业务。
 * 依赖方向：renderer/* -> renderer/dom；本文件不 import 任何业务模块。
 */

/** 允许为空：大部分控件是「有就接，没有就算了」（HTML 与脚本版本不一致时不至于整窗白屏）。 */
export function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** 主窗必需的容器；缺了说明 HTML 和脚本版本对不上，直接报出来比静默不显示好。 */
export function mustById(id: string): HTMLElement {
  const node = byId(id);
  if (node === null) {
    throw new Error("缺少界面元素：" + id);
  }
  return node;
}
