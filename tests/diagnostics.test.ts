import { describe, expect, it } from "vitest";

import {
  buildDiagnosticsReport,
  redactSecrets,
  tailLines,
  type DiagnosticsInput,
} from "../app/main/diagnostics";

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    version: "0.2.0",
    isDev: false,
    platform: "win32",
    arch: "x64",
    versions: { electron: "44.7.0", node: "22.9.0", chrome: "140.0.0.0" },
    dataDir: "D:\\deskpet\\data",
    logsDir: "D:\\deskpet\\data\\logs",
    llmConfigured: false,
    asrModelDir: "",
    sidecarPort: 8737,
    engineState: "ready",
    crashes: { mainCrashCount: 0, rendererRestarts: 0 },
    recentLogLines: [],
    ...overrides,
  };
}

describe("redactSecrets", () => {
  it("盖掉各家 sk- key、Bearer 与 query token", () => {
    expect(redactSecrets("key=sk-abcdef123456")).not.toContain("abcdef123456");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redactSecrets("ws://127.0.0.1:8737/voice?token=deadbeef")).not.toContain("deadbeef");
  });

  it("保留字段名，方便对照配置项", () => {
    expect(redactSecrets('api_key="supersecret"')).toBe('api_key="***"');
  });

  it("不把普通日志内容误伤成空行", () => {
    const line = '{"event":"app.start","msg":"deskpet 主进程启动"}';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe("tailLines", () => {
  it("取最后 N 行并丢掉尾部换行切出的空串", () => {
    expect(tailLines("a\nb\nc\n", 2)).toEqual(["b", "c"]);
    expect(tailLines("a\nb", 5)).toEqual(["a", "b"]);
  });
});

describe("buildDiagnosticsReport", () => {
  it("把排查需要的字段按顺序拼出来", () => {
    const report = buildDiagnosticsReport(input({ engineState: "failed：sidecar 未就绪" }));
    expect(report).toContain("版本：0.2.0");
    expect(report).toContain("win32/x64");
    expect(report).toContain("引擎：状态 failed：sidecar 未就绪 · 端口 8737");
    expect(report).toContain("LLM 端点：未配置");
    expect(report).toContain("ASR 模型目录：（未配置）");
  });

  it("只带最后 40 行日志，且超长行被截断", () => {
    const lines = Array.from({ length: 60 }, (_, index) => "line" + String(index));
    lines.push("x".repeat(500));
    const report = buildDiagnosticsReport(input({ recentLogLines: lines }));
    expect(report).toContain("最后 40 行");
    expect(report).not.toContain("line20");
    expect(report).toContain("line21");
    expect(report).not.toContain("x".repeat(400));
  });

  it("报告里不出现密钥（这是它存在的意义）", () => {
    const report = buildDiagnosticsReport(
      input({ recentLogLines: ['{"msg":"calling","key":"sk-abcdef123456"}'] }),
    );
    expect(report).not.toContain("abcdef123456");
    expect(report).toContain("sk-***");
  });

  it("没有日志时说清楚读不到，而不是留一段空白", () => {
    expect(buildDiagnosticsReport(input())).toContain("最近日志：（读不到）");
  });
});
