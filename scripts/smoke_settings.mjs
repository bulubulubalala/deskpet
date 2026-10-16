/**
 * 文件职责：设置窗冒烟——驱动真实 Electron 打开设置窗（聊天条的「设置」按钮），核对两块面板真的通了：
 *   1) 「模型供给」：三个能力面卡片都渲染出来，点 LLM 卡片的「测试连接」能拿到结果行（IPC → sidecar → DOM）；
 *   2) 「记忆与统计」：能看到上一阶段写进去的事实，点「删除」后该条立刻消失（F3 验收 4 的界面路径）；
 *   3) 「清空该角色记忆」必须点两次：第一次只上膛（按钮文案变、列表不动），第二次才真清空；
 *   4) 「行为记忆」开关（T2.1c）在场且可用（只看不改，免得冒烟动到仓库根 .env）。
 *
 * 为什么先跑 tell 阶段：设置窗只能看与删，记忆必须由对话链路写入，所以入口脚本
 * （scripts/smoke_settings.ps1）先借 scripts/smoke_memory.mjs 的 tell 阶段造一条事实，再重开应用验设置窗。
 * 依赖：./lib/cdp.mjs。
 * 用法：node scripts/smoke_settings.mjs --port 9225 --expect 团子
 * 输出：一行 JSON 报告 + 退出码（0 = 断言通过）。
 */

import { argOf, connectPage, findPage, ONLINE, READY, sleep } from "./lib/cdp.mjs";

const args = process.argv.slice(2);

const PORT = Number(argOf(args, "--port", "9225"));
const EXPECT = argOf(args, "--expect", "团子");
const TARGET_TIMEOUT_MS = Number(argOf(args, "--timeout-ms", "60000"));
const PROBE_TIMEOUT_MS = Number(argOf(args, "--probe-timeout-ms", "90000"));
const EXPECT_JSON = JSON.stringify(EXPECT);

/** 选择器一律走 JSON.stringify 拼进表达式：源码里不出现转义引号，读起来也不容易错。 */
function queryAll(selector) {
  return "document.querySelectorAll(" + JSON.stringify(selector) + ")";
}

function queryOne(selector) {
  return "document.querySelector(" + JSON.stringify(selector) + ")";
}

function byId(id) {
  return "document.getElementById(" + JSON.stringify(id) + ")";
}

const CARDS = queryAll("#providers-list .provider-card");
const ROWS = queryAll("#memory-list article.memory") + ".length";
// 必须带 li.probe：占位行「正在探测…」也是 li，只等 li 会在点击后 2ms 就「通过」。
const LLM_PROBES =
  queryAll("#providers-list .provider-card[data-capability=llm] .probe-results li.probe") +
  ".length";
const LLM_PROBE_CLASSES =
  "Array.from(" +
  queryAll("#providers-list .provider-card[data-capability=llm] .probe-results li.probe") +
  ").map(function(li){return String(li.className)})";
const LIST_TEXT = "String(" + byId("memory-list") + ".textContent)";
const ARMED_TEXT = "String(" + byId("memory-clear") + ".textContent)";
const BANNER_TEXT = "String(" + byId("settings-banner") + ".textContent)";
// T2.1c 行为记忆开关：只核对“在场且可用”，不读也不写它的勾选值——脚本跑在仓库根 .env 上，
// 不该因为一次冒烟就把用户自己的开关改掉。
const BEHAVIOR_PRESENT = byId("memory-behavior") + " !== null";
const BEHAVIOR_STATE =
  "(function(){var b=" +
  byId("memory-behavior") +
  ";if(!b)return null;" +
  "return {present:true,checked:Boolean(b.checked),disabled:Boolean(b.disabled)};})()";
/**
 * 失败时的现场快照：桥有没有注入、卡片/行数是哪一层没出来、面板自己的报错文案。
 * 只用在 catch 里，正常路径不读它。
 */
const DIAGNOSTICS =
  "(function(){return JSON.stringify({" +
  "bridge:typeof window.deskpet," +
  'cards:document.querySelectorAll("#providers-list .provider-card").length,' +
  'rows:document.querySelectorAll("#memory-list article.memory").length,' +
  'banner:String((document.getElementById("settings-banner")||{}).textContent||"")});})()';

/** 点聊天条上的「设置」，再等设置窗的 CDP 目标出现。 */
async function openSettings(mainCdp) {
  const clicked = await mainCdp.evaluate(
    "(function(){var b=" +
      byId("settings-button") +
      ";if(!b)return false;b.click();return true;})()",
  );
  if (clicked !== true) {
    throw new Error("找不到聊天条上的设置按钮");
  }
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const target = await findPage(PORT, "settings.html");
    if (target) {
      return target;
    }
    await sleep(200);
  }
  throw new Error("设置窗没有打开：CDP 目标里找不到 settings.html");
}

