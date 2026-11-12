/**
 * 文件职责：托盘 / 设置窗的「导出数据包」——发起导出、报结果、在资源管理器里指出那个 zip。
 *
 * 为什么单独一个文件：打包在 sidecar 里做（记忆库是 SQLCipher，主进程没有密钥），
 * 主进程这边只剩「防重入 + 文案 + 失败对话框」这三件事，与窗口装配无关。
 * 依赖方向：main/* -> 本文件 -> SidecarClient（只调 exportData）；提示通道由调用方注入。
 */
import { dialog, shell } from "electron";
import { basename } from "node:path";

import { toErrorMessage } from "./errors";
import { formatBytes } from "./format-bytes";
import type { MainLogger } from "./logger";
import type { SidecarClient } from "./sidecar-client";

/** 导出期间再点一次：不重复打包（sidecar 里也有锁，这里只是少一次几十秒的等待）。 */
let exporting = false;

export interface ExportDataDeps {
  /** 托盘气泡 / 系统通知；出问题时窗口可能已经不在，所以不直接写界面。 */
  readonly notify: (title: string, body: string) => void;
}

/**
 * 导出数据包（M3 / D9）：打包在 sidecar 里做，主进程只负责发起、报结果、指出文件在哪。
 * 成功后直接在资源管理器里选中那个 zip——用户点「导出」的目的是拿到它，不是知道它存在。
 */
export async function exportDataAndReveal(
  client: SidecarClient,
  logger: MainLogger,
  deps: ExportDataDeps,
): Promise<void> {
  if (exporting) {
    deps.notify("正在导出", "上一个导出包还在打包，请稍等。");
    return;
  }
  exporting = true;
  try {
    const result = await client.exportData();
    if (result.path === "") {
      throw new Error("后台引擎没有返回导出包位置");
    }
    logger.info("data.exported", "数据包已导出", {
      file: result.path,
      bytes: result.bytes,
      skipped: result.skipped.length,
    });
    deps.notify("数据包已导出", basename(result.path) + " · " + formatBytes(result.bytes));
    if (result.skipped.length > 0) {
      logger.warn("data.export_partial", "导出包有内容被跳过", { skipped: result.skipped });
    }
    shell.showItemInFolder(result.path);
  } catch (error: unknown) {
    logger.error("data.export_failed", "导出数据包失败：" + toErrorMessage(error));
    void dialog.showMessageBox({
      type: "error",
      title: "导出失败",
      message: "没导出成",
      detail: toErrorMessage(error) + "\n\n如果一直失败，用托盘菜单「复制诊断信息」把现场发出来。",
    });
  } finally {
    exporting = false;
  }
}
