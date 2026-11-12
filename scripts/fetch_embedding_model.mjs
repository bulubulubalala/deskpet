#!/usr/bin/env node
/**
 * 文件职责：把内置向量模型（bge-small-zh-v1.5 的 int8 ONNX）拉到 assets/models/embedding（T2.40）。
 *
 * 为什么要有这个脚本而不是把权重提交进仓库：
 * - 22.9 MB 的二进制进 git 会把仓库越拖越大，且几乎每次都是全量 diff；
 * - 但「解压即用、运行时不下载」要求打包时文件必须已在 assets/models/embedding，
 *   所以让 prepack:win 依赖本脚本，打包前补齐（本地已有且大小对得上就直接跳过）。
 * 数据来源优先 ModelScope（国内可达），失败再退 HuggingFace。两条路径的文件必须同名，
 * 因为 sidecar/adapters/embeddings_local_onnx.py 里的 MODEL_FILE / TOKENIZER_FILE 是写死的。
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "models", "embedding");

/** 低于这个字节数就认为下载被截断（真实大小约 24 MB / 439 KB）。 */
const FILES = [
  { path: "onnx/model_quantized.onnx", name: "model_quantized.onnx", minBytes: 20 * 1024 * 1024 },
  { path: "tokenizer.json", name: "tokenizer.json", minBytes: 100 * 1024 },
];

const SOURCES = [
  (file) =>
    "https://www.modelscope.cn/api/v1/models/Xenova/bge-small-zh-v1.5/repo?Revision=master&FilePath=" +
    encodeURIComponent(file),
  (file) => "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/" + file,
];

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error("HTTP " + String(response.status));
  }
  const temp = dest + ".part";
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await rename(temp, dest);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const file of FILES) {
    const dest = join(OUT_DIR, file.name);
    const existing = await sizeOf(dest);
    if (existing >= file.minBytes) {
      console.log("已就位，跳过 " + file.name + "（" + String(existing) + " 字节）");
      continue;
    }
    let lastError = new Error("没有可用下载源");
    for (const build of SOURCES) {
      const url = build(file.path);
      try {
        console.log("下载 " + file.name + " ← " + url);
        await download(url, dest);
        const written = await sizeOf(dest);
        if (written < file.minBytes) {
          await rm(dest, { force: true });
          throw new Error("文件不完整（" + String(written) + " 字节）");
        }
        console.log("完成 " + file.name + "（" + String(written) + " 字节）");
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn("下载失败：" + lastError.message);
        await rm(dest + ".part", { force: true });
      }
    }
    if (lastError !== null) {
      throw new Error("内置向量模型下载失败（" + file.name + "）：" + lastError.message);
    }
  }
  console.log("内置向量模型已就绪：" + OUT_DIR);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
