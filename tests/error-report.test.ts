import { describe, expect, it } from "vitest";

import { buildErrorReport } from "../app/renderer/error-report";

describe("buildErrorReport", () => {
  it("包含排查所需的全部字段", () => {
    const report = buildErrorReport({
      at: "2026-11-11T12:00:00.000Z",
      appVersion: "0.2.0",
      engineVersion: "0.2.0",
      code: "DP-LLM-004",
      hint: "模型服务返回 HTTP 500",
      detail: {
        message: "模型服务返回 HTTP 500",
        status: 500,
        body: '{"error":"boom"}',
        endpoint: "https://api.example.com/v1/chat",
        model: "demo",
        request_id: "req-1",
        attempts: 2,
      },
    });

    expect(report).toContain("DP-LLM-004");
    expect(report).toContain("HTTP 状态：500");
    expect(report).toContain("端点：https://api.example.com/v1/chat");
    expect(report).toContain("模型：demo");
    expect(report).toContain("请求 ID：req-1");
    expect(report).toContain("尝试次数：2");
    expect(report).toContain('{"error":"boom"}');
  });

  it("缺失字段用占位，不出现空行", () => {
    const report = buildErrorReport({
      at: "",
      appVersion: "0.2.0",
      engineVersion: "",
      code: "",
      hint: "",
      detail: {},
    });

    expect(report).toContain("提示：—");
    expect(report).toContain("HTTP 状态：—");
    expect(report).toContain("尝试次数：—");
    expect(report).toContain("（服务商没有返回内容）");
  });
});