async function main() {
  const started = Date.now();
  const mainPage = await connectPage(PORT);
  const report = { ok: false, port: PORT, expect: EXPECT, errors: [] };
  let settingsSocket = null;
  let settingsCdp = null;
  try {
    await mainPage.cdp.waitFor(READY, TARGET_TIMEOUT_MS, "renderer ready");
    // 设置窗的「模型供给」要先有 sidecar 才读得到：等健康灯 online 再点「设置」，
    // 否则 providers.get() 一次失败就没有重试入口，卡片永远不渲染（真机第一跑就踩到了）。
    await mainPage.cdp.waitFor(ONLINE, TARGET_TIMEOUT_MS, "sidecar online");
    await openSettings(mainPage.cdp);
    report.settings_opened_ms = Date.now() - started;
    const settings = await connectPage(PORT, "settings.html");
    settingsSocket = settings.socket;
    settingsCdp = settings.cdp;

    // 1) 模型供给：三张卡片 + 每张一个「测试连接」
    const cardsMs = await settings.cdp.waitFor(
      CARDS + ".length >= 3",
      TARGET_TIMEOUT_MS,
      "provider cards",
    );
    const capabilities = await settings.cdp.evaluate(
      "Array.from(" + CARDS + ").map(function(c){return String(c.dataset.capability)})",
    );
    const testButtons = await settings.cdp.evaluate(
      queryAll("#providers-list button[data-role=test]") + ".length",
    );
    const probeClicked = await settings.cdp.evaluate(
      "(function(){var c=" +
        queryOne("#providers-list .provider-card[data-capability=llm]") +
        ";if(!c)return false;var b=c.querySelector(" +
        JSON.stringify("button[data-role=test]") +
        ");if(!b)return false;b.click();return true;})()",
    );
    const probesMs = await settings.cdp.waitFor(
      LLM_PROBES + " >= 1",
      PROBE_TIMEOUT_MS,
      "llm probe result",
    );
    const llmProbes = await settings.cdp.evaluate(
      "Array.from(" +
        LLM_PROBES.replace(".length", "") +
        ").map(function(li){return String(li.textContent)})",
    );
    const llmProbeClasses = await settings.cdp.evaluate(LLM_PROBE_CLASSES);

    // 2) 记忆：上一阶段写进去的事实要看得见，删掉后立刻消失
    // 行为记忆开关（T2.1c）与记忆列表各自加载，先各自等到位再断言。
    await settings.cdp.waitFor(BEHAVIOR_PRESENT, 30000, "behavior checkbox");
    const rawBehavior = await settings.cdp.evaluate(BEHAVIOR_STATE);
    const behavior =
      rawBehavior === null || typeof rawBehavior !== "object"
        ? { present: false, checked: null, disabled: null }
        : rawBehavior;
    await settings.cdp.waitFor(ROWS + " >= 1", 30000, "memory rows");
    const rowsBefore = await settings.cdp.evaluate(ROWS);
    const listBefore = await settings.cdp.evaluate(LIST_TEXT);
    const found = listBefore.indexOf(EXPECT) >= 0;
    const deleteClicked = await settings.cdp.evaluate(
      "(function(){var rows=Array.prototype.slice.call(" +
        queryAll("#memory-list article.memory") +
        ");for(var i=0;i<rows.length;i++){var row=rows[i];var t=String(row.querySelector(" +
        JSON.stringify(".memory-text") +
        ").textContent);if(t.indexOf(" +
        EXPECT_JSON +
        ")>=0){var b=row.querySelector(" +
        JSON.stringify("button") +
        ");if(!b)return false;b.click();return true;}}return false;})()",
    );
    await settings.cdp.waitFor(
      "(" + LIST_TEXT + ").indexOf(" + EXPECT_JSON + ") < 0",
      30000,
      "deleted memory gone",
    );
    const rowsAfterDelete = await settings.cdp.evaluate(ROWS);

    // 3) 清空要点两次：第一次只上膛，列表一条都不许少
    await settings.cdp.evaluate(
      "(function(){var b=" +
        byId("memory-clear") +
        ";if(!b)return false;b.click();return true;})()",
    );
    await sleep(300);
    const armedText = await settings.cdp.evaluate(ARMED_TEXT);
    const rowsWhileArmed = await settings.cdp.evaluate(ROWS);
    const armedOk = armedText.indexOf("再点一次") >= 0 && rowsWhileArmed === rowsAfterDelete;
    await settings.cdp.evaluate(
      "(function(){var b=" +
        byId("memory-clear") +
        ";if(!b)return false;b.click();return true;})()",
    );
    await settings.cdp.waitFor(ROWS + " === 0", 30000, "memory cleared");
    await settings.cdp.waitFor(
      "(" + BANNER_TEXT + ").indexOf(" + JSON.stringify("已清空") + ") >= 0",
      30000,
      "clear banner",
    );
    const banner = await settings.cdp.evaluate(BANNER_TEXT);

    report.providers = {
      cards_ms: cardsMs,
      capabilities: capabilities,
      test_buttons: testButtons,
      probe_clicked: probeClicked,
      probe_ms: probesMs,
      llm_probe: llmProbes,
      llm_probe_classes: llmProbeClasses,
    };
    report.memory = {
      rows_before: rowsBefore,
      expected_found: found,
      delete_clicked: deleteClicked,
      rows_after_delete: rowsAfterDelete,
      armed_text: armedText,
      armed_ok: armedOk,
      banner: banner,
      behavior: behavior,
    };
    report.ok =
      Array.isArray(capabilities) &&
      capabilities.indexOf("llm") >= 0 &&
      capabilities.indexOf("asr") >= 0 &&
      capabilities.indexOf("tts") >= 0 &&
      testButtons >= 3 &&
      probeClicked === true &&
      Array.isArray(llmProbes) &&
      llmProbes.length >= 1 &&
      Array.isArray(llmProbeClasses) &&
      llmProbeClasses.some((cls) => cls.includes("ok")) &&
      found &&
      deleteClicked === true &&
      rowsAfterDelete < rowsBefore &&
      armedOk &&
      behavior.present === true &&
      behavior.disabled === false;
  } catch (error) {
    report.errors.push(String(error && error.message ? error.message : error));
    if (settingsCdp !== null) {
      try {
        report.diagnostics = await settingsCdp.evaluate(DIAGNOSTICS);
      } catch {
        // 诊断拿不到就算了，别盖掉真正的错误。
      }
    }
  } finally {
    if (settingsSocket !== null) {
      settingsSocket.close();
    }
    mainPage.socket.close();
  }
  console.log(JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => process.exit(report.ok ? 0 : 1), 10000).unref();
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 2;
});
