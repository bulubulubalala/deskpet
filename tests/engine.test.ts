/**
 * 文件职责：SidecarEngine 的编排单测——心跳失败触发自动重启、预算用尽判死、手动重启可救。
 *
 * 为什么用 fake：真实实现会起 Python 进程并走 HTTP，单测必须能精确控制「第几拍失败」。
 * 依赖方向：tests -> app/main/engine.ts + ./heartbeat ./config（不启动 Electron、不起进程）。
 */
import { describe, expect, it } from "vitest";

import { loadMainConfig } from "../app/main/config";
import { SidecarEngine, type HealthChecker, type SidecarController } from "../app/main/engine";
import { HeartbeatMonitor } from "../app/main/heartbeat";
import type { HealthSnapshot } from "../app/main/ipc";
import type { MainLogger } from "../app/main/logger";
import type { SidecarRuntime } from "../app/main/runtime-file";

const RUNTIME: SidecarRuntime = {
  pid: 4321,
  host: "127.0.0.1",
  port: 9000,
  token: "token-not-used-in-view",
  started_at: "2026-01-01T00:00:00Z",
  version: "0.1.0",
};

const HEALTH: HealthSnapshot = {
  status: "ok",
  uptime_s: 12,
  modules: [{ name: "tts", state: "idle" }],
  voice: "idle",
  version: "0.1.0",
};

class FakeSidecar implements SidecarController {
  runtime: SidecarRuntime | null = null;
  starts = 0;
  stops = 0;
  failNextStart = false;

  // 刻意不用 async：这些 fake 里没有真正的异步等待，写成 async 会触发 require-await
  start(): Promise<SidecarRuntime> {
    this.starts += 1;
    if (this.failNextStart) {
      return Promise.reject(new Error("sidecar 起不来"));
    }
    this.runtime = RUNTIME;
    return Promise.resolve(RUNTIME);
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.runtime = null;
    return Promise.resolve();
  }
}

class FakeHealth implements HealthChecker {
  endpoint: SidecarRuntime | null = null;
  fail = false;
  calls = 0;

  setEndpoint(runtime: SidecarRuntime): void {
    this.endpoint = runtime;
  }

  fetchHealth(): Promise<HealthSnapshot> {
    this.calls += 1;
    if (this.fail) {
      return Promise.reject(new Error("连接被拒绝"));
    }
    return Promise.resolve(HEALTH);
  }
}

interface Harness {
  readonly engine: SidecarEngine;
  readonly sidecar: FakeSidecar;
  readonly health: FakeHealth;
  readonly lines: string[];
  tick(): void;
  clearedCount(): number;
  flush(): Promise<void>;
}

function createHarness(options: { maxFailures?: number; maxRestarts?: number } = {}): Harness {
  const lines: string[] = [];
  const record = (level: string) => {
    return (event: string, message: string): void => {
      lines.push(level + " " + event + " " + message);
    };
  };
  const logger: MainLogger = {
    debug: record("DEBUG"),
    info: record("INFO"),
    warn: record("WARN"),
    error: record("ERROR"),
    close: () => {},
  };

  let handler: (() => void) | null = null;
  let cleared = 0;
  const timers = {
    setInterval: ((fn: () => void) => {
      handler = fn;
      return 1 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      cleared += 1;
      handler = null;
    }) as unknown as typeof clearInterval,
  };

  const config = loadMainConfig({
    isDev: true,
    appRoot: "/tmp/deskpet-test",
    resourcesRoot: "/tmp/deskpet-test-resources",
    userDataDir: "/tmp/deskpet-test-userdata",
    env: { DESKPET_HEALTH_POLL_MS: "2000" },
  });

  const sidecar = new FakeSidecar();
  const health = new FakeHealth();
  const monitor = new HeartbeatMonitor({
    maxFailures: options.maxFailures ?? 3,
    maxRestarts: options.maxRestarts ?? 3,
  });
  const engine = new SidecarEngine({ config, logger, sidecar, health, monitor, timers });

  return {
    engine,
    sidecar,
    health,
    lines,
    tick: () => handler?.(),
    clearedCount: () => cleared,
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

describe("SidecarEngine", () => {
  it("启动即探活：握手后 online，端口/模块/版本都进视图", async () => {
    const harness = createHarness();
    const view = await harness.engine.start();
    expect(view.state).toBe("online");
    expect(view.sidecar_port).toBe(9000);
    expect(view.sidecar_pid).toBe(4321);
    expect(view.uptime_s).toBe(12);
    expect(view.modules).toEqual([{ name: "tts", state: "idle" }]);
    expect(view.version).toBe("0.1.0");
    expect(harness.health.endpoint).toEqual(RUNTIME);
    // 视图里绝不能出现 token
    expect(JSON.stringify(view)).not.toContain(RUNTIME.token);
    await harness.engine.stop();
    expect(harness.sidecar.stops).toBe(1);
  });

  it("连续 3 次心跳失败触发一次自动重启，之后能回到 online", async () => {
    const harness = createHarness();
    await harness.engine.start();
    harness.health.fail = true;
    await harness.engine.checkOnce();
    await harness.engine.checkOnce();
    expect(harness.sidecar.starts).toBe(1);
    const third = await harness.engine.checkOnce();
    expect(harness.sidecar.starts).toBe(2);
    expect(third.state).toBe("restarting");
    harness.health.fail = false;
    const recovered = await harness.engine.checkOnce();
    expect(recovered.state).toBe("online");
    // 成功一次就把重启预算清零（heartbeat.ts 的设计），所以恢复后这里必须是 0
    expect(recovered.restarts_used).toBe(0);
    await harness.engine.stop();
  });

  it("重启预算用尽判死，且 fatal 只写一条日志", async () => {
    const harness = createHarness({ maxFailures: 1, maxRestarts: 1 });
    await harness.engine.start();
    harness.health.fail = true;
    await harness.engine.checkOnce();
    const dead = await harness.engine.checkOnce();
    expect(dead.state).toBe("failed");
    await harness.engine.checkOnce();
    expect(harness.sidecar.starts).toBe(2);
    expect(harness.lines.filter((line) => line.includes("ERROR health.fatal")).length).toBe(1);
    await harness.engine.stop();
  });

  it("判死之后手动重启仍然能救回来", async () => {
    const harness = createHarness({ maxFailures: 1, maxRestarts: 1 });
    await harness.engine.start();
    harness.health.fail = true;
    await harness.engine.checkOnce();
    await harness.engine.checkOnce();
    expect(harness.engine.getHealth().state).toBe("failed");
    harness.health.fail = false;
    const restarted = await harness.engine.restartSidecar("用户手动触发");
    expect(restarted.state).toBe("restarting");
    const recovered = await harness.engine.checkOnce();
    expect(recovered.state).toBe("online");
    expect(harness.sidecar.starts).toBe(3);
    await harness.engine.stop();
  });

  it("定时器到点会自己探活，stop 时被清掉", async () => {
    const harness = createHarness();
    await harness.engine.start();
    expect(harness.health.calls).toBe(1);
    harness.tick();
    await harness.flush();
    expect(harness.health.calls).toBe(2);
    await harness.engine.stop();
    expect(harness.clearedCount()).toBe(1);
  });

  it("启动握手失败不抛给调用方，而是把 failed 与原因交给界面", async () => {
    const harness = createHarness();
    harness.sidecar.failNextStart = true;
    const view = await harness.engine.start();
    expect(view.state).toBe("failed");
    expect(view.last_error).toContain("sidecar 起不来");
    await harness.engine.stop();
  });
});
