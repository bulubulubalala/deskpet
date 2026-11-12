/**
 * 文件职责：把「引擎启动失败」翻译成用户能看懂、能动作的一句话（M0：失败引导）。
 *
 * 为什么单独成文件：原先失败只体现为红点 + title 文案，用户既不知道为什么、
 * 也不知道下一步做什么；文案里的原因来自 /health.last_error，属于外部输入，
 * 需要截断与归类，纯函数便于单测，也避免把这段判断再塞进 1600 行的 index.ts。
 */
export interface EngineHealthLike {
  readonly state: string;
  readonly last_error?: string | null;
  readonly restarts_used?: number;
}

/** 原因只取第一行、最多这么长：last_error 里常带完整栈或多行输出，塞进横幅会顶掉聊天条。 */
const MAX_REASON_LENGTH = 120;
const ACTION_HINT = "点这里打开设置检查模型与接口；详细日志在托盘菜单「打开日志目录」。";

/**
 * 失败时返回横幅文案；其余状态返回 null（渲染层据此收起横幅）。
 *
 * 只对 failed 造句子：offline / restarting 是自动恢复中的中间态，弹提示会变成噪音。
 */
export function describeEngineFailure(view: EngineHealthLike): string | null {
  if (view.state !== "failed") {
    return null;
  }
  const reason = normalizeReason(view.last_error);
  const restarts = view.restarts_used ?? 0;
  const tries = restarts > 0 ? `（已自动重启 ${restarts} 次）` : "";
  const head =
    reason === "" ? `后台引擎启动失败${tries}。` : `后台引擎启动失败：${reason}${tries}。`;
  return head + ACTION_HINT;
}

/** 取第一行、去空白、超长截断，再把常见英文错误换成中文人话（原句保留，方便报障时搜索）。 */
export function normalizeReason(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return "";
  }
  const firstLine = (raw.split(/\r?\n/)[0] ?? "").trim();
  if (firstLine === "") {
    return "";
  }
  const short =
    firstLine.length > MAX_REASON_LENGTH ? firstLine.slice(0, MAX_REASON_LENGTH) + "…" : firstLine;
  return translateReason(short);
}

function translateReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("enoent") || reason.includes("找不到")) {
    return `引擎文件缺失（${reason}）`;
  }
  if (lower.includes("eaddrinuse") || reason.includes("端口被占用")) {
    return `端口被占用（${reason}）`;
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return `启动超时（${reason}）`;
  }
  return reason;
}
