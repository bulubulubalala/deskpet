/**
 * 文件职责：设置窗「记忆」面板的语义索引：索引进度、内置向量模型的下载/删除、向量来源开关。
 *
 * 为什么单独一个文件：这块要跟主进程的模型下载进度打交道，是记忆面板里唯一有「进行中的长任务」的部分，和列表/日记混在一起会让状态判断互相干扰。
 * 依赖方向：renderer 内部模块 -> ./state、../dom、../../shared/contracts；不 import main，也不碰别的面板的 DOM。
 */

import type {
  MemoryEmbeddingConfig,
  MemoryEmbeddingStatus,
  ModelProgress,
  ModelStatus,
} from "../../../shared/contracts/ipc";
import { api, byId, setText, showBanner } from "../dom";
import { memoryPaneState } from "./state";
function setEmbeddingChip(state: "starting" | "online" | "offline" | "failed", text: string): void {
  const chip = byId("embedding-chip");
  if (chip !== null) {
    chip.dataset["state"] = state;
  }
  setText("embedding-chip-text", text);
}

function setEmbeddingButton(disabled: boolean): void {
  const button = byId("embedding-index");
  if (button instanceof HTMLButtonElement) {
    button.disabled = disabled;
  }
}

/** 把 sidecar 的状态画到卡片上；未启用 / 不可用都要说清下一步，而不是只显示红色。 */
function renderEmbeddingStatus(status: MemoryEmbeddingStatus): void {
  if (!status.enabled) {
    setEmbeddingChip("offline", "未启用");
    setText(
      "embedding-summary",
      "语义检索未启用；当前只用全文检索。打开上面的开关会写入设置并重启后台引擎。",
    );
    setEmbeddingButton(true);
    return;
  }
  if (!status.available) {
    setEmbeddingChip("failed", "不可用");
    // 内置模型缺文件是安装包的问题，说“Ollama 没启动”只会把人带偏。
    setText(
      "embedding-summary",
      status.provider === "onnx"
        ? "内置向量模型不可用：" +
            (status.error === ""
              ? "安装包里缺少 models/embedding，请重新解压或重装。"
              : status.error)
        : "Ollama 不可用：" +
            (status.error === "" ? "请确认本地 Ollama 已启动且模型已拉取。" : status.error),
    );
    setEmbeddingButton(true);
    return;
  }
  setEmbeddingChip("online", "可用");
  setText(
    "embedding-summary",
    (status.provider === "onnx" ? "内置模型 " : "模型 ") +
      status.model +
      " · 已索引 " +
      String(status.indexed) +
      " 条 · 待索引 " +
      String(status.pending) +
      " 条",
  );
  setEmbeddingButton(embeddingIndexBusy || status.pending === 0);
}

/** 读当前角色的语义索引状态；失败只在卡片里提示，不影响记忆列表与聊天。 */
export async function refreshEmbeddingStatus(preserveNote = false): Promise<void> {
  const token = ++embeddingStatusToken;
  const charId = memoryPaneState.charId;
  if (!embeddingIndexBusy && !preserveNote) {
    setText("embedding-note", "");
  }
  if (charId === null) {
    setEmbeddingChip("offline", "未选中");
    setText("embedding-summary", "先选一个角色。");
    setEmbeddingButton(true);
    return;
  }
  setEmbeddingChip("starting", "读取中");
  setText("embedding-summary", "正在读取语义检索状态…");
  try {
    const status = await api.memory.embeddingStatus({ char_id: charId });
    if (token !== embeddingStatusToken || charId !== memoryPaneState.charId) {
      return;
    }
    renderEmbeddingStatus(status);
  } catch (error: unknown) {
    if (token !== embeddingStatusToken) {
      return;
    }
    setEmbeddingChip("failed", "读取失败");
    setText("embedding-summary", "读不到语义检索状态（后台引擎没起来？）：" + String(error));
    setEmbeddingButton(true);
  }
}

/** 手动补索引；索引期间禁用按钮，结束后重新拉一次状态。 */
async function onEmbeddingIndexClicked(): Promise<void> {
  const charId = memoryPaneState.charId;
  if (charId === null || embeddingIndexBusy) {
    return;
  }
  embeddingIndexBusy = true;
  setEmbeddingButton(true);
  setText("embedding-note", "正在补索引，模型较慢时可能需要几十秒…");
  try {
    const result = await api.memory.embeddingIndex({ char_id: charId, limit: 200 });
    if (result.error !== "") {
      setText("embedding-note", "补索引失败：" + result.error);
      showBanner("补语义索引失败：" + result.error);
    } else {
      const text =
        "已补 " + String(result.indexed) + " 条，剩余 " + String(result.pending) + " 条待索引。";
      setText("embedding-note", text);
      showBanner(text);
    }
  } catch (error: unknown) {
    setText("embedding-note", "补索引失败：" + String(error));
    showBanner("补语义索引失败：" + String(error));
  } finally {
    embeddingIndexBusy = false;
    await refreshEmbeddingStatus(true);
  }
}

let embeddingStatusToken = 0;
let embeddingIndexBusy = false;
const EMBEDDING_MODEL_ID = "embedding-bge-small-zh";
let embeddingModelStatus: ModelStatus | null = null;
let embeddingConfig: MemoryEmbeddingConfig | null = null;
let embeddingModelProgress: ModelProgress | null = null;

