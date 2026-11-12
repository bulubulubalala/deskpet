/**
 * 文件职责：进程级崩溃兜底——把「未捕获异常 / 未处理 rejection / 渲染进程崩溃 / 预加载失败」
 * 收敛成「一条日志 + 一次用户可见的提示」，并按预算决定要不要自动恢复渲染进程。
 *
 * 为什么需要它：默认情况下主进程里一个未捕获异常会直接把进程杀掉，用户看到的是窗口凭空消失；
 * 渲染进程崩溃时窗口会僵在那里，没有任何提示，用户只会说「它坏了」。兜底的目标不是假装没事，
 * 而是三件事：① 进程别死；② 用户知道发生了什么、下一步能点什么；③ 现场进日志，事后能查。
 *
 * 为什么自动恢复要设预算：Live2D / GPU 驱动导致的崩溃经常是「一崩就再崩」，
 * 无限 reload 会变成闪烁风暴，反而比停在冻结画面更糟。超过预算就停下来找人，
 * 与心跳的「重启预算用尽即判死」同一个口径（需求 §7.2 / §6.7）。
 *
 * 依赖方向：只依赖 node 标准库的类型，不 import electron——这样才能在 vitest 里直接跑（同 logger.ts / heartbeat.ts）。
 * 谁调用：app/main/index.ts 在模块加载期装 process 钩子，在 whenReady 之后装 app 钩子。
 */

export type CrashScope = "main" | "renderer" | "child";

export interface CrashNotice {
  /** 哪一层出的问题；渲染层与子进程的问题不会让主进程退出，但要让用户知道。 */
  readonly scope: CrashScope;
  /** 日志 event 名，与 sidecar 的 app.* 前缀保持同一套命名。 */
  readonly event: string;
  /** 面向用户的一句话（会出现在托盘气泡里，不要放堆栈）。 */
  readonly message: string;
  /** 进日志的原始信息（堆栈首行 / 退出原因），可以在里面放细节。 */
  readonly detail: string;
}

export interface RendererGoneDetails {
  /** Electron 的 RenderProcessGoneDetails.reason：clean-exit / crashed / oom / killed / launch-failed / integrity-failure。 */
  readonly reason: string;
  readonly exitCode?: number;
}

export type RendererRecovery =
  | { readonly action: "reload"; readonly notice: CrashNotice }
  | { readonly action: "give-up"; readonly notice: CrashNotice }
  | { readonly action: "none"; readonly notice: CrashNotice };

export interface CrashGuardOptions {
  /** 渲染进程在窗口期内最多自动恢复几次，超过即放弃（给人看，不硬撑）。 */
  readonly maxRendererRestarts: number;
  /** 预算的统计窗口。 */
  readonly rendererRestartWindowMs: number;
  /** 同一种问题在这个间隔内只弹一次提示，避免崩溃风暴刷屏。 */
  readonly notifyCooldownMs: number;
  /** 时间源，测试里可以固定。 */
  readonly now: () => number;
}

const DEFAULT_OPTIONS: CrashGuardOptions = {
  maxRendererRestarts: 3,
  rendererRestartWindowMs: 5 * 60 * 1000,
  notifyCooldownMs: 60 * 1000,
  now: () => Date.now(),
};

/** 单行化 + 截断：日志是单行 JSON，气泡也放不下堆栈；首行通常就是「什么错」。 */
export function describeError(value: unknown): string {
  // undefined/null 不是“错误内容为空”，而是“压根没带信息”，两者文案不同。
  if (value === undefined || value === null) {
    return "（无错误信息）";
  }
  let raw: string;
  if (value instanceof Error) {
    raw = value.message.trim() === "" ? value.name : value.message;
  } else if (typeof value === "string") {
    raw = value;
  } else {
    // JSON.stringify 对 undefined/函数返回 undefined，对循环引用直接抛错。
    // 这两种情况退化成类型名，比 "[object Object]" 至少能看出是什么东西。
    try {
      raw = JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      raw = Object.prototype.toString.call(value);
    }
  }
  const firstLine = (raw.split("\n")[0] ?? "").trim();
  const text = firstLine === "" ? "（无错误信息）" : firstLine;
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}

/** 把 Electron 的 reason 翻成用户能看懂的说法；未知原因原样保留，方便对照日志与官方文档。 */
export function describeRendererReason(reason: string): string {
  switch (reason) {
    case "crashed":
      return "渲染进程崩溃";
    case "oom":
      return "显存或内存不足";
    case "killed":
      return "渲染进程被系统结束";
    case "launch-failed":
      return "渲染进程启动失败";
    case "integrity-failure":
      return "代码完整性校验失败";
    case "clean-exit":
      return "界面正常关闭";
    default:
      return "渲染进程退出（" + reason + "）";
  }
}

