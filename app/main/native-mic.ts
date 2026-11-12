/**
 * 文件职责：Chromium 麦克风不可用时，启动 sidecar 的原生采集 helper，并把 PCM 转给渲染层。
 *
 * 为什么走 sidecar：这台机器的 WASAPI 输入初始化会让 Chromium 报 NotReadableError，
 * 但 PortAudio 的 WDM-KS 回调能正常采集；sidecar 已有 Python 运行时，打包后直接复用
 * `sidecar.exe --mic-capture`，不需要再带一个 Node 原生模块。
 *
 * 协议：helper stdout 只写 48 kHz / 16-bit / 单声道裸 PCM；stderr 只写日志 / 错误。
 */

import { spawn, type ChildProcess } from "node:child_process";

import type { MainConfig } from "./config";
import type { MainLogger } from "./logger";
import { killProcessTree, resolveSidecarCommand } from "./sidecar-process";

export interface NativeMicStartResult {
  readonly ok: boolean;
  readonly error: string;
}

export interface NativeMicDeps {
  readonly config: MainConfig;
  readonly logger: MainLogger;
  readonly onAudio: (pcm: Uint8Array) => void;
  readonly onError: (message: string) => void;
}

export class NativeMicCapture {
  private child: ChildProcess | null = null;
  private stopping = false;
  private stderrTail = "";

  constructor(private readonly deps: NativeMicDeps) {}

  get running(): boolean {
    return this.child !== null;
  }

  async start(): Promise<NativeMicStartResult> {
    await this.stop();
    const command = resolveSidecarCommand(this.deps.config);
    const args = [...command.args, "--mic-capture"];
    this.stopping = false;
    this.stderrTail = "";
    let child: ChildProcess;
    try {
      child = spawn(command.file, args, {
        cwd: command.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...this.deps.config.childEnv,
          DESKPET_DATA_DIR: this.deps.config.dataDir,
          DESKPET_LOG_LEVEL: process.env["DESKPET_LOG_LEVEL"] ?? "info",
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error("native_mic.spawn_failed", "原生麦克风启动失败：" + message);
      return { ok: false, error: message };
    }
    this.child = child;
    this.deps.logger.info("native_mic.spawn", "启动原生麦克风 helper", {
      pid: child.pid ?? -1,
      file: command.file,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.deps.onAudio(new Uint8Array(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text === "") {
        return;
      }
      this.stderrTail = (this.stderrTail + "\n" + text).slice(-2000);
      this.deps.logger.debug("native_mic.stderr", text);
    });
    child.on("error", (error: Error) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      if (!this.stopping) {
        this.deps.onError("原生麦克风启动失败：" + error.message);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      if (!this.stopping) {
        const detail = this.stderrTail.split("\n").filter(Boolean).pop() ?? "";
        this.deps.onError(
          "原生麦克风已退出（" +
            String(code ?? signal ?? "unknown") +
            "）" +
            (detail ? "：" + detail : ""),
        );
      }
    });
    return { ok: true, error: "" };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) {
      return;
    }
    this.stopping = true;
    try {
      if (child.pid !== undefined) {
        await killProcessTree(child.pid);
      } else {
        child.kill();
      }
    } catch (error: unknown) {
      this.deps.logger.warn("native_mic.stop_failed", "停止原生麦克风失败：" + String(error));
    } finally {
      this.stopping = false;
    }
  }
}
