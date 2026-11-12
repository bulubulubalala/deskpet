/**
 * 文件职责：编辑器里反复用的 DOM 小工具：取元素、断言元素类型、画布上下文、横幅、步骤条。
 *
 * 为什么单独一个文件：这些函数原先散在 1500 行的编辑器里，被裁切、部位、卡片三段重复调用；抽出来后每段只关心自己的业务。
 * 依赖方向：无依赖（只碰 DOM），任何编辑器模块都可以 import。
 */

export function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error("界面元素缺失：" + id);
  }
  return element;
}

export function asInput(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("不是输入框：" + id);
  }
  return element;
}

export function asTextarea(id: string): HTMLTextAreaElement {
  const element = byId(id);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("不是多行输入框：" + id);
  }
  return element;
}

export function asCanvas(id: string): HTMLCanvasElement {
  const element = byId(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error("不是画布：" + id);
  }
  return element;
}

export function asButton(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("不是按钮：" + id);
  }
  return element;
}

export function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const value = canvas.getContext("2d");
  if (value === null) {
    throw new Error("拿不到 2D 画布上下文");
  }
  return value;
}

export function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function showBanner(message: string, bad = false): void {
  const banner = byId("editor-banner");
  banner.textContent = message;
  banner.className = bad ? "banner bad" : "banner";
  banner.hidden = message === "";
}

export function showStep(next: 1 | 2 | 3 | 4): void {
  const all: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];
  for (const value of all) {
    byId("step-" + String(value)).hidden = value !== next;
    byId("step-tab-" + String(value)).className = value === next ? "step active" : "step";
  }
}
