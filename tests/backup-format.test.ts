/**
 * 文件职责：备份列表的纯展示逻辑（体积换算 / 本地时间 / 类型标签）。
 *
 * 为什么值得单独测：这三个函数决定用户看到「2.0 MiB」「2026-11-09 20:15」「操作前留底」，
 * 算错一位就会让人以为备份坏了；它们不碰 DOM，可以在 node 下直接断言。
 */
import { describe, expect, it } from "vitest";

import {
  BACKUP_KIND_LABELS,
  formatBackupSize,
  formatBackupTime,
} from "../app/renderer/settings/memory/backup-format";

describe("formatBackupSize", () => {
  it("按 1024 进制分档", () => {
    expect(formatBackupSize(0)).toBe("0 B");
    expect(formatBackupSize(512)).toBe("512 B");
    expect(formatBackupSize(1536)).toBe("1.5 KiB");
    expect(formatBackupSize(2 * 1024 * 1024)).toBe("2.0 MiB");
  });

  it("坏值不显示 NaN", () => {
    expect(formatBackupSize(-1)).toBe("0 B");
    expect(formatBackupSize(Number.NaN)).toBe("0 B");
    expect(formatBackupSize(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("formatBackupTime", () => {
  it("unix 秒转成本机时区的分钟精度", () => {
    const at = new Date(2026, 10, 9, 20, 15, 30).getTime() / 1000;
    expect(formatBackupTime(at)).toBe("2026-11-09 20:15");
  });

  it("坏值给占位符而不是 1970", () => {
    expect(formatBackupTime(0)).toBe("—");
    expect(formatBackupTime(Number.NaN)).toBe("—");
  });
});

describe("BACKUP_KIND_LABELS", () => {
  it("五种类型都有中文标签，且都不为空", () => {
    for (const kind of ["daily", "before", "replaced", "rejected", "other"] as const) {
      expect(BACKUP_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});
