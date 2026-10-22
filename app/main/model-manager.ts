import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, rename } from "node:fs/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MainLogger } from "./logger";

const execFileAsync = promisify(execFile);
const OLLAMA_BASE = "http://127.0.0.1:11434";
const MAX_REDIRECTS = 5;

export type ModelCapability = "asr" | "tts" | "vision";
export type ModelKind = "files" | "archive" | "ollama" | "external";

export interface ModelSourceFile {
  url: string;
  path: string;
}

export interface ModelSource {
  type: string;
  url?: string;
  files?: ModelSourceFile[];
  model?: string;
}

export interface ModelEntry {
  id: string;
  capability: ModelCapability;
  label: string;
  description: string;
  kind: ModelKind;
  target?: string;
  size_mb?: number;
  license?: string;
  source: ModelSource;
}

export interface ModelStatus {
  id: string;
  capability: ModelCapability;
  label: string;
  description: string;
  kind: ModelKind;
  size_mb: number;
  license: string;
  installed: boolean;
  detail: string;
  model_id: string;
}

export interface ModelProgress {
  id: string;
  percent: number;
  message: string;
  done: boolean;
  error: string;
}

interface Catalog {
  version: number;
  models: ModelEntry[];
}

export interface ModelManagerDeps {
  readonly dataDir: string;
  readonly catalogFile: string;
  readonly logger: MainLogger;
  readonly emit: (progress: ModelProgress) => void;
}

export class ModelManager {
  private catalog: Catalog | null = null;
  private running = new Set<string>();

  constructor(private readonly deps: ModelManagerDeps) {}

  async list(): Promise<ModelStatus[]> {
    const catalog = await this.loadCatalog();
    const ollama = await this.ollamaModels();
    return await Promise.all(
      catalog.models.map(async (entry) => {
        const installed = await this.isInstalled(entry, ollama);
        return {
          id: entry.id,
          capability: entry.capability,
          label: entry.label,
          description: entry.description,
          kind: entry.kind,
          size_mb: entry.size_mb ?? 0,
          license: entry.license ?? "",
          installed,
          model_id: entry.source.model ?? "",
          detail:
            entry.kind === "external"
              ? "外部服务，不占用本地模型目录"
              : entry.kind === "ollama"
                ? installed
                  ? "已在本机 Ollama 中"
                  : "未安装"
                : installed
                  ? "已安装"
                  : "未安装",
        };
      }),
    );
  }

  private async isInstalled(entry: ModelEntry, ollama: Set<string>): Promise<boolean> {
    if (entry.kind === "external") {
      return true;
    }
    if (entry.kind === "ollama") {
      return ollama.has(entry.source.model ?? "");
    }
    if (entry.target === undefined) {
      return false;
    }
    const target = this.targetPath(entry.target);
    try {
      await stat(target);
    } catch {
      return false;
    }
    if (entry.kind === "files" && entry.source.files !== undefined) {
      for (const file of entry.source.files) {
        try {
          await stat(join(target, file.path));
        } catch {
          return false;
        }
      }
    }
    return true;
  }

  async install(id: string): Promise<void> {
    if (this.running.has(id)) {
      return;
    }
    const entry = (await this.loadCatalog()).models.find((item) => item.id === id);
    if (entry === undefined) {
      throw new Error("没有这个模型：" + id);
    }
    if (entry.kind === "external") {
      throw new Error("这个模型由外部服务提供，不需要下载。");
    }
    this.running.add(id);
    try {
      if (entry.kind === "ollama") {
        await this.pullOllama(entry);
      } else {
        await this.downloadEntry(entry);
      }
    } finally {
      this.running.delete(id);
    }
  }

  async remove(id: string): Promise<void> {
    const entry = (await this.loadCatalog()).models.find((item) => item.id === id);
    if (entry === undefined || entry.kind === "external") {
      return;
    }
    if (entry.kind === "ollama") {
      await fetch(OLLAMA_BASE + "/api/delete", {
        method: "DELETE",
        body: JSON.stringify({ model: entry.source.model ?? "" }),
      });
      return;
    }
    if (entry.target !== undefined) {
      await rm(this.targetPath(entry.target), { recursive: true, force: true });
    }
  }

  private async loadCatalog(): Promise<Catalog> {
    if (this.catalog !== null) {
      return this.catalog;
    }
    const parsed: unknown = JSON.parse(await readFile(this.deps.catalogFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("模型目录格式不正确");
    }
    const record = parsed as { version?: unknown; models?: unknown };
    if (!Array.isArray(record.models)) {
      throw new Error("模型目录缺少 models");
    }
    this.catalog = {
      version: typeof record.version === "number" ? record.version : 1,
      models: record.models as ModelEntry[],
    };
    return this.catalog;
  }

  private targetPath(target: string): string {
    const root = resolve(this.deps.dataDir);
    const path = resolve(root, target);
    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error("模型目标路径越界：" + target);
    }
    return path;
  }

