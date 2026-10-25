/**
 * 文件职责：读取 Windows 的通知状态（全屏 / 演示 / 忙碌 / 锁定），用于 F5 免打扰。
 * 使用 shell32!SHQueryUserNotificationState，不猜窗口标题。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MainLogger } from "./logger";

const execFileAsync = promisify(execFile);

const QUERY_SCRIPT = String.raw`
$src = @'
using System;
using System.Runtime.InteropServices;
public static class DeskpetQuns {
    [DllImport("shell32.dll")]
    public static extern int SHQueryUserNotificationState(out int state);
}
'@
Add-Type -TypeDefinition $src
$state = 0
[void][DeskpetQuns]::SHQueryUserNotificationState([ref]$state)
Write-Output $state
`;

export function isDndState(state: number): boolean {
  return state === 1 || state === 2 || state === 3 || state === 4 || state === 6;
}

export async function readNotificationState(): Promise<number> {
  if (process.platform !== "win32") {
    return 5;
  }
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", QUERY_SCRIPT],
      { windowsHide: true, timeout: 3000, encoding: "utf8" },
    );
    const value = Number.parseInt(stdout.trim().split(/\s+/).at(-1) ?? "", 10);
    return Number.isFinite(value) ? value : 5;
  } catch {
    return 5;
  }
}

export class NotificationStateMonitor {
  private timer: NodeJS.Timeout | null = null;
  private dnd = false;
  private running = false;

  constructor(
    private readonly deps: {
      readonly logger: MainLogger;
      readonly intervalMs?: number;
      readonly read?: () => Promise<number>;
    },
  ) {}

  get current(): boolean {
    return this.dnd;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    void this.tick();
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, this.deps.intervalMs ?? 20_000);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      this.dnd = isDndState(await (this.deps.read ?? readNotificationState)());
    } catch (error: unknown) {
      this.deps.logger.debug("dnd.probe_failed", "通知状态检测失败：" + String(error));
      this.dnd = false;
    } finally {
      this.running = false;
    }
  }
}
