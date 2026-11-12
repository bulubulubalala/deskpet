/**
 * 文件职责：角色包编辑器与角色包导入导出（pack*），以及「按模型网格生成部位」的跨进程问答。
 *
 * 为什么单独一个文件：这一段是主进程里唯一「写 characters/ 目录」的地方，
 * 写盘的四个函数（保存包 / 保存部位 / 保存角色卡 / 导入）都得在成功后广播一次
 * charactersChanged，否则界面还拿着旧目录。网格探测的待回复表也只服务「生成部位」，
 * 一起放这里，注销时能把等待中的 Promise 全部超时掉。
 * 依赖方向：ipc/* -> 本文件 -> pack-editor / pack-archive / electron dialog。
 */
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { app, BrowserWindow, dialog, type OpenDialogOptions } from "electron";

import {
  IPC_CHANNELS,
  MESH_REGION_TEMPLATES,
  type HitsProbeReplyMessage,
  type PackExportRequest,
  type PackExportResponse,
  type PackGenerateRegionsRequest,
  type PackGenerateRegionsResponse,
  type PackImportRequest,
  type PackImportResponse,
  type PackLoadRequest,
  type PackLoadResponse,
  type PackOpenEditorRequest,
  type PackPickImageResponse,
  type PackRegionDraft,
  type PackSaveCardRequest,
  type PackSaveRegionsRequest,
  type PackSaveRequest,
  type PackSaveResponse,
} from "../../shared/contracts/ipc";
import type { IpcRegistry } from "../ipc-registry";
import {
  commitPackImport,
  exportPackArchive,
  inspectPackArchive,
  type PackImportPreview,
} from "../pack-archive";
import {
  DEFAULT_REGION_COLOR,
  loadCharacterPack,
  readImageAsDataUrl,
  saveCharacterCard,
  saveCharacterPack,
  saveCharacterRegions,
  validatePackId,
} from "../pack-editor";
import type { IpcContext } from "./context";
import type { IpcHandlerDeps } from "./deps";

/**
 * 注册角色包相关通道。
 * @returns 注销函数：把还在等回复的网格探测全部超时掉。
 */