/** GPU 子进程崩溃是 Electron 的常见现象且会自恢复，只记账、不打扰用户。 */
export function isHarmlessChildProcess(type: string): boolean {
  return type === "GPU";
}

export class CrashGuard {
  private readonly options: CrashGuardOptions;
  private readonly rendererRestarts: number[] = [];
  private readonly notifiedAt = new Map<string, number>();
  private mainCrashCount = 0;

  constructor(options: Partial<CrashGuardOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 主进程的未捕获异常：进程继续跑，但要让用户与日志都知道出过事。 */
  recordMainCrash(
    kind: "uncaughtException" | "unhandledRejection",
    error: unknown,
    at: number = this.options.now(),
  ): CrashNotice {
    void at;
    this.mainCrashCount += 1;
    const what = kind === "uncaughtException" ? "未捕获异常" : "未处理的 Promise 拒绝";
    const message =
      this.mainCrashCount >= 3
        ? "主进程已连续出现 " +
          this.mainCrashCount +
          " 次" +
          what +
          "，部分功能可能不正常；建议从托盘重启 deskpet。"
        : "后台逻辑出现" + what + "（已记录日志，程序继续运行）。";
    return {
      scope: "main",
      event: kind === "uncaughtException" ? "app.uncaught_exception" : "app.unhandled_rejection",
      message,
      detail: describeError(error),
    };
  }

  /** 渲染进程退出：决定重载还是放弃。clean-exit 不算崩溃（通常是窗口被正常销毁）。 */
  recordRendererGone(
    details: RendererGoneDetails,
    at: number = this.options.now(),
  ): RendererRecovery {
    const detail =
      details.exitCode === undefined
        ? details.reason
        : details.reason + "（exitCode=" + String(details.exitCode) + "）";
    if (details.reason === "clean-exit") {
      return {
        action: "none",
        notice: {
          scope: "renderer",
          event: "app.renderer_clean_exit",
          message: "界面已正常关闭。",
          detail,
        },
      };
    }
    this.rendererRestarts.push(at);
    this.pruneRestarts(at);
    const used = this.rendererRestarts.length;
    const what = describeRendererReason(details.reason);
    if (used > this.options.maxRendererRestarts) {
      const minutes = Math.max(1, Math.round(this.options.rendererRestartWindowMs / 60000));
      return {
        action: "give-up",
        notice: {
          scope: "renderer",
          event: "app.renderer_gone_fatal",
          message:
            "界面在 " +
            String(minutes) +
            " 分钟内崩溃 " +
            String(used) +
            " 次，已停止自动恢复。" +
            "可以从托盘「重启后台引擎」或重新打开 deskpet；日志在 data/logs。",
          detail,
        },
      };
    }
    return {
      action: "reload",
      notice: {
        scope: "renderer",
        event: "app.renderer_gone",
        message: what + "，已自动重新加载界面。",
        detail,
      },
    };
  }

  /** 子进程（GPU / Utility / Pepper 插件）退出：只记账，GPU 崩溃不打扰用户。 */
  recordChildGone(type: string, reason: string, at: number = this.options.now()): CrashNotice {
    void at;
    return {
      scope: "child",
      event: "app.child_process_gone",
      message: "子进程（" + type + "）退出：" + reason,
      detail: type + "/" + reason,
    };
  }

  /** preload 抛异常等于白屏，必须让用户看到；但重载也没用，所以只提示不重启。 */
  recordPreloadError(file: string, error: unknown, at: number = this.options.now()): CrashNotice {
    void at;
    return {
      scope: "renderer",
      event: "app.preload_error",
      message: "界面脚本加载失败（" + file + "），请尝试重启 deskpet；日志在 data/logs。",
      detail: describeError(error),
    };
  }

  /** 同一种问题在冷却期内只提示一次；日志不受冷却影响，由调用方每次都写。 */
  shouldNotify(event: string, at: number = this.options.now()): boolean {
    const last = this.notifiedAt.get(event);
    if (last !== undefined && at - last < this.options.notifyCooldownMs) {
      return false;
    }
    this.notifiedAt.set(event, at);
    return true;
  }

  /** 渲染进程恢复正常后清空预算，下次崩溃重新开始计数。 */
  resetRendererBudget(): void {
    this.rendererRestarts.length = 0;
  }

  snapshot(): { readonly mainCrashCount: number; readonly rendererRestarts: number } {
    return { mainCrashCount: this.mainCrashCount, rendererRestarts: this.rendererRestarts.length };
  }

  private pruneRestarts(at: number): void {
    const floor = at - this.options.rendererRestartWindowMs;
    while (this.rendererRestarts.length > 0 && (this.rendererRestarts[0] ?? 0) < floor) {
      this.rendererRestarts.shift();
    }
  }
}
