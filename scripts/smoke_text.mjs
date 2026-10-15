/**
 * 文件职责：文字链路端到端冒烟——用 CDP 驱动真实 Electron，连续发 3 轮对话，
 * 其中第 2 轮在中途打断，并测量「首句实义」与「打断延迟」。
 *
 * 为什么走 CDP 而不是在主进程里塞钩子：这条链路要验的是用户真实路径
 * （renderer -> IPC -> main -> sidecar -> LLM -> 气泡），主进程内部钩子会绕开 IPC 与渲染层。
 * 依赖：Node 22+ 自带全局 WebSocket 与 fetch（本机 Node 24），不需要额外依赖。
 * 用法：node scripts/smoke_text.mjs --port 9223 --turns 3
 * 输出：一行 JSON 报告 + 退出码（0 = 断言通过）。
 */

const args = process.argv.slice(2);

function argOf(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] !== undefined) {
    return args[index + 1];
  }
  return fallback;
}

const PORT = Number(argOf("--port", "9223"));
const TURNS = Number(argOf("--turns", "3"));
const WAIT_SIDECAR_MS = Number(argOf("--wait-sidecar-ms", "90000"));
const TURN_TIMEOUT_MS = Number(argOf("--turn-timeout-ms", "90000"));
/** 打断后保持安静多久才算「真的没继续播」（毫秒）。 */
const QUIET_MS = 2000;
const PROMPTS = [
  "你好，今天有点累，随便说点什么",
  "那你给我讲个你最近想到的事",
  "好啦，谢谢你陪我",
];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function findPage() {
  const response = await fetch("http://127.0.0.1:" + PORT + "/json/list");
  const targets = await response.json();
  return targets.find((item) => item.type === "page" && String(item.url).includes("index.html"));
}

/** 极简 CDP 客户端：只用到 Runtime.evaluate。 */
class Cdp {
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

const BUBBLE_TEXT = "String((document.getElementById('bubble-text')||{}).textContent||'')";
const TURN_ACTIVE = "document.getElementById('interrupt-button').disabled===false";
const TURN_DONE = "document.getElementById('interrupt-button').disabled===true";
const ONLINE =
  "String((document.getElementById('health-dot')||{}).className||'').includes('online')";
/** 渲染层挂完监听器后打的标记；没有它就会在监听器挂上前发消息（T1.13a 竞态）。 */
const READY = "document.body.dataset.ready === '1'";
/** 主进程真正空闲（打断按钮灰着 + 语音状态空闲）才算上一轮结束，否则新的一句会被拒。 */
const IDLE_GATE =
  "document.getElementById('interrupt-button').disabled===true" +
  " && String((document.getElementById('voice-state')||{}).textContent||'')==='\u7a7a\u95f2'";
const DEBUG_SNAPSHOT =
  "(function(){var btn=document.getElementById('interrupt-button');" +
  "return JSON.stringify({disabled:btn?btn.disabled:null,ready:String(document.body.dataset.ready)," +
  "voice:String((document.getElementById('voice-state')||{}).textContent||'')," +
  "bubble:String((document.getElementById('bubble-text')||{}).textContent||'').slice(0,24)," +
  "popup_items:document.querySelectorAll('.popup-item').length," +
  "banner:String((document.getElementById('banner')||{}).textContent||'').slice(0,60)});})()";
const IS_ERROR_BUBBLE =
  "String((document.getElementById('bubble')||{}).className||'').includes('error')";

async function sendLine(cdp, text) {
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

async function main() {
  const page = await findPage();
  if (!page) {
    throw new Error("找不到 index.html 页面：Electron 起来了吗");
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

  const report = { ok: false, port: PORT, turns: [], sidecar_online_ms: 0, renderer_ready_ms: 0 };
  report.sidecar_online_ms = await cdp.waitFor(ONLINE, WAIT_SIDECAR_MS, "sidecar online");
  report.renderer_ready_ms = await cdp.waitFor(READY, 10000, "renderer ready");
  await sleep(300);

  for (let index = 0; index < TURNS; index++) {
    const prompt = PROMPTS[index % PROMPTS.length];
    // 等上一轮在主进程侧彻底结束（合成链收尾期间 send 会被拒），再做这一轮。
    if (index > 0) {
      await cdp.waitFor(IDLE_GATE, 30000, "orchestrator idle");
    }
    const start = Date.now();
    // 就算有 ready 与 idle 门禁也防一手：dispatch 万一被丢掉（窗口未聚焦等）就隔 400ms 重发，
    // 重发是安全的——sendCurrentLine 在 turnActive 为真时会直接 return（app/renderer/index.ts:155）。
    let started = false;
    for (let attempt = 0; attempt < 20 && !started; attempt++) {
      await sendLine(cdp, prompt);
      console.error("attempt " + attempt + " " + String(await cdp.evaluate(DEBUG_SNAPSHOT)));
      started = Boolean(await cdp.evaluate(TURN_ACTIVE));
      if (!started) {
        await sleep(400);
      }
    }
    if (!started) {
      throw new Error("连续 20 次都没进入对话轮次（turn start）");
    }
    await cdp.waitFor(BUBBLE_TEXT + ".length>0", TURN_TIMEOUT_MS, "first bubble");
    const turn = {
      index: index + 1,
      prompt: prompt,
      first_bubble_ms: Date.now() - start,
      first_text: await cdp.evaluate(BUBBLE_TEXT),
      is_error: await cdp.evaluate(IS_ERROR_BUBBLE),
    };
    if (index === 1) {
      const cancelStart = Date.now();
      await cdp.evaluate("document.getElementById('interrupt-button').click()");
      await cdp.waitFor(TURN_DONE, 10000, "turn end after cancel");
      turn.interrupt_ms = Date.now() - cancelStart;
      const afterCancel = await cdp.evaluate(BUBBLE_TEXT);
      await sleep(QUIET_MS);
      turn.text_after_cancel = afterCancel;
      turn.quiet_ok = (await cdp.evaluate(BUBBLE_TEXT)) === afterCancel;
    } else {
      await cdp.waitFor(TURN_DONE, TURN_TIMEOUT_MS, "turn end");
      turn.turn_total_ms = Date.now() - start;
    }
    report.turns.push(turn);
  }

  // 只有 2 轮以上才有「打断轮」；--turns 1 用于快速排查。
  const interrupted = TURNS >= 2 ? report.turns[1] : undefined;
  const interruptOk =
    TURNS < 2 ||
    (interrupted !== undefined &&
      interrupted.interrupt_ms !== undefined &&
      interrupted.quiet_ok === true);
  report.ok =
    report.turns.length === TURNS &&
    report.turns.every((turn) => turn.first_text.length > 0 && !turn.is_error) &&
    interruptOk;
  socket.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(2);
});
