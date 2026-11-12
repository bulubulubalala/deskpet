/**
 * 文件职责：生成「复制诊断信息」要放进剪贴板的那段文本。
 *
 * 为什么需要它：用户说「它坏了」时，能拿到的最小现场是「版本 + 系统 + 配置是否配好 + 最近几行日志」。
 * 以前这些信息散在托盘、设置窗、data/logs 三处，用户得手动拼；现在一个按钮换一段可粘贴的文本。
 *
 * 为什么纯函数：不 import electron、不读文件，输入全从参数进来——这样才能在 vitest 里断言
 * 「密钥不会出现在报告里」这种安全属性（脱敏是这段代码最重要的职责，不能靠肉眼）。
 *
 * 依赖方向：只依赖 node 标准库的字符串处理；由 app/main/index.ts 组装输入并写剪贴板。
 */

export interface DiagnosticsInput {
  readonly version: string;
  readonly isDev: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly versions: {
    readonly electron: string;
    readonly node: string;
    readonly chrome: string;
  };
  readonly dataDir: string;
  readonly logsDir: string;
  /** 只记「配没配」，不记 key 本身（§7.1 敏感信息禁入日志）。 */
  readonly llmConfigured: boolean;
  readonly asrModelDir: string;
  readonly sidecarPort: number;
  /** 例如 "ready" / "starting" / "failed：sidecar 未就绪"。 */
  readonly engineState: string;
  readonly crashes: {
    readonly mainCrashCount: number;
    readonly rendererRestarts: number;
  };
  /** 由调用方从日志文件尾部读出来；这里只负责脱敏与裁剪。 */
  readonly recentLogLines: readonly string[];
}

/** 报告里最多带几行日志：够看出「最后发生了什么」，又不至于让粘贴变成发文件。 */
const MAX_LOG_LINES = 40;
/** 单行上限：日志里偶尔有超长 JSON，整段贴出去反而没人看。 */
const MAX_LINE_LENGTH = 300;

const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // OpenAI 风格 key（含各家兼容实现的 sk-xxx）
  { pattern: /sk-[A-Za-z0-9_-]{6,}/g, replacement: "sk-***" },
  // Authorization: Bearer xxx
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi, replacement: "Bearer ***" },
  // token=xxx / api_key: "xxx" / authorization=xxx（保留字段名，只盖值）
  {
    pattern: /(token|api[_-]?key|authorization|secret|password)(\s*[=:]\s*"?)([^"\s,}]{4,})/gi,
    replacement: "$1$2***",
  },
  // sidecar 的 URL 里带 ?token=... 的形式
  { pattern: /([?&](?:token|key)=)[^&\s"]+/gi, replacement: "$1***" },
];

/** 把一段文本里的密钥形态替换掉；宁可多盖，不可漏盖。 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function clipLine(line: string): string {
  const single = line.replace(/\r?\n/g, " ").trimEnd();
  return single.length > MAX_LINE_LENGTH ? single.slice(0, MAX_LINE_LENGTH) + "…" : single;
}

/** 生成可直接粘贴给别人的诊断文本。字段顺序按「排查时先看什么」排。 */
export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const lines: string[] = [];
  lines.push("deskpet 诊断信息（生成于 " + new Date().toISOString() + "）");
  lines.push("");
  lines.push("版本：" + input.version + (input.isDev ? "（开发模式）" : ""));
  lines.push(
    "系统：" +
      input.platform +
      "/" +
      input.arch +
      " · Electron " +
      input.versions.electron +
      " · Chromium " +
      input.versions.chrome +
      " · Node " +
      input.versions.node,
  );
  lines.push("数据目录：" + input.dataDir);
  lines.push("日志目录：" + input.logsDir);
  lines.push("");
  lines.push("引擎：状态 " + input.engineState + " · 端口 " + String(input.sidecarPort));
  lines.push("LLM 端点：" + (input.llmConfigured ? "已配置" : "未配置"));
  lines.push("ASR 模型目录：" + (input.asrModelDir === "" ? "（未配置）" : input.asrModelDir));
  lines.push(
    "崩溃记录：主进程 " +
      String(input.crashes.mainCrashCount) +
      " 次 · 界面重载 " +
      String(input.crashes.rendererRestarts) +
      " 次",
  );
  lines.push("");
  if (input.recentLogLines.length === 0) {
    lines.push("最近日志：（读不到）");
  } else {
    const tail = input.recentLogLines.slice(-MAX_LOG_LINES).map(clipLine);
    lines.push("最近日志（最后 " + String(tail.length) + " 行，已脱敏）：");
    for (const line of tail) {
      lines.push("  " + line);
    }
  }
  return redactSecrets(lines.join("\n"));
}

/** 日志尾部读取用：把大文件切成「最后 N 行」而不是整读（日志可能已有几 MB）。 */
export function tailLines(text: string, count: number = MAX_LOG_LINES): string[] {
  const all = text.split(/\r?\n/);
  // 末尾换行会切出一个空串，丢掉它，否则报告里最后一行永远是空白。
  if (all.length > 0 && all[all.length - 1] === "") {
    all.pop();
  }
  return all.slice(-count);
}
