/**
 * 文件职责：sidecar 生命周期与心跳轮询的编排（应用大脑的组合根，不 import electron 以便单测）。
 *
 * 分工：状态机在 heartbeat.ts，HTTP 在 health-client.ts，进程在 sidecar-process.ts，
 * 本模块只做「按时问一次、按状态机决策是否重启、把结果广播给 IPC 层」。
 * 依赖方向：main 内部；谁调用：app/main/index.ts（start/stop）与 app/main/ipc-handlers.ts（读取/手动重启）。
 */
import type { MainConfig } from "./config";
import { toErrorMessage } from "./errors";
import { HeartbeatMonitor, type EngineState, type HeartbeatSnapshot } from "./heartbeat";
import type { HealthSnapshot, ModuleHealth, ProviderHealth } from "./ipc";
import type { MainLogger } from "./logger";
import type { SidecarRuntime } from "./runtime-file";

/** 进程控制的最小接口：真实实现是 SidecarProcess，测试里换 fake。 */
export interface SidecarController {
  start(): Promise<SidecarRuntime>;
  stop(): Promise<void>;
  readonly runtime: SidecarRuntime | null;
}

/** 心跳探针的最小接口：真实实现是 HealthClient。 */
export interface HealthChecker {
  setEndpoint(runtime: SidecarRuntime): void;
  fetchHealth(): Promise<HealthSnapshot>;
}

/**
 * 给 UI 的心跳视图：把状态机、进程信息与最后一次 /health 结果拼成一份快照。
 * 刻意不暴露 token、也刻意区分 null（未知）与 0（确实是 0），让界面能诚实显示。
 */
export interface HealthView {
  readonly state: EngineState;
  readonly sidecar_port: number | null;
  readonly sidecar_pid: number | null;
  readonly uptime_s: number | null;
  readonly modules: readonly ModuleHealth[] | null;
  readonly providers: readonly ProviderHealth[] | null;
  readonly version: string | null;
  readonly restarts_used: number;
  readonly last_error: string | null;
}

export interface SidecarEngineDeps {
  readonly config: MainConfig;
  readonly logger: MainLogger;
  readonly sidecar: SidecarController;
  readonly health: HealthChecker;
  readonly monitor: HeartbeatMonitor;
  /** 注入定时器与时钟，测试里不用真的等 2s。 */
  readonly timers?: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  readonly now?: () => number;
}

export class SidecarEngine {
  private readonly deps: SidecarEngineDeps;
  private readonly now: () => number;
  private readonly listeners = new Set<(view: HealthView) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: HealthSnapshot | null = null;
  /** 上一拍还没回来时置位：心跳绝不并发（否则慢响应会堆积成雪崩）。 */
  private ticking = false;
  /** fatal 只记一次日志，避免判死后每 2s 刷一条同样的错误。 */
  private fatalLogged = false;