function renderEmbeddingModel(): void {
  const state = byId("embedding-model-state");
  const download = byId("embedding-model-download");
  const remove = byId("embedding-model-remove");
  const toggle = byId("embedding-config-toggle");
  const installed = embeddingModelStatus?.installed === true;
  const enabled = embeddingConfig?.enabled === true;
  // 内置模型随安装包发布：既不能下载也不能删，只能启用/停用。
  const bundled = embeddingModelStatus?.kind === "bundled";
  if (embeddingModelProgress !== null && !embeddingModelProgress.done) {
    if (state !== null) {
      state.textContent =
        "下载中 " +
        String(embeddingModelProgress.percent) +
        "% · " +
        embeddingModelProgress.message;
    }
    for (const element of [download, remove, toggle]) {
      if (element instanceof HTMLButtonElement) {
        element.disabled = true;
      }
    }
    return;
  }
  if (embeddingModelStatus === null) {
    if (state !== null) {
      state.textContent = "模型目录里没有内置向量模型（发布包可能不完整）。";
    }
    if (download instanceof HTMLButtonElement) {
      download.disabled = false;
    }
    if (remove instanceof HTMLButtonElement) {
      remove.disabled = true;
    }
    if (toggle instanceof HTMLButtonElement) {
      toggle.disabled = true;
    }
    return;
  }
  if (state !== null) {
    state.textContent = bundled
      ? "已内置（随安装包）· 约 " + String(embeddingModelStatus.size_mb) + " MB"
      : installed
        ? "已下载 · 约 " + String(embeddingModelStatus.size_mb) + " MB"
        : "未下载 · 约 " + String(embeddingModelStatus.size_mb) + " MB";
  }
  if (download instanceof HTMLButtonElement) {
    download.disabled = installed || bundled;
  }
  if (remove instanceof HTMLButtonElement) {
    remove.disabled = bundled || !installed || enabled;
  }
  if (toggle instanceof HTMLButtonElement) {
    toggle.disabled = !installed;
    toggle.textContent = enabled ? "停用" : "启用";
  }
}

export async function refreshEmbeddingModel(): Promise<void> {
  try {
    const [models, config] = await Promise.all([
      api.models.list(),
      api.memory.embeddingConfig({ enabled: null }),
    ]);
    embeddingModelStatus = models.find((model) => model.id === EMBEDDING_MODEL_ID) ?? null;
    embeddingConfig = config;
    renderEmbeddingModel();
  } catch (error: unknown) {
    setText("embedding-model-state", "读不到向量模型状态：" + String(error));
  }
}

async function onEmbeddingModelDownload(): Promise<void> {
  if (embeddingModelStatus?.kind === "bundled") {
    setText("embedding-model-note", "内置模型随安装包发布，不需要下载。");
    return;
  }
  const button = byId("embedding-model-download");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  setText("embedding-model-note", "开始下载 BGE-M3，约 1.2 GB…");
  try {
    await api.models.install(EMBEDDING_MODEL_ID);
    setText("embedding-model-note", "模型下载完成。");
    showBanner("BGE-M3 下载完成。");
  } catch (error: unknown) {
    setText("embedding-model-note", "下载失败：" + String(error));
    showBanner("BGE-M3 下载失败：" + String(error));
  } finally {
    embeddingModelProgress = null;
    await refreshEmbeddingModel();
  }
}

async function onEmbeddingModelRemove(): Promise<void> {
  if (embeddingModelStatus?.kind === "bundled") {
    showBanner("内置模型随安装包发布，不能删除。");
    return;
  }
  if (embeddingConfig?.enabled === true) {
    showBanner("请先停用语义检索，再删除模型。");
    return;
  }
  if (!window.confirm("删除本机 Ollama 里的 BGE-M3？")) {
    return;
  }
  try {
    await api.models.remove(EMBEDDING_MODEL_ID);
    setText("embedding-model-note", "模型已删除。");
    showBanner("BGE-M3 已删除。");
  } catch (error: unknown) {
    setText("embedding-model-note", "删除失败：" + String(error));
  } finally {
    await refreshEmbeddingModel();
  }
}

async function onEmbeddingConfigToggle(): Promise<void> {
  const next = !(embeddingConfig?.enabled ?? false);
  try {
    embeddingConfig = await api.memory.embeddingConfig({ enabled: next });
    setText(
      "embedding-model-note",
      next
        ? "已写入配置；后台引擎已重启，约两秒后语义检索生效。"
        : "已写入配置；后台引擎已重启，语义检索将停用。",
    );
    renderEmbeddingModel();
    await refreshEmbeddingStatus();
  } catch (error: unknown) {
    setText("embedding-model-note", "保存配置失败：" + String(error));
  }
}

/** 语义索引页的接线：按钮与模型下载进度只在这里挂一次。 */
export function initEmbeddingPane(): void {
  byId("embedding-index")?.addEventListener("click", () => {
    void onEmbeddingIndexClicked();
  });
  byId("embedding-model-download")?.addEventListener("click", () => {
    void onEmbeddingModelDownload();
  });
  byId("embedding-model-remove")?.addEventListener("click", () => {
    void onEmbeddingModelRemove();
  });
  byId("embedding-config-toggle")?.addEventListener("click", () => {
    void onEmbeddingConfigToggle();
  });
  api.models.onProgress((progress) => {
    if (progress.id !== EMBEDDING_MODEL_ID) {
      return;
    }
    embeddingModelProgress = progress;
    renderEmbeddingModel();
    if (progress.done) {
      embeddingModelProgress = null;
      void refreshEmbeddingModel();
    }
  });
}
