/**
 * 文件职责：读取 Windows 麦克风使用记录，判断是否有别的程序正在占用麦克风（F9）。
 * 只读注册表，不打开设备；每 15 秒刷新一次缓存。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MainLogger } from "./logger";

const execFileAsync = promisify(execFile);
const MIC_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

interface UsageBlock {
  readonly name: string;
  start: bigint;
  stop: bigint;
}

function parseTime(value: string): bigint {
  const text = value.trim();
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

export function parseMicUsage(output: string): boolean {
  const blocks: UsageBlock[] = [];
  let current: UsageBlock | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("HKEY_")) {
      current = { name: line, start: 0n, stop: 0n };
      blocks.push(current);
      continue;
    }
    if (current === null) {
      continue;
    }
    const match = /^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(\S+)/.exec(line);
    if (match !== null) {
      const value = parseTime(match[2] ?? "0");
      if (match[1] === "LastUsedTimeStart") {
        current.start = value;
      } else {
        current.stop = value;
      }
    }
  }
  return blocks.some((block) => block.start > 0n && block.start > block.stop);
}

export async function readMicBusy(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", MIC_KEY, "/s"], {
      windowsHide: true,
      timeout: 3000,
      encoding: "utf8",
    });
    return parseMicUsage(stdout);
  } catch {
    return false;
  }
}

export class MicBusyMonitor {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private running = false;

  constructor(
    private readonly deps: {
      readonly logger: MainLogger;
      readonly intervalMs?: number;
      readonly read?: () => Promise<boolean>;
    },
  ) {}

  get current(): boolean {
    return this.busy;
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
    }, this.deps.intervalMs ?? 15_000);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      this.busy = await (this.deps.read ?? readMicBusy)();
    } catch (error: unknown) {
      this.deps.logger.debug("mic.busy_probe_failed", "麦克风占用检测失败：" + String(error));
      this.busy = false;
    } finally {
      this.running = false;
    }
  }
}
