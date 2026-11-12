/**
 * 文件职责：「检查更新」的行为护栏——版本比较、地址白名单、四种回包。
 * 为什么用假 fetch：真实网络不该进测试；这里只验证「拿到什么回包就怎么说」。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_UPDATE_ENDPOINT,
  NOTES_MAX_LENGTH,
  RELEASE_PAGE_URL,
  UpdateChecker,
  compareVersions,
  isTrustedReleaseUrl,
  parseVersion,
  summarizeNotes,
} from "../app/main/update-check";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

/** 造一个真 Response：json() 的行为由 body 决定，坏 JSON 用假 HTML 正文来造。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function asFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

function checker(fetchImpl: typeof fetch, currentVersion = "0.2.0"): UpdateChecker {
  return new UpdateChecker({ currentVersion, logger, fetchImpl });
}

describe("parseVersion", () => {
  it("接受 v 前缀与缺段", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.2")).toEqual([0, 2]);
    expect(parseVersion(" 1.0.0 ")).toEqual([1, 0, 0]);
  });

  it("认不出来的返回 null", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });

  it("预发布后缀不参与比较", () => {
    expect(parseVersion("1.2.0-beta.1")).toEqual([1, 2, 0]);
  });
});

describe("compareVersions", () => {
  it("逐段比较，缺段按 0", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.2")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBe(-1);
  });
});

describe("isTrustedReleaseUrl", () => {
  it("只认 https 的 github.com", () => {
    expect(isTrustedReleaseUrl("https://github.com/a/b/releases/tag/v1")).toBe(true);
    expect(isTrustedReleaseUrl("http://github.com/a/b")).toBe(false);
    expect(isTrustedReleaseUrl("https://evil.example.com/a")).toBe(false);
    expect(isTrustedReleaseUrl("not a url")).toBe(false);
  });
});

describe("summarizeNotes", () => {
  it("去掉 markdown 记号并折叠空白", () => {
    expect(summarizeNotes("## 修复\n- **崩溃** [链接](https://x)")).toBe("修复 - 崩溃 链接");
  });

  it("超长截断到上限", () => {
    const notes = summarizeNotes("长".repeat(NOTES_MAX_LENGTH + 50));
    expect(notes.length).toBe(NOTES_MAX_LENGTH + 1);
    expect(notes.endsWith("…")).toBe(true);
  });
});

describe("UpdateChecker", () => {
  it("远端更新 → available，并记住下载页", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          tag_name: "v0.3.0",
          html_url: "https://github.com/bulubulubalala/deskpet/releases/tag/v0.3.0",
          body: "修复了很多问题",
        }),
      ),
    );
    const subject = checker(asFetch(fetchImpl));
    const info = await subject.check();
    expect(info.status).toBe("available");
    expect(info.latest_version).toBe("0.3.0");
    expect(info.current_version).toBe("0.2.0");
    expect(info.notes).toContain("修复");
    expect(subject.releaseUrl()).toBe(
      "https://github.com/bulubulubalala/deskpet/releases/tag/v0.3.0",
    );
  });

  it("同版本 → latest，下载页退回仓库发布页", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ tag_name: "v0.2.0", html_url: "https://x" })),
    );
    const subject = checker(asFetch(fetchImpl));
    const info = await subject.check();
    expect(info.status).toBe("latest");
    expect(info.url).toBe("");
    expect(subject.releaseUrl()).toBe(RELEASE_PAGE_URL);
  });

  it("404 → failed，并给一句人话", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({}, 404)));
    const info = await checker(asFetch(fetchImpl)).check();
    expect(info.status).toBe("failed");
    expect(info.error).toContain("还没有发布版本");
  });

  it("坏 JSON → failed 而不是抛出去", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("<html>404</html>", { status: 200 })),
    );
    const info = await checker(asFetch(fetchImpl)).check();
    expect(info.status).toBe("failed");
    expect(info.error).toContain("连不上更新服务器");
  });

  it("发布信息缺版本号 → failed", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ tag_name: "nightly" })));
    const info = await checker(asFetch(fetchImpl)).check();
    expect(info.status).toBe("failed");
    expect(info.error).toContain("没有版本号");
  });

  it("地址不是 github → 不把它交给浏览器", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ tag_name: "v9.9.9", html_url: "https://evil.example.com/x" })),
    );
    const info = await checker(asFetch(fetchImpl)).check();
    expect(info.status).toBe("available");
    expect(info.url).toBe("");
  });

  it("超时 → failed 且写明秒数", async () => {
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const subject = new UpdateChecker({
      currentVersion: "0.2.0",
      logger,
      fetchImpl: asFetch(fetchImpl),
      timeoutMs: 20,
    });
    const info = await subject.check();
    expect(info.status).toBe("failed");
    expect(info.error).toContain("超时");
  });

  it("默认打 GitHub 的 latest 接口；环境变量可覆盖", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ tag_name: "v0.2.0" })));
    await checker(asFetch(fetchImpl)).check();
    const calls = fetchImpl.mock.calls as unknown as string[][];
    expect(calls[0]?.[0]).toBe(process.env.DESKPET_UPDATE_ENDPOINT ?? DEFAULT_UPDATE_ENDPOINT);
  });
});
