/**
 * 文件职责：设置窗「角色包」面板——把当前角色导出成 zip，或从 zip 导入一个新角色。
 *
 * 为什么单独一个文件：导入/导出只跟 api.pack 与三个勾选框打交道，
 * 与引擎状态、记忆面板没有共享状态；出问题时整份逻辑在这里一处看完。
 */
import { api, byId, checked } from "./dom";

export function setPackStatus(id: string, text: string, bad = false): void {
  const node = byId(id);
  if (node !== null) {
    node.textContent = text;
    node.classList.toggle("bad-text", bad);
  }
}

export async function onPackExport(): Promise<void> {
  setPackStatus("pack-export-status", "正在导出…");
  try {
    const state = await api.ui.getState();
    if (state.char_id === null) {
      setPackStatus("pack-export-status", "当前没有可导出的角色。", true);
      return;
    }
    const result = await api.pack.exportPack({
      char_id: state.char_id,
      include_voice: checked("pack-export-voice"),
      include_model: checked("pack-export-model"),
    });
    if (result.canceled) {
      setPackStatus("pack-export-status", "已取消导出。");
      return;
    }
    if (!result.ok) {
      setPackStatus("pack-export-status", "导出失败：" + result.error, true);
      return;
    }
    setPackStatus(
      "pack-export-status",
      "已导出 " + String(result.files) + " 个文件：" + result.path,
    );
  } catch (error: unknown) {
    setPackStatus("pack-export-status", "导出失败：" + String(error), true);
  }
}

export async function onPackImport(droppedPath = ""): Promise<void> {
  setPackStatus("pack-import-status", "正在读取 zip…");
  try {
    const result = await api.pack.importPack({
      include_voice: checked("pack-import-voice"),
      include_model: checked("pack-import-model"),
      ...(droppedPath === "" ? {} : { path: droppedPath }),
    });
    if (result.canceled) {
      setPackStatus("pack-import-status", "已取消导入。");
      return;
    }
    if (!result.ok) {
      setPackStatus("pack-import-status", "导入失败：" + result.error, true);
      return;
    }
    let message = "已导入 " + result.display_name + " (" + result.char_id + ")。";
    if (result.renamed_from !== "") {
      message += " 原 ID " + result.renamed_from + " 已保留，新角色改名。";
    }
    if (result.warnings.length > 0) {
      message += " " + result.warnings.join(" ");
    }
    setPackStatus("pack-import-status", message);
  } catch (error: unknown) {
    setPackStatus("pack-import-status", "导入失败：" + String(error), true);
  }
}
