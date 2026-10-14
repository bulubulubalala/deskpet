/**
 * 文件职责：拉起 / 结束 sidecar 子进程，并等它写出 runtime.json（端口握手，需求 §6.10）。
 *
 * 为什么端口要从文件里读而不读子进程 stdout：.venv 的 python.exe 是 launcher，它会再造一层
 * 子进程，stdout 混着两层输出（T0.5 实测 Popen 40128 / runtime.json 39076），文件才是稳定通道。
 * 为什么结束进程用 taskkill /T：同上，只 kill 拿到的那个句柄会留下孤儿 sidecar 占着端口。
 * 依赖方向：main -> node:child_process + ./runtime-file + ./config + ./logger；不 import electron。
 * 谁调用：app/main/index.ts 装配出实例，app/main/engine.ts 只通过 SidecarController 接口用它。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import type { MainConfig } from "./config";
import { toErrorMessage } from "./errors";
import type { MainLogger } from "./logger";
import { isProcessAlive, readRuntime, waitForRuntime, type SidecarRuntime } from "./runtime-file";

/** sidecar 的启动方式（可执行文件 + 参数 + 工作目录）。 */
export interface SidecarCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** taskkill 自身的等待上限：退出流程不能被清理动作卡住。 */
const KILL_TIMEOUT_MS = 3000;

/**
 * 开发模式跑仓库里的源码（.venv 里的解释器）；打包后跑 PyInstaller onedir 产出的 sidecar.exe（T0.8）。
 * 两条路径都从 config 推导，避免「开发能跑、打包找不到文件」这类只在发布时才暴露的分叉。
 */
export function resolveSidecarCommand(config: MainConfig): SidecarCommand {
  if (config.isDev) {
    return {
      file: join(config.appRoot, ".venv", "Scripts", "python.exe"),
      args: [join("sidecar", "main.py")],
      cwd: config.appRoot,
    };
  }
  return {
    file: join(config.resourcesRoot, "sidecar", "sidecar.exe"),
    args: [],
    cwd: config.resourcesRoot,
  };
}

/** 结束整棵进程树；无论成败都返回，绝不抛（退出路径上没人在意 taskkill 的退出码）。 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    const timer = setTimeout(() => {
      killer.kill();
      resolve();
    }, KILL_TIMEOUT_MS);
    killer.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface SidecarProcessDeps {
  readonly config: MainConfig;
  readonly logger: MainLogger;
  /** 注入点：测试里换成 fake，避免真的起进程。 */
  readonly spawnFn?: typeof spawn;
  readonly killFn?: (pid: number) => Promise<void>;
}

export class SidecarProcess {
  private readonly config: MainConfig;
  private readonly logger: MainLogger;
  private readonly spawnFn: typeof spawn;
  private readonly killFn: (pid: number) => Promise<void>;
  private child: ChildProcess | null = null;
  private current: SidecarRuntime | null = null;

  constructor(deps: SidecarProcessDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.spawnFn = deps.spawnFn ?? spawn;
    this.killFn = deps.killFn ?? killProcessTree;
  }

  /** 当前已握手成功的 sidecar 信息；未起来时为 null。 */
  get runtime(): SidecarRuntime | null {
    return this.current;
  }

  /** 启动并完成端口握手；握手失败会先清理进程再抛错（不留半死的 sidecar 占端口）。 */
  async start(): Promise<SidecarRuntime> {
    await this.stop();
    await this.clearStaleRuntimeFile();
    const command = resolveSidecarCommand(this.config);
    mkdirSync(this.config.logsDir, { recursive: true });
    const logFd = openSync(this.config.sidecarLogFile, "a");
    let child: ChildProcess;
    try {
      child = this.spawnFn(command.file, [...command.args], {
        cwd: command.cwd,
        windowsHide: true,
        // sidecar 的 stdout/stderr 直接进它自己的日志文件（与主进程日志分开，两个进程不抢句柄）
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          DESKPET_DATA_DIR: this.config.dataDir,
          DESKPET_SIDECAR_HOST: this.config.host,
          DESKPET_SIDECAR_PORT: String(this.config.preferredPort),
          DESKPET_LOG_LEVEL: process.env["DESKPET_LOG_LEVEL"] ?? "info",
        },
      });
    } finally {
      // 子进程已复制该句柄，父进程这份必须关掉，否则每次重启都漏一个 fd
      closeSync(logFd);
    }
    this.child = child;
    child.on("exit", (code, signal) => {
      this.logger.warn("sidecar.exit", "sidecar 进程退出", {
        pid: child.pid ?? -1,
        code: code ?? -1,
        signal: signal ?? "",
      });
      this.current = null;
    });
    child.on("error", (error: Error) => {
      this.logger.error("sidecar.spawn_failed", "sidecar 进程启动失败：" + toErrorMessage(error), {
        file: command.file,
      });
    });
    this.logger.info("sidecar.spawn", "已拉起 sidecar 进程", {
      pid: child.pid ?? -1,
      file: command.file,
      preferredPort: this.config.preferredPort,
    });
    try {
      const runtime = await waitForRuntime(this.config.runtimePath, {
        timeoutMs: this.config.handshakeTimeoutMs,
        intervalMs: this.config.handshakeIntervalMs,
      });
      this.current = runtime;
      this.logger.info("sidecar.handshake", "端口握手成功", {
        pid: runtime.pid,
        host: runtime.host,
        port: runtime.port,
        version: runtime.version,
      });
      return runtime;
    } catch (error) {
      this.logger.error("sidecar.handshake_failed", "端口握手失败：" + toErrorMessage(error), {
        pid: child.pid ?? -1,
        runtimePath: this.config.runtimePath,
      });
      await this.stop();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * 结束 sidecar：优先按 runtime.json 里的 pid 结束整棵树（那才是真正的解释器进程），
   * 拿不到 runtime 才退回到启动句柄的 pid。
   */
  async stop(): Promise<void> {
    const pid = this.current?.pid ?? this.child?.pid ?? null;
    this.child = null;
    this.current = null;
    if (pid !== null) {
      this.logger.info("sidecar.stop", "正在结束 sidecar 进程树", { pid });
      await this.killFn(pid);
    }
    await this.removeRuntimeFile();
  }

  /**
   * 启动前处理陈旧 runtime.json（T0.5 实测：硬杀 sidecar 时它的 finally 跑不到，文件会残留）。
   * 规则：文件里的 pid 还活着就先结束它，然后一律删文件——绝不拿旧端口去连。
   */
  private async clearStaleRuntimeFile(): Promise<void> {
    const stale = await readRuntime(this.config.runtimePath);
    if (stale !== null && isProcessAlive(stale.pid)) {
      this.logger.warn("sidecar.stale_runtime", "发现有残留的 sidecar 进程，先结束它", {
        pid: stale.pid,
        port: stale.port,
      });
      await this.killFn(stale.pid);
    }
    await this.removeRuntimeFile();
  }

  private async removeRuntimeFile(): Promise<void> {
    try {
      await rm(this.config.runtimePath, { force: true });
    } catch (error) {
      this.logger.warn(
        "sidecar.runtime_cleanup_failed",
        "删除 runtime.json 失败：" + toErrorMessage(error),
      );
    }
  }
}
