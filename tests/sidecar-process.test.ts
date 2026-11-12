/**
 * 文件职责：SidecarProcess 的单测——只验「每次拉起子进程都重读 .env」这一条（T2.41 真机 401）。
 *
 * 为什么单元测这条：真机上表现为「改了密钥仍然 401，退出重开才好」，根因是启动时把环境快照冻住。
 * 用假 spawnFn 抓 env、假 killFn 避免真 taskkill，剩下的握手段靠手动写 runtime.json 过。
 */

import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadMainConfig, type MainConfig } from "../app/main/config";
import type { MainLogger } from "../app/main/logger";
import { SidecarProcess } from "../app/main/sidecar-process";

function silentLogger(): MainLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    close: () => undefined,
  };
}

async function makeConfig(): Promise<MainConfig> {
  const dir = await mkdtemp(join(tmpdir(), "deskpet-sidecar-"));
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  return loadMainConfig({
    isDev: true,
    appRoot: dir,
    resourcesRoot: dir,
    userDataDir: dir,
    env: { DESKPET_DATA_DIR: dataDir, DESKPET_LLM_API_KEY: "old-key" },
    envFile: join(dir, ".env"),
  });
}

/** 假子进程：只实现 start() 用到的 pid 与 on()。 */
function fakeChild(pid: number): EventEmitter & { pid: number } {
  const child = new EventEmitter() as EventEmitter & { pid: number };
  child.pid = pid;
  return child;
}

describe("SidecarProcess", () => {
  it("每次 start 都用最新的环境（重启后台引擎要能读到刚写进 .env 的密钥）", async () => {
    const config = await makeConfig();
    const captured: Record<string, string>[] = [];
    let live: Record<string, string> = { DESKPET_LLM_API_KEY: "old-key" };
    let pid = 1000;

    const sidecar = new SidecarProcess({
      config,
      logger: silentLogger(),
      readEnv: () => Promise.resolve({ ...live }),
      killFn: () => Promise.resolve(),
      spawnFn: ((_file: string, _args: string[], options: { env: Record<string, string> }) => {
        captured.push({ ...options.env });
        const child = fakeChild((pid += 1));
        // 真实 sidecar 会自己写 runtime.json；这里替它写，握手才能过
        void writeFile(
          config.runtimePath,
          JSON.stringify({
            pid: child.pid,
            host: config.host,
            port: config.preferredPort,
            token: "t",
            started_at: new Date().toISOString(),
            version: "test",
          }),
          "utf8",
        );
        return child;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    await sidecar.start();
    expect(captured[0]?.["DESKPET_LLM_API_KEY"]).toBe("old-key");

    // 用户改了密钥并点「重启后台引擎」：不该再沿用启动时那份快照
    live = { DESKPET_LLM_API_KEY: "new-key" };
    await sidecar.start();
    expect(captured[1]?.["DESKPET_LLM_API_KEY"]).toBe("new-key");
    // 主进程决定的四项始终覆盖 .env，不能被子进程环境里的同名值带偏
    expect(captured[1]?.["DESKPET_DATA_DIR"]).toBe(config.dataDir);
    expect(captured[1]?.["DESKPET_SIDECAR_PORT"]).toBe(String(config.preferredPort));
  });
});
