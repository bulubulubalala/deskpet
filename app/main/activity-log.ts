const MAX_ENTRIES = 8;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface ActivityEntry {
  readonly text: string;
  readonly at: number;
}

export class ActivityLog {
  private entries: ActivityEntry[] = [];

  record(text: string, now = Date.now()): void {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, 120);
    if (clean === "") {
      return;
    }
    const last = this.entries[this.entries.length - 1];
    if (last !== undefined && last.text === clean && now - last.at < 30_000) {
      return;
    }
    this.entries = [...this.entries, { text: clean, at: now }].slice(-MAX_ENTRIES);
  }

  recent(now = Date.now(), ttlMs = DEFAULT_TTL_MS): string[] {
    this.entries = this.entries.filter((entry) => now - entry.at <= ttlMs);
    return this.entries.map((entry) => entry.text);
  }

  clear(): void {
    this.entries = [];
  }
}
