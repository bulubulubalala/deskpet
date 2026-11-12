/**
 * 文件职责：「检查更新」——问一次 GitHub 的最新发布，跟当前版本比大小，给界面一句结论。
 *
 * 为什么单独一个文件：版本比较是纯函数（好测），网络与超时是一条可替换的 fetch；
 * 这里不碰 electron、不落盘、不下载安装包——便携版的升级仍然是用户自己去下 zip 覆盖。
 * 依赖方向：app/main/index.ts -> 本文件 -> node fetch / logger；不反向依赖界面与 sidecar。
 */
import type { AppUpdateInfo } from "../shared/contracts/ipc";
import type { MainLogger } from "./logger";

/** 发布页（给人看）；GitHub 不开 API 也能打开它。 */
export const RELEASE_PAGE_URL = "https://github.com/bulubulubalala/deskpet/releases/latest";
/** 查最新发布的 API；可用 DESKPET_UPDATE_ENDPOINT 覆盖（自建镜像或测试）。 */
export const DEFAULT_UPDATE_ENDPOINT =
  "https://api.github.com/repos/bulubulubalala/deskpet/releases/latest";
export const UPDATE_TIMEOUT_MS = 8_000;
/** 发布说明只留这么多字：设置窗里是一行提示，不是阅读器。 */
export const NOTES_MAX_LENGTH = 400;

/** 把 "v0.2.0" / "0.2.0" / "0.2" 拆成数字段；认不出来返回 null。 */
export function parseVersion(text: string): number[] | null {
  const trimmed = text.trim().replace(/^v/i, "");
  if (trimmed === "") return null;
  // 预发布/构建后缀（-beta.1、+build）不参与比较：只在正式版之间比大小
  const core = trimmed.split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  const numbers: number[] = [];
  for (const part of parts) {
    const match = /^(\d+)/.exec(part);
    if (match === null) return numbers.length > 0 ? numbers : null;
    const value = Number.parseInt(match[1] as string, 10);
    if (!Number.isFinite(value)) return null;
    numbers.push(value);
  }
  return numbers.length > 0 ? numbers : null;
}

/**
 * 比大小：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * 缺的段按 0 算（"1.2" 与 "1.2.0" 相等）；预发布后缀（-beta）不参与比较——
 * 便携版只发正式版，带上后缀只会让比较结果奇怪。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? [0];
  const right = parseVersion(b) ?? [0];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 只认 https 的 github.com：发布会话里拿到的地址不该把用户送去别处。 */
export function isTrustedReleaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      (url.hostname === "github.com" || url.hostname === "www.github.com")
    );
  } catch {
    return false;
  }
}

/** 发布说明压成一行：去 markdown 记号、折叠空白、截断。 */
export function summarizeNotes(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const flattened = raw
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > NOTES_MAX_LENGTH
    ? `${flattened.slice(0, NOTES_MAX_LENGTH)}…`
    : flattened;
}

export interface UpdateCheckerOptions {
  /** 当前版本，通常直接取 app.getVersion()。 */
  currentVersion: string;
  logger: Pick<MainLogger, "info" | "warn">;
  /** 便于单测注入；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

export class UpdateChecker {
  private readonly options: UpdateCheckerOptions;
  /** 这一次查到的最新版本（打开下载页时用）；没查到就是 null。 */
  private last: AppUpdateInfo | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.options = options;
  }

  /** 要打开的地址：这次查到的发布页，否则退回仓库的发布页。 */
  releaseUrl(): string {
    const url = this.last?.url ?? "";
    return url === "" ? RELEASE_PAGE_URL : url;
  }

  async check(): Promise<AppUpdateInfo> {
    const { currentVersion } = this.options;
    const endpoint =
      this.options.endpoint ?? process.env.DESKPET_UPDATE_ENDPOINT ?? DEFAULT_UPDATE_ENDPOINT;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? UPDATE_TIMEOUT_MS;

    const failed = (error: string): AppUpdateInfo => {
      const info: AppUpdateInfo = {
        status: "failed",
        current_version: currentVersion,
        latest_version: "",
        url: "",
        notes: "",
        error,
      };
      this.last = info;
      this.options.logger.warn("app.update_check_failed", "检查更新没查成", { reason: error });
      return info;
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(endpoint, {
        signal: controller.signal,
        headers: { accept: "application/vnd.github+json", "user-agent": "deskpet-update-check" },
      });
      if (!response.ok) {
        return failed(
          response.status === 404
            ? "仓库里还没有发布版本（也可能还没公开）。"
            : `更新服务器返回 ${response.status}。`,
        );
      }
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null) {
        return failed("更新服务器返回的内容看不懂。");
      }
      const record = payload as Record<string, unknown>;
      const tag = typeof record.tag_name === "string" ? record.tag_name : "";
      if (parseVersion(tag) === null) {
        return failed("发布信息里没有版本号。");
      }
      const notes = summarizeNotes(record.body ?? record.name);
      const rawUrl = typeof record.html_url === "string" ? record.html_url : "";
      const url = isTrustedReleaseUrl(rawUrl) ? rawUrl : "";

      if (compareVersions(tag, currentVersion) > 0) {
        const info: AppUpdateInfo = {
          status: "available",
          current_version: currentVersion,
          latest_version: tag.replace(/^v/i, ""),
          url,
          notes,
          error: "",
        };
        this.last = info;
        this.options.logger.info("app.update_available", "发现新版本", {
          current: currentVersion,
          latest: info.latest_version,
        });
        return info;
      }

      const info: AppUpdateInfo = {
        status: "latest",
        current_version: currentVersion,
        latest_version: tag.replace(/^v/i, ""),
        url,
        notes,
        error: "",
      };
      this.last = info;
      this.options.logger.info("app.update_latest", "已是最新版本", { current: currentVersion });
      return info;
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (aborted) return failed(`检查更新超时（${Math.round(timeoutMs / 1000)} 秒）。`);
      const reason = error instanceof Error ? error.message : String(error);
      return failed(`连不上更新服务器（${reason}）。`);
    } finally {
      clearTimeout(timer);
    }
  }
}
