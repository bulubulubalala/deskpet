/**
 * 文件职责：记忆链路端到端冒烟——两阶段驱动真实 Electron。
 *   tell：发一句带事实的话，等本轮结束，再轮询 sidecar 的 GET /memory/list 断言事实已入库。
 *   ask ：应用完全重启后问刚说过的名字，断言这次回答确实带出了那个名字。
 *
 * 为什么分两阶段而不是一个脚本起两次进程：进程生命周期归 PowerShell
 * （scripts/smoke_memory.ps1），Node 侧只负责「在一个已经起来的应用上做一件事并断言」。
 * 依赖：node:fs / node:path 读数据目录的 runtime.json 与 ui.json + ./lib/cdp.mjs。
 * 用法：node scripts/smoke_memory.mjs --stage tell --port 9224 --data-dir C:\Temp\x
 * 输出：一行 JSON 报告 + 退出码（0 = 断言通过）。
 */

import { readFile, readdir } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";

import {
  argOf,
  BUBBLE_TEXT,
  connectPage,
  IDLE_GATE,
  IS_ERROR_BUBBLE,
  ONLINE,
  READY,
  sendLine,
  sleep,
  TURN_ACTIVE,
  TURN_DONE,
} from "./lib/cdp.mjs";

const args = process.argv.slice(2);

const STAGE = argOf(args, "--stage", "tell");
const PORT = Number(argOf(args, "--port", "9224"));
const DATA_DIR = argOf(args, "--data-dir", process.env.DESKPET_DATA_DIR || "");
const WAIT_SIDECAR_MS = Number(argOf(args, "--wait-sidecar-ms", "90000"));
const TURN_TIMEOUT_MS = Number(argOf(args, "--turn-timeout-ms", "90000"));
/** 事实入库是上一轮收尾动作（chat_service 的 finally），给它一点余量再判失败。 */
const MEMORY_WAIT_MS = Number(argOf(args, "--memory-wait-ms", "20000"));
const TOKEN_HEADER = "X-Deskpet-Token";
/**
 * 默认台词写在代码里，不由 PowerShell 传中文参数——Windows 命令行转码是另一处会翻车的细节。
 * 事实句沿用 docs/ACCEPTANCE.md 与 MEASURED §8.1 里那句（猫叫团子）。
 */
const SCRIPT_LINES = {
  tell: "顺便说一句，我养了一只猫，叫团子，它老睡我键盘上。",
  ask: "我的猫叫什么名字？",
};
const EXPECT = argOf(args, "--expect", "团子");
/** 可忽略的提示类「错误气泡」：语音引擎没起（DP-TTS-001），文字链路不受影响。 */
const IGNORABLE_HINTS = ["语音引擎没有在运行"];