  private async downloadEntry(entry: ModelEntry): Promise<void> {
    if (entry.kind === "archive") {
      if (entry.target === undefined || entry.source.url === undefined) {
        throw new Error("压缩包模型缺少地址");
      }
      const target = this.targetPath(entry.target);
      await mkdir(target, { recursive: true });
      const archive = join(this.deps.dataDir, ".models", entry.id + ".tar.bz2");
      await mkdir(dirname(archive), { recursive: true });
      await this.download(entry.id, entry.source.url, archive, 0, 100);
      await execFileAsync("tar", ["-xjf", archive, "-C", target]);
      await rm(archive, { force: true });
      this.emitDone(entry.id, "安装完成");
      return;
    }
    if (entry.kind === "files") {
      if (entry.target === undefined || entry.source.files === undefined) {
        throw new Error("文件模型缺少地址");
      }
      const target = this.targetPath(entry.target);
      await mkdir(target, { recursive: true });
      const files = entry.source.files;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (file === undefined) {
          continue;
        }
        const start = Math.round((index / files.length) * 100);
        const span = Math.round(100 / files.length);
        await this.download(entry.id, file.url, join(target, file.path), start, start + span);
      }
      this.emitDone(entry.id, "安装完成");
    }
  }

  private async download(
    id: string,
    url: string,
    destination: string,
    basePercent: number,
    span: number,
  ): Promise<void> {
    const response = await this.openResponse(url);
    const total = Number(response.headers["content-length"] ?? "0");
    await mkdir(dirname(destination), { recursive: true });
    const temp = destination + ".part";
    const stream = createWriteStream(temp);
    let received = 0;
    let last = 0;
    await new Promise<void>((resolvePromise, reject) => {
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        const ratio = total > 0 ? received / total : 0;
        const percent = Math.min(99, basePercent + Math.round(ratio * span));
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          this.deps.emit({
            id,
            percent,
            message: total > 0 ? "下载中 " + String(received) + "/" + String(total) : "下载中",
            done: false,
            error: "",
          });
        }
      });
      response.pipe(stream);
      stream.on("finish", () => resolvePromise());
      stream.on("error", reject);
      response.on("error", reject);
    });
    await rename(temp, destination);
  }

  private openResponse(url: string, redirects = 0): Promise<IncomingMessage> {
    return new Promise((resolvePromise, reject) => {
      const getter = url.startsWith("https:") ? httpsGet : httpGet;
      const request = getter(url, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location !== undefined) {
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error("下载重定向过多"));
            return;
          }
          const next = new URL(response.headers.location, url).toString();
          void this.openResponse(next, redirects + 1).then(resolvePromise, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new Error("下载失败：" + String(status)));
          return;
        }
        resolvePromise(response);
      });
      request.on("error", reject);
    });
  }

  private async pullOllama(entry: ModelEntry): Promise<void> {
    const model = entry.source.model ?? "";
    const response = await fetch(OLLAMA_BASE + "/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!response.ok || response.body === null) {
      throw new Error("Ollama 不可用；先安装并启动 Ollama");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const status = this.ollamaStatus(line);
        if (status !== null) {
          this.deps.emit({ id: entry.id, ...status, done: false, error: "" });
        }
      }
    }
    this.emitDone(entry.id, "安装完成");
  }

  private ollamaStatus(line: string): { percent: number; message: string } | null {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      const total = typeof record["total"] === "number" ? record["total"] : 0;
      const completed = typeof record["completed"] === "number" ? record["completed"] : 0;
      const text = typeof record["status"] === "string" ? record["status"] : "拉取中";
      return {
        percent: total > 0 ? Math.min(99, Math.round((completed / total) * 100)) : 0,
        message: text,
      };
    } catch {
      return null;
    }
  }

  private async ollamaModels(): Promise<Set<string>> {
    try {
      const response = await fetch(OLLAMA_BASE + "/api/tags", {
        signal: AbortSignal.timeout(800),
      });
      if (!response.ok) {
        return new Set();
      }
      const body: unknown = await response.json();
      const models = (body as { models?: unknown }).models;
      if (!Array.isArray(models)) {
        return new Set();
      }
      return new Set(
        models
          .map((item) =>
            typeof item === "object" && item !== null
              ? (item as { name?: unknown }).name
              : undefined,
          )
          .filter((name): name is string => typeof name === "string"),
      );
    } catch {
      return new Set();
    }
  }

  private emitDone(id: string, message: string): void {
    this.deps.emit({ id, percent: 100, message, done: true, error: "" });
    this.deps.logger.info("models.installed", "模型安装完成", { id });
  }
}
