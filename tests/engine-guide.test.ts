import { describe, expect, it } from "vitest";

import { describeEngineFailure, normalizeReason } from "../app/renderer/engine-guide";

const HINT = "点这里打开设置检查模型与接口；详细日志在托盘菜单「打开日志目录」。";

describe("describeEngineFailure", () => {
  it("非 failed 状态不提示", () => {
    expect(describeEngineFailure({ state: "online" })).toBeNull();
    expect(describeEngineFailure({ state: "restarting", last_error: "x" })).toBeNull();
    expect(describeEngineFailure({ state: "offline" })).toBeNull();
  });

  it("带原因与重启次数", () => {
    const text = describeEngineFailure({
      state: "failed",
      last_error: "WinError 2 系统找不到指定的文件",
      restarts_used: 3,
    });
    expect(text).toContain("后台引擎启动失败：");
    expect(text).toContain("已自动重启 3 次");
    expect(text).toContain("引擎文件缺失");
    expect(text).toContain(HINT);
  });

  it("没有原因与重启次数时也给一句能读的完整话", () => {
    expect(describeEngineFailure({ state: "failed", last_error: null, restarts_used: 0 })).toBe(
      "后台引擎启动失败。" + HINT,
    );
  });

  it("原因只取第一行", () => {
    const text = describeEngineFailure({
      state: "failed",
      last_error: 'Traceback (most recent call last):\n  File "x.py"',
    });
    expect(text).toContain("Traceback (most recent call last):");
    expect(text).not.toContain("x.py");
  });
});

describe("normalizeReason", () => {
  it("空值与空白返回空串", () => {
    expect(normalizeReason(null)).toBe("");
    expect(normalizeReason(undefined)).toBe("");
    expect(normalizeReason("   \n  ")).toBe("");
  });

  it("超长原因截断并加省略号", () => {
    const long = "x".repeat(300);
    const result = normalizeReason(long);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBe(121);
  });

  it("端口冲突与超时给出人话", () => {
    expect(normalizeReason("listen failed: EADDRINUSE 8737")).toContain("端口被占用");
    expect(normalizeReason("startup timed out after 20000ms")).toContain("启动超时");
  });
});
