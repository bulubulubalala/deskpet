/**
 * 文件职责：文字链路端到端冒烟——用 CDP 驱动真实 Electron，连续发 3 轮对话，
 * 其中第 2 轮在中途打断，并测量「首句实义」与「打断延迟」。
 *
 * 为什么走 CDP 而不是在主进程里塞钩子：这条链路要验的是用户真实路径
 * （renderer -> IPC -> main -> sidecar -> LLM -> 气泡），主进程内部钩子会绕开 IPC 与渲染层。
 * 依赖：Node 22+ 自带全局 WebSocket 与 fetch（本机 Node 24）+ ./lib/cdp.mjs，不需要额外依赖。
 * 用法：node scripts/smoke_text.mjs --port 9223 --turns 3
 * 输出：一行 JSON 报告 + 退出码（0 = 断言通过）。
 */

import {
  argOf,
  BUBBLE_FRAME,
  BUBBLE_TEXT,
  connectPage,
  DEBUG_SNAPSHOT,
  IDLE_GATE,
  IS_ERROR_BUBBLE,
  ONLINE,
  READY,
  REPLY_BUBBLE,
  sendLine,
  sleep,
  THINKING_BUBBLE,
  TURN_ACTIVE,
  TURN_DONE,
} from "./lib/cdp.mjs";

const args = process.argv.slice(2);

const PORT = Number(argOf(args, "--port", "9223"));
const TURNS = Number(argOf(args, "--turns", "3"));
const WAIT_SIDECAR_MS = Number(argOf(args, "--wait-sidecar-ms", "90000"));
const TURN_TIMEOUT_MS = Number(argOf(args, "--turn-timeout-ms", "90000"));
/** 打断后保持安静多久才算「真的没继续播」（毫秒）。 */
const QUIET_MS = 2000;
/** 思考气泡应该立刻出现（发出去就算上了）；给 5 秒容忍 IPC 与渲染的抖动。 */
const THINKING_TIMEOUT_MS = Number(argOf(args, "--thinking-timeout-ms", "5000"));
/** 采样思考气泡文字的时长与间隔：400ms 一跳，1.2 秒足够看到 1→2→3 里的好几跳。 */
const THINKING_SAMPLE_MS = Number(argOf(args, "--thinking-sample-ms", "1200"));
const THINKING_POLL_MS = 120;
/** 占位气泡允许出现的文字：只有这三种，出现别的就说明写了假台词。 */
const THINKING_DOTS = ["·", "··", "···"];
const PROMPTS = [
  "你好，今天有点累，随便说点什么",
  "那你给我讲个你最近想到的事",
  "好啦，谢谢你陪我",
];

async function main() {
  const { cdp, socket } = await connectPage(PORT);

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
    // 思考中气泡（T2.2 真机需求）：每轮都必须先出现，文字只在 · / ·· / ··· 之间循环。
    // 用 BUBBLE_FRAME 一次取回类名与文字，避免「取完类名、气泡已被台词替换」的竞态。
    const thinking = { ms: 0, frames: [], error: "" };
    try {
      thinking.ms = await cdp.waitFor(THINKING_BUBBLE, THINKING_TIMEOUT_MS, "thinking bubble");
      const frames = new Set();
      const sampleDeadline = Date.now() + THINKING_SAMPLE_MS;
      while (Date.now() < sampleDeadline) {
        const frame = JSON.parse(String(await cdp.evaluate(BUBBLE_FRAME)));
        if (!frame.thinking) {
          break;
        }
        frames.add(frame.text);
        await sleep(THINKING_POLL_MS);
      }
      thinking.frames = Array.from(frames);
    } catch (error) {
      thinking.error = String(error && error.message ? error.message : error);
    }
    // 首句实义等的是真台词：占位气泡若被算成首句，first_bubble_ms 会变成假的 0 ms
    await cdp.waitFor(REPLY_BUBBLE, TURN_TIMEOUT_MS, "first reply bubble");
    const turn = {
      index: index + 1,
      prompt: prompt,
      first_bubble_ms: Date.now() - start,
      first_text: await cdp.evaluate(BUBBLE_TEXT),
      is_error: await cdp.evaluate(IS_ERROR_BUBBLE),
      thinking_ms: thinking.ms,
      thinking_frames: thinking.frames,
      thinking_error: thinking.error,
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
  // 思考气泡判据（T2.2）：每轮都出现、且采样到的文字只在 · / ·· / ··· 里。
  // 不能用 thinking_ms > 0 判——waitFor 第一次轮询就命中时返回 0，那正是「立刻出现」的正常快路径；
  // 「没出现」由 thinking_error 记（超时抛错，error 非空）。
  const thinkingOk = report.turns.every(
    (turn) =>
      turn.thinking_error === "" &&
      Array.isArray(turn.thinking_frames) &&
      turn.thinking_frames.length > 0 &&
      turn.thinking_frames.every((frame) => THINKING_DOTS.includes(frame)),
  );
  report.thinking_ok = thinkingOk;
  report.ok =
    report.turns.length === TURNS &&
    report.turns.every((turn) => turn.first_text.length > 0 && !turn.is_error) &&
    interruptOk &&
    thinkingOk;
  socket.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(2);
});
