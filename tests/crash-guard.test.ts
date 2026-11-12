/**
 * 文件职责：崩溃兜底的纯逻辑单测（错误单行化、渲染进程重载预算、提示冷却）。
 *
 * 为什么这些用例重要：兜底代码平时不跑，一旦跑起来就是「程序已经出问题」的时候，
 * 它自己再写错就等于二次伤害——尤其是预算算错会导致无限重载（闪烁风暴）或一次都不恢复。
 * 依赖方向：tests -> app/main/crash-guard.ts（纯逻辑，无 IO、不 import electron）。
 */
import { describe, expect, it } from "vitest";

import {
  CrashGuard,
  describeError,
  describeRendererReason,
  isHarmlessChildProcess,
} from "../app/main/crash-guard";

describe("describeError", () => {
  it("只取首行并截断，避免把堆栈塞进日志字段与托盘气泡", () => {
    expect(describeError(new Error("连接被拒绝\n    at foo"))).toBe("连接被拒绝");
    const long = "x".repeat(300);
    const text = describeError(long);
    expect(text.length).toBe(201);
    expect(text.endsWith("…")).toBe(true);
  });

  it("非 Error 的 rejection 也能读出内容", () => {
    expect(describeError("字符串原因")).toBe("字符串原因");
    expect(describeError({ code: 500 })).toBe('{"code":500}');
    expect(describeError(undefined)).toBe("（无错误信息）");
  });
});

describe("describeRendererReason", () => {
  it("已知原因给中文，未知原因保留原文以便对照日志", () => {
    expect(describeRendererReason("oom")).toBe("显存或内存不足");
    expect(describeRendererReason("weird-thing")).toContain("weird-thing");
  });

  it("GPU 崩溃视为可自恢复，不打扰用户", () => {
    expect(isHarmlessChildProcess("GPU")).toBe(true);
    expect(isHarmlessChildProcess("Utility")).toBe(false);
  });
});

describe("CrashGuard", () => {
  it("主进程异常不阻断，但连续 3 次后升级提示口径", () => {
    const guard = new CrashGuard();
    const first = guard.recordMainCrash("uncaughtException", new Error("boom"));
    expect(first.message).toContain("程序继续运行");
    expect(first.event).toBe("app.uncaught_exception");
    guard.recordMainCrash("unhandledRejection", new Error("boom"));
    const third = guard.recordMainCrash("unhandledRejection", new Error("boom"));
    expect(third.message).toContain("连续出现 3 次");
    expect(guard.snapshot().mainCrashCount).toBe(3);
  });

  it("渲染进程崩溃按预算重载，超出预算改为放弃并给出出路", () => {
    let now = 1_000_000;
    const guard = new CrashGuard({ now: () => now });
    const first = guard.recordRendererGone({ reason: "crashed", exitCode: 5 });
    expect(first.action).toBe("reload");
    expect(first.notice.message).toContain("已自动重新加载");

    now += 1000;
    expect(guard.recordRendererGone({ reason: "crashed" }).action).toBe("reload");
    now += 1000;
    expect(guard.recordRendererGone({ reason: "oom" }).action).toBe("reload");

    now += 1000;
    const fourth = guard.recordRendererGone({ reason: "crashed" });
    expect(fourth.action).toBe("give-up");
    expect(fourth.notice.message).toContain("已停止自动恢复");
  });

  it("超出窗口期的旧崩溃不计入预算", () => {
    let now = 0;
    const guard = new CrashGuard({
      now: () => now,
      rendererRestartWindowMs: 1000,
      maxRendererRestarts: 1,
    });
    expect(guard.recordRendererGone({ reason: "crashed" }).action).toBe("reload");
    now = 5000; // 窗口早已滑过去，旧记录应当被丢掉
    expect(guard.recordRendererGone({ reason: "crashed" }).action).toBe("reload");
  });

  it("正常关闭不算崩溃，也不占预算", () => {
    const guard = new CrashGuard({ maxRendererRestarts: 0 });
    const result = guard.recordRendererGone({ reason: "clean-exit", exitCode: 0 });
    expect(result.action).toBe("none");
    expect(guard.snapshot().rendererRestarts).toBe(0);
  });

  it("同一事件的提示有冷却，但不同事件互不影响", () => {
    let now = 0;
    const guard = new CrashGuard({ now: () => now, notifyCooldownMs: 1000 });
    expect(guard.shouldNotify("app.renderer_gone")).toBe(true);
    expect(guard.shouldNotify("app.renderer_gone")).toBe(false);
    expect(guard.shouldNotify("app.preload_error")).toBe(true);
    now = 2000;
    expect(guard.shouldNotify("app.renderer_gone")).toBe(true);
  });

  it("恢复后可以清零预算，再崩一次仍允许重载", () => {
    let now = 1_000_000;
    const guard = new CrashGuard({ now: () => now });
    for (let i = 0; i < 3; i += 1) {
      now += 1000;
      expect(guard.recordRendererGone({ reason: "crashed" }).action).toBe("reload");
    }
    now += 1000;
    expect(guard.recordRendererGone({ reason: "crashed" }).action).toBe("give-up");
    guard.resetRendererBudget();
    now += 1000;
    expect(guard.recordRendererGone({ reason: "crashed" }).action).toBe("reload");
  });
});