  constructor(deps: SidecarEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** 订阅心跳快照；返回退订函数（IPC 层在窗口销毁时解绑，避免向死窗口 send）。 */
  onHealthChanged(listener: (view: HealthView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 启动 sidecar、立刻探一次，然后按配置的节奏轮询。
   * 握手失败不抛给调用方：窗口必须照常打开，界面显示 failed 与原因（§6.7「让 UI 说实话」）。
   */
  async start(): Promise<HealthView> {
    try {
      const runtime = await this.deps.sidecar.start();
      this.deps.health.setEndpoint(runtime);
      await this.checkOnce();
    } catch (error) {
      const message = toErrorMessage(error);
      this.deps.monitor.noteRestartFailed(message);
      this.deps.logger.error("sidecar.start_failed", "sidecar 启动失败：" + message);
      this.emitHealth();
    }
    this.startTimer();
    return this.getHealth();
  }

  /** 停止轮询并结束 sidecar；可重复调用（退出流程里会有多条路径走到这里）。 */
  async stop(): Promise<void> {
    this.stopTimer();
    await this.deps.sidecar.stop();
    this.lastSnapshot = null;
    this.emitHealth();
  }

  /** 探一次 /health 并按结果推进状态机；定时器与手动刷新都走它，测试直接调用即可。 */
  async checkOnce(): Promise<HealthView> {
    if (this.ticking) {
      return this.getHealth();
    }
    this.ticking = true;
    try {
      const snapshot = await this.deps.health.fetchHealth();
      this.lastSnapshot = snapshot;
      this.fatalLogged = false;
      this.deps.monitor.recordSuccess(this.now());
      this.emitHealth();
    } catch (error) {
      const message = toErrorMessage(error);
      const decision = this.deps.monitor.recordFailure(this.now(), message);
      const heartbeat: HeartbeatSnapshot = this.deps.monitor.snapshot();
      if (decision.kind === "fatal") {
        if (!this.fatalLogged) {
          this.fatalLogged = true;
          this.deps.logger.error(
            "health.fatal",
            "心跳连续失败且自动重启预算已用尽，请检查 sidecar 日志后手动重启：" + message,
            { restartsUsed: heartbeat.restartsUsed, state: heartbeat.state },
          );
        }
      } else {
        this.deps.logger.warn("health.failed", "心跳失败：" + message, {
          consecutiveFailures: heartbeat.consecutiveFailures,
          restartsUsed: heartbeat.restartsUsed,
          state: heartbeat.state,
        });
      }
      this.emitHealth();
      if (decision.kind === "restart") {
        await this.restartSidecar("心跳连续失败");
      }
    } finally {
      this.ticking = false;
    }
    return this.getHealth();
  }

  /**
   * 重启 sidecar（自动与 IPC 手动共用）；失败不抛，交给广播出去的状态与日志说明情况。
   * 重启成功后不在这里立刻探活：下一拍心跳（≤2s）会把它标回 online，避免与进行中的那一拍重入。
   */
  async restartSidecar(reason: string): Promise<HealthView> {
    this.deps.logger.info("sidecar.restart", "正在重启 sidecar：" + reason);
    this.deps.monitor.noteRestarting();
    this.emitHealth();
    try {
      await this.deps.sidecar.stop();
      const runtime = await this.deps.sidecar.start();
      this.deps.health.setEndpoint(runtime);
      this.fatalLogged = false;
      this.deps.logger.info("sidecar.restart_ok", "sidecar 已重新就绪", {
        pid: runtime.pid,
        port: runtime.port,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      this.deps.monitor.noteRestartFailed(message);
      this.deps.logger.error("sidecar.restart_failed", "重启 sidecar 失败：" + message);
    }
    this.emitHealth();
    return this.getHealth();
  }

  /**
   * 已握手的 runtime（端口 + 回环 token）；未就绪时 null。
   * T1.6b 的 HTTP 编排靠它建立端点：sidecar 每次重启都会换端口与 token，不能缓存第一份。
   */
  getRuntime(): SidecarRuntime | null {
    return this.deps.sidecar.runtime;
  }

  /** 拼当前视图：进程信息来自已握手的 runtime，健康细节来自最后一次成功的 /health。 */
  getHealth(): HealthView {
    const heartbeat = this.deps.monitor.snapshot();
    const runtime = this.deps.sidecar.runtime;
    const snapshot = this.lastSnapshot;
    return {
      state: heartbeat.state,
      sidecar_port: runtime?.port ?? null,
      sidecar_pid: runtime?.pid ?? null,
      uptime_s: snapshot?.uptime_s ?? null,
      modules: snapshot?.modules ?? null,
      providers: snapshot?.providers ?? null,
      version: snapshot?.version ?? null,
      restarts_used: heartbeat.restartsUsed,
      last_error: heartbeat.lastError,
    };
  }

  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }
    const setIntervalFn = this.deps.timers?.setInterval ?? setInterval;
    this.timer = setIntervalFn(() => {
      void this.checkOnce();
    }, this.deps.config.healthPollMs);
  }

  private stopTimer(): void {
    if (this.timer === null) {
      return;
    }
    const clearIntervalFn = this.deps.timers?.clearInterval ?? clearInterval;
    clearIntervalFn(this.timer);
    this.timer = null;
  }

  private emitHealth(): void {
    const view = this.getHealth();
    for (const listener of this.listeners) {
      listener(view);
    }
  }
}