export function registerPackHandlers(
  registry: IpcRegistry,
  deps: IpcHandlerDeps,
  ctx: IpcContext,
): () => void {
  /**
   * 「按模型网格生成部位」的问答（T2.44）：网格顶点只有渲染层拿得到（Live2D 在页面里跑），
   * 所以主进程发 hitsProbe 过去、等 hitsProbeReply 回来；超时算失败，不让编辑器一直转圈。
   */
  const HITS_PROBE_TIMEOUT_MS = 2500;
  /** 生成的部位默认带一点容差，和手画框的手感一致（草稿里可以再改）。 */
  const GENERATED_REGION_PADDING = 0.01;
  const hitProbes = new Map<
    string,
    { resolve: (reply: HitsProbeReplyMessage) => void; timer: ReturnType<typeof setTimeout> }
  >();
  registry.on(IPC_CHANNELS.hitsProbeReply, (_event, reply: HitsProbeReplyMessage) => {
    if (typeof reply !== "object" || reply === null || typeof reply.request_id !== "string") {
      return;
    }
    const pending = hitProbes.get(reply.request_id);
    if (pending === undefined) {
      return;
    }
    hitProbes.delete(reply.request_id);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  });
  /** 问主窗要一组网格的外接框；窗口不在 / 超时都回 null。 */
  const probeHitBounds = (drawables: readonly string[]): Promise<HitsProbeReplyMessage | null> => {
    const window = deps.getWindow();
    if (window === null || window.isDestroyed()) {
      return Promise.resolve(null);
    }
    const requestId = randomUUID();
    return new Promise<HitsProbeReplyMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        hitProbes.delete(requestId);
        resolve(null);
      }, HITS_PROBE_TIMEOUT_MS);
      hitProbes.set(requestId, { resolve, timer });
      window.webContents.send(IPC_CHANNELS.hitsProbe, { request_id: requestId, drawables });
    });
  };

  // 角色包编辑器（T2.3-D / T2.5 / T2.7）：选图走系统对话框、写盘走 pack-editor；渲染层全程只拿到 data URL。
  registry.handle(IPC_CHANNELS.packOpenEditor, (_event, request?: PackOpenEditorRequest): void => {
    // 老调用方（无参）= 新建；edit / card 必须带合法 char_id，否则也按新建打开
    const charId = (request?.char_id ?? "").trim();
    const mode =
      (request?.mode === "edit" || request?.mode === "card") && charId !== ""
        ? request.mode
        : "create";
    ctx.recordActivity(
      "用户打开了角色包编辑器的" +
        (mode === "create" ? "新建" : mode === "card" ? "角色卡" : "部位") +
        "页面。",
    );
    deps.openPackEditor(mode === "create" ? { mode } : { mode, char_id: charId });
  });

  registry.handle(IPC_CHANNELS.packPickImage, async (event): Promise<PackPickImageResponse> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    // 不传 properties：默认就是「选单个已存在的文件」
    const options = {
      title: "选一张立绘（PNG / JPEG / WebP）",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    };
    // 有父窗口就挂在它上面：否则对话框可能被窗口盖住，用户以为点了没反应
    const picked =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    const file = picked.canceled ? null : (picked.filePaths[0] ?? null);
    if (file === null) {
      return { canceled: true, data_url: "", file_name: "" };
    }
    let dataUrl: string;
    try {
      dataUrl = await readImageAsDataUrl(file);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    const fileName = basename(file);
    deps.logger.info("ipc.pack_pick_image", "选中一张立绘", { file_name: fileName });
    return { canceled: false, data_url: dataUrl, file_name: fileName };
  });

  registry.handle(
    IPC_CHANNELS.packSave,
    async (_event, request: PackSaveRequest): Promise<PackSaveResponse> => {
      const result = await saveCharacterPack(deps.charactersDir, request);
      if (result.ok) {
        deps.logger.info("ipc.pack_save", "角色包已保存", {
          char_id: result.char_id,
          files: result.files.length,
        });
        // 两个渲染层都要知道目录变了：聊天条的角色菜单与设置窗的角色下拉都从 characters/ 读
        ctx.broadcastCharactersChanged(result.char_id);
      } else {
        deps.logger.warn("ipc.pack_save_failed", "角色包没存下", {
          char_id: result.char_id,
          reason: result.error,
        });
      }
      return {
        ok: result.ok,
        char_id: result.char_id,
        error: result.error,
        files: [...result.files],
      };
    },
  );

  // 编辑当前角色部位（T2.5）：读现有包 → 编辑器只改 hits.json；保存后广播让主窗重载 hits。
  registry.handle(
    IPC_CHANNELS.packLoad,
    async (_event, request: PackLoadRequest): Promise<PackLoadResponse> =>
      await loadCharacterPack(deps.charactersDir, request.char_id),
  );

  registry.handle(
    IPC_CHANNELS.packSaveRegions,
    async (_event, request: PackSaveRegionsRequest): Promise<PackSaveResponse> => {
      const result = await saveCharacterRegions(deps.charactersDir, request);
      if (result.ok) {
        deps.logger.info("ipc.pack_save_regions", "角色部位已保存", {
          char_id: result.char_id,
          files: result.files.length,
        });
        ctx.broadcastCharactersChanged(result.char_id);
      } else {
        deps.logger.warn("ipc.pack_save_regions_failed", "角色部位没存下", {
          char_id: result.char_id,
          reason: result.error,
        });
      }
      return {
        ok: result.ok,
        char_id: result.char_id,
        error: result.error,
        files: [...result.files],
      };
    },
  );

  // 按模型网格生成部位（T2.44）：主窗算外接框 → 这里翻译成草稿；只回给编辑器，不落盘
  registry.handle(
    IPC_CHANNELS.packGenerateRegions,
    async (_event, request: PackGenerateRegionsRequest): Promise<PackGenerateRegionsResponse> => {
      const charId = request.char_id.trim();
      const failure = (error: string): PackGenerateRegionsResponse => ({
        ok: false,
        regions: [],
        error,
      });
      const invalid = validatePackId(charId);
      if (invalid !== null) {
        return failure(invalid);
      }
      try {
        const info = await stat(join(deps.charactersDir, charId));
        if (!info.isDirectory()) {
          throw new Error("not-a-directory");
        }
      } catch {
        return failure("找不到角色包 characters/" + charId + "。");
      }
      const drawables = MESH_REGION_TEMPLATES.flatMap((template) => [...template.drawables]);
      const reply = await probeHitBounds(drawables);
      if (reply === null) {
        return failure("主窗没有回应（可能没开或还在加载），稍后再试一次。");
      }
      if (reply.error !== "") {
        return failure(reply.error);
      }
      const bounds = new Map<string, readonly [number, number, number, number]>();
      for (const item of reply.bounds) {
        bounds.set(item.id, item.rect);
      }
      const regions: PackRegionDraft[] = [];
      for (const template of MESH_REGION_TEMPLATES) {
        const rect = bounds.get(template.drawables[0]);
        if (rect === undefined) {
          // 模型里没这块网格（换过 PSD、删过层）：跳过而不是给一个空框
          continue;
        }
        regions.push({
          id: template.id,
          name: template.name,
          rect: [rect[0], rect[1], rect[2], rect[3]],
          color: DEFAULT_REGION_COLOR,
          act: "",
          priority: template.priority,
          padding: GENERATED_REGION_PADDING,
          drawables: [...template.drawables],
        });
      }
      if (regions.length === 0) {
        return failure("这个模型里没找到可用的网格（PSD2Live 生成的网格名对不上）。");
      }
      deps.logger.info("ipc.pack_generate_regions", "按网格生成了部位草稿", {
        char_id: charId,
        regions: regions.length,
      });
      return { ok: true, regions, error: "" };
    },
  );

  // 角色卡（T2.7）：只改 card.json / pack.json 的人设与显示名，不动立绘 / 部位 / 音色
  registry.handle(
    IPC_CHANNELS.packSaveCard,
    async (_event, request: PackSaveCardRequest): Promise<PackSaveResponse> => {
      const result = await saveCharacterCard(deps.charactersDir, request);
      if (result.ok) {
        deps.logger.info("ipc.pack_save_card", "角色卡已保存", {
          char_id: result.char_id,
          files: result.files.length,
        });
        ctx.broadcastCharactersChanged(result.char_id);
      } else {
        deps.logger.warn("ipc.pack_save_card_failed", "角色卡没存下", {
          char_id: result.char_id,
          reason: result.error,
        });
      }
      return {
        ok: result.ok,
        char_id: result.char_id,
        error: result.error,
        files: [...result.files],
      };
    },
  );

  registry.handle(
    IPC_CHANNELS.packExport,
    async (event, request: PackExportRequest): Promise<PackExportResponse> => {
      const charId = request.char_id.trim();
      const loaded = await loadCharacterPack(deps.charactersDir, charId);
      if (!loaded.ok) {
        return {
          ok: false,
          canceled: false,
          char_id: charId,
          path: "",
          files: 0,
          error: loaded.error || "角色包无法读取",
        };
      }
      const parent = BrowserWindow.fromWebContents(event.sender);
      const safeName = (loaded.display_name || charId).replace(/[\\/:*?"<>|]/g, "_");
      const saveOptions = {
        title: "导出角色包",
        defaultPath: join(app.getPath("documents"), safeName + "-" + charId + ".zip"),
        filters: [{ name: "deskpet 角色包", extensions: ["zip"] }],
      };
      const picked =
        parent === null
          ? await dialog.showSaveDialog(saveOptions)
          : await dialog.showSaveDialog(parent, saveOptions);
      if (picked.canceled || picked.filePath === undefined) {
        return {
          ok: false,
          canceled: true,
          char_id: charId,
          path: "",
          files: 0,
          error: "",
        };
      }
      const result = await exportPackArchive(deps.charactersDir, charId, picked.filePath, {
        includeVoice: request.include_voice !== false,
        includeModel: request.include_model !== false,
      });
      deps.logger.info("ipc.pack_export", "角色包已导出", {
        char_id: charId,
        files: result.files,
        ok: result.ok,
      });
      return {
        ok: result.ok,
        canceled: false,
        char_id: result.charId,
        path: result.path,
        files: result.files,
        error: result.error,
      };
    },
  );

  registry.handle(
    IPC_CHANNELS.packImport,
    async (event, request: PackImportRequest): Promise<PackImportResponse> => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const dropped = request.path?.trim() ?? "";
      let file = dropped;
      if (dropped === "") {
        const openOptions: OpenDialogOptions = {
          title: "导入 deskpet 角色包",
          properties: ["openFile"],
          filters: [{ name: "deskpet 角色包", extensions: ["zip"] }],
        };
        const picked =
          parent === null
            ? await dialog.showOpenDialog(openOptions)
            : await dialog.showOpenDialog(parent, openOptions);
        file = picked.filePaths[0] ?? "";
        if (picked.canceled || file === "") {
          return {
            ok: false,
            canceled: true,
            char_id: "",
            display_name: "",
            renamed_from: "",
            warnings: [],
            error: "",
          };
        }
      } else if (!file.toLowerCase().endsWith(".zip")) {
        return {
          ok: false,
          canceled: false,
          char_id: "",
          display_name: "",
          renamed_from: "",
          warnings: [],
          error: "拖入的文件不是 zip 角色包",
        };
      }
      const preview: PackImportPreview = await inspectPackArchive(file);
      if (!preview.ok) {
        return {
          ok: false,
          canceled: false,
          char_id: "",
          display_name: "",
          renamed_from: "",
          warnings: [],
          error: preview.error,
        };
      }
      let overwrite = false;
      let targetExists = false;
      try {
        targetExists = (await stat(join(deps.charactersDir, preview.charId))).isDirectory();
      } catch {
        targetExists = false;
      }
      if (targetExists) {
        const warningText = preview.warnings.length > 0 ? "\n\n" + preview.warnings.join("\n") : "";
        const conflictOptions = {
          type: "question" as const,
          title: "角色 ID 已存在",
          message: "角色 " + preview.displayName + "（" + preview.charId + "）已经存在。",
          detail:
            "默认保留两者，会自动生成新的 char_id；选「覆盖原角色」只会替换角色包，旧记忆不会被删除。" +
            warningText,
          buttons: ["保留两者（默认）", "覆盖原角色", "取消"],
          defaultId: 0,
          cancelId: 2,
        };
        const choice =
          parent === null
            ? await dialog.showMessageBox(conflictOptions)
            : await dialog.showMessageBox(parent, conflictOptions);
        if (choice.response === 2) {
          await rm(preview.tempRoot, { recursive: true, force: true }).catch(() => undefined);
          return {
            ok: false,
            canceled: true,
            char_id: preview.charId,
            display_name: preview.displayName,
            renamed_from: "",
            warnings: preview.warnings,
            error: "",
          };
        }
        overwrite = choice.response === 1;
      }
      const result = await commitPackImport(
        preview,
        deps.charactersDir,
        {
          includeVoice: request.include_voice !== false,
          includeModel: request.include_model !== false,
        },
        overwrite,
      );
      if (result.ok) {
        ctx.broadcastCharactersChanged(result.charId);
        deps.logger.info("ipc.pack_import", "角色包已导入", {
          char_id: result.charId,
          renamed_from: result.renamedFrom,
          overwrite,
        });
      } else {
        deps.logger.warn("ipc.pack_import_failed", "角色包导入失败", {
          error: result.error,
        });
      }
      return {
        ok: result.ok,
        canceled: false,
        char_id: result.charId,
        display_name: result.displayName,
        renamed_from: result.renamedFrom,
        warnings: result.warnings,
        error: result.error,
      };
    },
  );

  return () => {
    for (const pending of hitProbes.values()) {
      clearTimeout(pending.timer);
    }
    hitProbes.clear();
  };
}
