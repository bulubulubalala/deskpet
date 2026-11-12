/**
 * 文件职责：配置类通道——模型供给读写与探测、用量统计、数据包导出 / 恢复。
 *
 * 为什么单独一个文件：这几条通道都围绕「设置与数据」这一层，共同的规矩是
 * 「配置的唯一事实来源是 data/settings.json（D4），密钥永不回传渲染层」；
 * 写完之后要重启后台引擎（sidecar 只在启动时读环境），这条规矩也就集中在一处。
 * 依赖方向：ipc/* -> 本文件 -> settings-store / provider-settings / sidecar-client。
 */
import { dialog, shell } from "electron";

import {
  IPC_CHANNELS,
  type DataBackupNowResult,
  type DataBackupsResult,
  type DataExportResult,
  type DataRestoreResult,
  type ProviderModelsRequest,
  type ProviderModelsResponse,
  type ProviderSettingsPatchEntry,
  type ProviderSettingsPayload,
  type ProviderTestReport,
  type ProviderTestRequest,
  type UsageStats,
} from "../../shared/contracts/ipc";
import type { IpcRegistry } from "../ipc-registry";
import { buildProviderSettings, providerPatchToEnv } from "../provider-settings";
import type { IpcContext } from "./context";
import type { IpcHandlerDeps } from "./deps";

export function registerProviderHandlers(
  registry: IpcRegistry,
  deps: IpcHandlerDeps,
  ctx: IpcContext,
): void {
  // 模型供给（T1.14b）：配置的唯一事实来源是 data/settings.json（D4），这里只做「读写 + 探测」三件事。
  // 读回来的密钥一律只给布尔量；写的时候交给设置仓库统一加密与原子落盘（见 settings-store.ts）。
  registry.handle(IPC_CHANNELS.providersGet, (): ProviderSettingsPayload => ({
    entries: buildProviderSettings(deps.settings.toEnv()),
    config_file: deps.settings.path,
  }));

  registry.handle(
    IPC_CHANNELS.providersSet,
    async (
      _event,
      patch: readonly ProviderSettingsPatchEntry[],
    ): Promise<ProviderSettingsPayload> => {
      const updates = providerPatchToEnv(patch);
      const env = await deps.settings.update(updates);
      // 只记改了几个键，不记键值：LLM key 与 TTS token 都在这条路上（§7.1）
      deps.logger.info("ipc.providers_set", "已把模型供给设置写回 data/settings.json", {
        changed: Object.keys(updates).length,
      });
      // 写完就地重启后台引擎：否则 sidecar 还拿着上一次启动时的环境快照，
      // 用户会看到「密钥明明改了却一直 401」（T2.41 真机反馈）。不 await，设置窗先回显。
      void deps.engine.restartSidecar("模型供给设置已更新");
      return { entries: buildProviderSettings(env), config_file: deps.settings.path };
    },
  );

  registry.handle(
    IPC_CHANNELS.providersTest,
    async (_event, request: ProviderTestRequest): Promise<ProviderTestReport> =>
      await deps.client.testProvider(request),
  );

  registry.handle(
    IPC_CHANNELS.providersModels,
    async (_event, request: ProviderModelsRequest): Promise<ProviderModelsResponse> =>
      await deps.client.listProviderModels(request),
  );

  registry.handle(IPC_CHANNELS.usageStats, async (): Promise<UsageStats> =>
    deps.client.usageStats(),
  );

  registry.handle(
    IPC_CHANNELS.usageSetRecording,
    async (_event, enabled: boolean): Promise<UsageStats> =>
      deps.client.setUsageRecording(enabled === true),
  );

  registry.handle(IPC_CHANNELS.usageClear, async (): Promise<UsageStats> =>
    deps.client.clearUsage(),
  );

  // 数据导出（M3）：用户主动操作。打包在 sidecar 里做（记忆库要 VACUUM INTO），
  // 慢是正常的；失败原样抛给界面，别把原因吞掉。
  registry.handle(IPC_CHANNELS.dataExport, async (): Promise<DataExportResult> => {
    const result = await deps.client.exportData();
    ctx.recordActivity("用户导出了数据包。");
    return result;
  });

  // 备份可见（D9）：只读目录列表 —— 用户要能看见「手头有哪些后悔药」
  registry.handle(IPC_CHANNELS.dataBackups, (): Promise<DataBackupsResult> => {
    return deps.client.listBackups();
  });

  // 立即备份：和「清空记忆前留底」同一条 VACUUM INTO 路径，失败回空路径由界面说实情
  registry.handle(IPC_CHANNELS.dataBackupNow, async (): Promise<DataBackupNowResult> => {
    const result = await deps.client.backupNow();
    if (result.path.length > 0) {
      ctx.recordActivity("用户手动做了一份记忆库备份。");
    }
    return result;
  });

  // 打开数据目录：备份在它的 backups/ 子目录里，帮用户少找两步
  registry.handle(IPC_CHANNELS.dataOpenDir, async (): Promise<void> => {
    const problem = await shell.openPath(deps.dataDir);
    if (problem.length > 0) {
      deps.logger.warn("data.open_dir_failed", "打不开数据目录", {
        fields: { problem },
      });
    }
  });

  // 从数据包恢复（M3）：选包 → sidecar 解到暂存目录；替换发生在下次引擎启动时
  //（在线换库会让正在使用的连接写到已被替换的 inode 上，改动会丢）。
  registry.handle(IPC_CHANNELS.dataRestore, async (): Promise<DataRestoreResult | null> => {
    const picked = await dialog.showOpenDialog({
      title: "选择 deskpet 数据包",
      buttonLabel: "恢复",
      filters: [{ name: "deskpet 数据包", extensions: ["zip"] }],
      properties: ["openFile"],
    });
    const archive = picked.filePaths[0];
    if (picked.canceled || archive === undefined) {
      return null;
    }
    const result = await deps.client.restoreData(archive);
    ctx.recordActivity("用户从数据包恢复了记忆库（重启后生效）。");
    return result;
  });
}
