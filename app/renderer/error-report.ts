/**
 * 文件职责：把一次错误详情拼成可粘贴给开发者的文本（错误弹窗的「复制错误详情」）。
 *
 * 为什么单独成纯函数：复制内容里不能有敏感信息、也不能缺关键字段；把它从 DOM 里拆出来
 * 才能在 vitest 里断言「空字段不出现、顺序稳定」，而不是靠肉眼点一次弹窗。
 * 依赖方向：renderer 内部纯逻辑；只 import shared 的类型，不碰 window / DOM。
 */
import type { ErrorDetail } from "../shared/contracts/ipc";

export interface ErrorReportInput {
  readonly at: string;
  readonly appVersion: string;
  readonly engineVersion: string;
  readonly code: string;
  readonly hint: string;
  readonly detail: ErrorDetail;
}

/** 值缺失时给一个统一占位，避免复制出来是空行。 */
function valueOr(text: string | undefined, fallback = "—"): string {
  const trimmed = (text ?? "").trim();
  return trimmed === "" ? fallback : trimmed;
}

/** 拼出「复制错误详情」的文本；字段顺序按排查时先看什么排。 */
export function buildErrorReport(input: ErrorReportInput): string {
  const detail = input.detail;
  const status =
    detail.status === null || detail.status === undefined ? "—" : String(detail.status);
  const attempts =
    detail.attempts === undefined || detail.attempts <= 0 ? "—" : String(detail.attempts);
  const lines = [
    "deskpet 错误详情",
    "时间：" + valueOr(input.at),
    "版本：" + valueOr(input.appVersion) + " · 引擎 " + valueOr(input.engineVersion),
    "错误码：" + valueOr(input.code),
    "提示：" + valueOr(input.hint),
    "技术原文：" + valueOr(detail.message),
    "HTTP 状态：" + status,
    "端点：" + valueOr(detail.endpoint),
    "模型：" + valueOr(detail.model),
    "请求 ID：" + valueOr(detail.request_id),
    "尝试次数：" + attempts,
    "响应原文：",
    valueOr(detail.body, "（服务商没有返回内容）"),
  ];
  return lines.join("\n");
}