function withToken(token) {
  return { [TOKEN_HEADER]: token };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 从数据目录读 runtime.json（sidecar 的端口与令牌），data/ 子目录那处也找一遍。
 * 会重试：应用刚起来时 sidecar 可能还没把文件原子写完（旧文件也可能是上一次运行的）。
 */
async function readRuntime() {
  const candidates = [join(DATA_DIR, "runtime.json"), join(DATA_DIR, "data", "runtime.json")];
  const deadline = Date.now() + 30000;
  while (true) {
    for (const path of candidates) {
      const record = await readJson(path);
      if (record && typeof record.port === "number" && typeof record.token === "string") {
        return { base: "http://127.0.0.1:" + record.port, token: record.token };
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("读不到 runtime.json（sidecar 起来了吗）：" + DATA_DIR);
    }
    await sleep(500);
  }
}

/** 当前角色 id：优先 ui.json 的 char_id，其次 characters/ 下的目录名。 */
async function characterIds() {
  const ids = [];
  const ui = await readJson(join(DATA_DIR, "ui.json"));
  if (ui && typeof ui.char_id === "string" && ui.char_id !== "") {
    ids.push(ui.char_id);
  }
  try {
    const root = join(import.meta.dirname, "..");
    const entries = await readdir(join(root, "characters"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !ids.includes(entry.name)) {
        ids.push(entry.name);
      }
    }
  } catch {
    // characters/ 读不到就只认 ui.json 的结果
  }
  if (ids.length === 0) {
    ids.push("amber");
  }
  return ids;
}

/**
 * 用 node:http（agent: false 随用随关）而不是全局 fetch：fetch 的 keep-alive 连接池
 * 在进程退出时会踩到 libuv 在 Windows 上的断言（uv_async 句柄正在关闭）。
 */
function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function listMemories(runtime, charId) {
  const query = "?char_id=" + encodeURIComponent(charId) + "&limit=50";
  const response = await httpGetJson(
    runtime.base + "/memory/list" + query,
    withToken(runtime.token),
  );
  if (response.status !== 200) {
    throw new Error("GET /memory/list 返回 " + response.status);
  }
  const payload = JSON.parse(response.body);
  return Array.isArray(payload.items) ? payload.items : [];
}

/**
 * 发一句并等这一轮说完。与 smoke_text 一样：dispatch 可能被丢掉，所以隔 400ms 重发，
 * 重发是安全的——主进程在 turnActive 时会直接忽略（app/renderer/index.ts:155）。
 */
async function converse(cdp, text) {
  await cdp.waitFor(IDLE_GATE, 30000, "orchestrator idle");
  const start = Date.now();
  let started = false;
  for (let attempt = 0; attempt < 20 && !started; attempt++) {
    await sendLine(cdp, text);
    started = Boolean(await cdp.evaluate(TURN_ACTIVE));
    if (!started) {
      await sleep(400);
    }
  }
  if (!started) {
    throw new Error("连续 20 次都没进入对话轮次（turn start）");
  }
  await cdp.waitFor(BUBBLE_TEXT + ".length>0", TURN_TIMEOUT_MS, "first bubble");
  const firstBubbleMs = Date.now() - start;
  const firstText = String(await cdp.evaluate(BUBBLE_TEXT));
  // 气泡是逐句替换的：一边等本轮结束一边收集，别只看最后一句。
  const segments = [firstText];
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let turnDone = false;
  while (Date.now() < deadline) {
    const text = String(await cdp.evaluate(BUBBLE_TEXT));
    if (text.length > 0 && segments[segments.length - 1] !== text) {
      segments.push(text);
    }
    if (await cdp.evaluate(TURN_DONE)) {
      turnDone = true;
      break;
    }
    await sleep(120);
  }
  // 气泡可能是「语音引擎没有在运行」这类可恢复提示（样式也是 error），文字链路其实没坏：
  // docs/ACCEPTANCE.md §3 已写明可忽略，所以把它记成 hints，不判失败。
  const errorFlag = Boolean(await cdp.evaluate(IS_ERROR_BUBBLE));
  const errorText = String(await cdp.evaluate(BUBBLE_TEXT));
  const hint = errorFlag && IGNORABLE_HINTS.some((pattern) => errorText.includes(pattern));
  return {
    first_bubble_ms: firstBubbleMs,
    segments: segments,
    is_error: errorFlag && !hint,
    hints: hint ? [errorText] : [],
    turn_done: turnDone,
  };
}

/** 轮询 /memory/list（按候选角色 id 依次试），直到某条记忆文本含 EXPECT。 */
async function waitForMemory(runtime) {
  const ids = await characterIds();
  const start = Date.now();
  let seen = { char_id: ids[0], items: [] };
  while (Date.now() - start < MEMORY_WAIT_MS) {
    for (const charId of ids) {
      const items = await listMemories(runtime, charId);
      const texts = items.map((item) => String(item.text));
      const hit = items.find((item) => String(item.text).includes(EXPECT));
      if (hit) {
        return {
          char_id: charId,
          matched: true,
          wait_ms: Date.now() - start,
          hit: { id: hit.id, kind: hit.kind, tier: hit.tier, text: hit.text },
          items: texts.slice(0, 20),
        };
      }
      seen = { char_id: charId, items: texts.slice(0, 20) };
    }
    await sleep(500);
  }
  return {
    char_id: seen.char_id,
    matched: false,
    wait_ms: Date.now() - start,
    hit: null,
    items: seen.items,
  };
}

async function main() {
  if (DATA_DIR === "") {
    throw new Error("必须给 --data-dir 或 DESKPET_DATA_DIR");
  }
  if (!Object.prototype.hasOwnProperty.call(SCRIPT_LINES, STAGE)) {
    throw new Error("--stage 只能是 tell 或 ask，收到：" + STAGE);
  }
  const runtime = await readRuntime();
  const { cdp, socket } = await connectPage(PORT);
  const report = {
    ok: false,
    stage: STAGE,
    data_dir: DATA_DIR,
    expected: EXPECT,
    sidecar_online_ms: 0,
    renderer_ready_ms: 0,
    first_bubble_ms: 0,
    segments: [],
    is_error: false,
    turn_done: false,
    memory: null,
  };
  try {
    report.sidecar_online_ms = await cdp.waitFor(ONLINE, WAIT_SIDECAR_MS, "sidecar online");
    report.renderer_ready_ms = await cdp.waitFor(READY, 10000, "renderer ready");
    await sleep(300);
    const turn = await converse(cdp, SCRIPT_LINES[STAGE]);
    report.first_bubble_ms = turn.first_bubble_ms;
    report.segments = turn.segments;
    report.is_error = turn.is_error;
    report.hints = turn.hints;
    report.turn_done = turn.turn_done;
    if (STAGE === "tell") {
      report.memory = await waitForMemory(runtime);
      report.ok = report.is_error === false && report.memory.matched === true;
    } else {
      const matched = turn.segments.filter((text) => text.includes(EXPECT));
      report.matched_segments = matched;
      report.ok = report.is_error === false && matched.length > 0;
    }
  } finally {
    socket.close();
  }
  console.log(JSON.stringify(report));
  // 让事件循环自然排空再退出（process.exit 与收尾中的句柄抢跑会踩 libuv 断言）；
  // unref 的兜底定时器只在有东西卡住事件循环时才生效。
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(report.ok ? 0 : 1), 10000).unref();
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 2;
});
