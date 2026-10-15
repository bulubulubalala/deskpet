/**
 * 文件职责：CDP 冒烟的共用件——找到 Electron 的 index.html 页目标、发一句、轮询界面信号。
 *
 * 为什么单独成模块：文字冒烟（scripts/smoke_text.mjs）与记忆冒烟（scripts/smoke_memory.mjs）
 * 要等同一批界面信号（sidecar 上线 / 渲染层就绪 / 主进程空闲），两份复制一定会漂移。
 * 依赖：Node 22+ 自带的全局 WebSocket 与 fetch，不需要额外依赖。
 * 谁调用：scripts/smoke_text.mjs、scripts/smoke_memory.mjs、scripts/smoke_settings.mjs。
 */

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 从命令行数组里取 --name 的值；没写就用 fallback。 */
export function argOf(args, name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] !== undefined) {
    return args[index + 1];
  }
  return fallback;
}

/** 在 CDP 端口上找渲染页；needle 默认主窗 index.html，设置窗传 settings.html。 */
export async function findPage(port, needle = "index.html") {
  const response = await fetch("http://127.0.0.1:" + port + "/json/list");
  const targets = await response.json();
  return targets.find((item) => item.type === "page" && String(item.url).includes(needle));
}

/** 极简 CDP 客户端：只用到 Runtime.evaluate。 */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined || !this.pending.has(message.id)) {
        return;
      }
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      entry.resolve(message);
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.socket.send(payload);
    });
  }

  async evaluate(expression) {
    const message = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const result = message.result;
    if (result && result.exceptionDetails) {
      throw new Error("CDP evaluate failed: " + JSON.stringify(result.exceptionDetails));
    }
    return result && result.result ? result.result.value : undefined;
  }

  /** 轮询直到表达式为真，返回等待毫秒数；超时抛错。 */
  async waitFor(expression, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.evaluate(expression)) {
        return Date.now() - start;
      }
      await sleep(50);
    }
    throw new Error("timeout waiting for " + label + " after " + timeoutMs + "ms");
  }
}

export const BUBBLE_TEXT = "String((document.getElementById('bubble-text')||{}).textContent||'')";
export const TURN_ACTIVE = "document.getElementById('interrupt-button').disabled===false";
export const TURN_DONE = "document.getElementById('interrupt-button').disabled===true";
export const ONLINE =
  "String((document.getElementById('health-dot')||{}).className||'').includes('online')";
/** 渲染层挂完监听器后打的标记；没有它就会在监听器挂上前发消息（T1.13a 竞态）。 */
export const READY = "document.body.dataset.ready === '1'";
/** 主进程真正空闲（打断按钮灰着 + 语音状态空闲）才算上一轮结束，否则新的一句会被拒。 */
export const IDLE_GATE =
  "document.getElementById('interrupt-button').disabled===true" +
  " && String((document.getElementById('voice-state')||{}).textContent||'')==='空闲'";
export const DEBUG_SNAPSHOT =
  "(function(){var btn=document.getElementById('interrupt-button');" +
  "return JSON.stringify({disabled:btn?btn.disabled:null,ready:String(document.body.dataset.ready)," +
  "voice:String((document.getElementById('voice-state')||{}).textContent||'')," +
  "bubble:String((document.getElementById('bubble-text')||{}).textContent||'').slice(0,24)," +
  "popup_items:document.querySelectorAll('.popup-item').length," +
  "banner:String((document.getElementById('banner')||{}).textContent||'').slice(0,60)});})()";
export const IS_ERROR_BUBBLE =
  "String((document.getElementById('bubble')||{}).className||'').includes('error')";

/** 往聊天输入框塞一句并回车（CDP 注入比真实键盘稳）。 */
export async function sendLine(cdp, text) {
  const script =
    "(function(){var b=document.getElementById('bubble');" +
    "var t=document.getElementById('bubble-text');if(t)t.textContent='';" +
    "if(b)b.hidden=true;var input=document.getElementById('chat-input');" +
    "input.value=" +
    JSON.stringify(text) +
    ";" +
    "input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()";
  await cdp.evaluate(script);
}

/** 连上页目标并启用 Runtime 域；返回 { cdp, socket }（调用方负责 socket.close()）。 */
export async function connectPage(port, needle = "index.html") {
  const page = await findPage(port, needle);
  if (!page) {
    throw new Error("找不到 " + needle + " 页面：Electron 起来了吗");
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error("CDP WebSocket 连接失败"));
    });
  });
  const cdp = new Cdp(socket);
  await cdp.send("Runtime.enable");
  return { cdp, socket };
}
