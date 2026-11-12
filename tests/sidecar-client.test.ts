/**
 * 文件职责：SidecarClient 的协议单测——请求体拼法、查询串、返回值解析、错误信封还原。
 *
 * 为什么用真的 node:http 服务端：这个模块的难点全在 HTTP/SSE 细节（分块边界、坏行、状态码），
 * mock 掉 http 就测不到；同时它不依赖 Electron，可以用回环端口直接跑。
 * 依赖方向：tests -> app/main/sidecar-client.ts（不起 sidecar 进程）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { MainLogger } from "../app/main/logger";
import {
  SidecarClient,
  SidecarHttpError,
  SidecarUnavailableError,
} from "../app/main/sidecar-client";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

interface TestServer {
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

const logger: MainLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
};

async function startServer(
  respond: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function makeClient(port: number): SidecarClient {
  const client = new SidecarClient(logger);
  client.setEndpoint({ host: "127.0.0.1", port, token: "test-token" });
  return client;
}

describe("SidecarClient", () => {
  it("错误信封两种形状都还原成 SidecarHttpError", async () => {
    const flat = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "DP-SYS-401", message: "未授权", user_hint: "带上 token" }));
    });
    const flatClient = makeClient(flat.port);
    await expect(flatClient.exportData()).rejects.toMatchObject({
      name: "SidecarHttpError",
      status: 401,
      code: "DP-SYS-401",
      userHint: "带上 token",
    });
    await flat.close();

    const wrapped = await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: { code: "DP-MEM-500", message: "记忆改写失败" } }));
    });
    const wrappedClient = makeClient(wrapped.port);
    const error = await wrappedClient.exportData().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SidecarHttpError);
    expect((error as SidecarHttpError).code).toBe("DP-MEM-500");
    expect((error as SidecarHttpError).userHint).toBeUndefined();
    await wrapped.close();
  });

  it("连不上时抛 SidecarUnavailableError（不是业务错误）", async () => {
    const probe = await startServer((_req, res) => {
      res.end();
    });
    const port = probe.port;
    await probe.close();
    const client = makeClient(port);
    await expect(client.exportData()).rejects.toBeInstanceOf(SidecarUnavailableError);
  });

  it("exportData 打 POST /data/export 并还原包摘要（M3）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          path: "C:/deskpet/data/exports/deskpet-export-20261109-120000.zip",
          bytes: 1234,
          created_at: "2026-11-09T12:00:00",
          entries: ["memories.db", 7, "settings.json"],
          skipped: ["角色目录读不出来"],
        }),
      );
    });
    const client = makeClient(server.port);
    expect(await client.exportData()).toEqual({
      path: "C:/deskpet/data/exports/deskpet-export-20261109-120000.zip",
      bytes: 1234,
      created_at: "2026-11-09T12:00:00",
      entries: ["memories.db", "settings.json"],
      skipped: ["角色目录读不出来"],
    });
    expect(server.requests[0]?.method).toBe("POST");
    expect(server.requests[0]?.url).toBe("/data/export");
    await server.close();
  });

  it("exportData 对空响应回空摘要而不抛（界面少一行好过整块崩）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    });
    const client = makeClient(server.port);
    expect(await client.exportData()).toEqual({
      path: "",
      bytes: 0,
      created_at: "",
      entries: [],
      skipped: [],
    });
    await server.close();
  });

  it("restoreData 打 POST /data/restore 并把包路径发过去（M3）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          archive: "C:/deskpet/data/exports/deskpet-export-20261109-120000.zip",
          db_bytes: 2048,
          pending_path: "C:/deskpet/data/restore-pending/memories.db",
          entries: ["memories.db", 9, "settings.json"],
          restart_required: true,
        }),
      );
    });
    const client = makeClient(server.port);
    expect(await client.restoreData("C:/tmp/pack.zip")).toEqual({
      archive: "C:/deskpet/data/exports/deskpet-export-20261109-120000.zip",
      db_bytes: 2048,
      pending_path: "C:/deskpet/data/restore-pending/memories.db",
      entries: ["memories.db", "settings.json"],
      restart_required: true,
    });
    expect(server.requests[0]?.method).toBe("POST");
    expect(server.requests[0]?.url).toBe("/data/restore");
    expect(JSON.parse(server.requests[0]?.body.toString("utf8") ?? "{}")).toEqual({
      path: "C:/tmp/pack.zip",
    });
    await server.close();
  });

  it("restoreData 缺 restart_required 时按「需要重启」处理（宁可多提示一次）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ db_bytes: 1 }));
    });
    const client = makeClient(server.port);
    expect(await client.restoreData("C:/tmp/pack.zip")).toEqual({
      archive: "",
      db_bytes: 1,
      pending_path: "",
      entries: [],
      restart_required: true,
    });
    await server.close();
  });

  it("listBackups 打 GET /data/backups，坏 kind 退成 other、坏数字退 0（D9）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          dir: "C:/deskpet/data/backups",
          total_bytes: 4096,
          entries: [
            {
              file: "memories-20261109.db",
              kind: "daily",
              bytes: 2048,
              modified_at: 1_700_000_000,
            },
            {
              file: "memories-replaced-20261109-120000.db",
              kind: "replaced",
              bytes: 1024,
              modified_at: 1_700_100_000,
            },
            { file: "weird.db", kind: "unknown", bytes: "big", modified_at: null },
            { kind: "daily", bytes: 1, modified_at: 1 },
            "not-an-object",
          ],
        }),
      );
    });
    const client = makeClient(server.port);
    expect(await client.listBackups()).toEqual({
      dir: "C:/deskpet/data/backups",
      total_bytes: 4096,
      entries: [
        { file: "memories-20261109.db", kind: "daily", bytes: 2048, modified_at: 1_700_000_000 },
        {
          file: "memories-replaced-20261109-120000.db",
          kind: "replaced",
          bytes: 1024,
          modified_at: 1_700_100_000,
        },
        { file: "weird.db", kind: "other", bytes: 0, modified_at: 0 },
      ],
    });
    expect(server.requests[0]?.method).toBe("GET");
    expect(server.requests[0]?.url).toBe("/data/backups");
    await server.close();
  });

  it("backupNow 打 POST /data/backup，没做成时回空路径（D9）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: "", file: "", bytes: 0 }));
    });
    const client = makeClient(server.port);
    expect(await client.backupNow()).toEqual({ path: "", file: "", bytes: 0 });
    expect(server.requests[0]?.method).toBe("POST");
    expect(server.requests[0]?.url).toBe("/data/backup");
    await server.close();
  });

  it("testProvider 打 POST /providers/test 并还原结论（含坏条目丢弃）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          capability: "llm",
          results: [
            {
              provider: "cloud",
              base_url: "https://cloud.example.com/v1",
              model: "cloud-model",
              ok: true,
              detail: "HTTP 200，OpenAI 兼容响应",
              elapsed_ms: 42,
            },
            { provider: "local", ok: false, detail: "连不上（ConnectError）", elapsed_ms: 3 },
            { provider: "坏了" },
            "not-an-object",
          ],
        }),
      );
    });
    const client = makeClient(server.port);
    const report = await client.testProvider({ capability: "llm" });
    expect(report.capability).toBe("llm");
    expect(report.results).toEqual([
      {
        provider: "cloud",
        base_url: "https://cloud.example.com/v1",
        model: "cloud-model",
        ok: true,
        detail: "HTTP 200，OpenAI 兼容响应",
        elapsed_ms: 42,
      },
      {
        provider: "local",
        ok: false,
        detail: "连不上（ConnectError）",
        elapsed_ms: 3,
      },
    ]);
    const request = server.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/providers/test");
    expect(request?.headers["x-deskpet-token"]).toBe("test-token");
    expect(JSON.parse(request?.body.toString("utf8") ?? "")).toEqual({ capability: "llm" });
    await server.close();
  });

  it("listMemories 打 GET /memory/list，查询串只带非空筛选，坏条目丢弃（T2.1b）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 7,
              char_id: "amber",
              kind: "fact",
              tier: "fact",
              text: "用户养了一只叫团子的猫",
              importance: 0.8,
              created_at: "2026-10-16T01:28:00+08:00",
              last_used_at: "",
              used_count: 2,
              source_msg_ids: "",
            },
            { id: "坏", text: 3 },
            "not-an-object",
          ],
        }),
      );
    });
    const client = makeClient(server.port);
    const items = await client.listMemories({
      char_id: "amber",
      kind: "",
      tier: "fact",
      limit: 50,
    });
    expect(items).toEqual([
      {
        id: 7,
        char_id: "amber",
        kind: "fact",
        tier: "fact",
        text: "用户养了一只叫团子的猫",
        importance: 0.8,
        created_at: "2026-10-16T01:28:00+08:00",
        last_used_at: "",
        used_count: 2,
        source_msg_ids: "",
      },
    ]);
    const request = server.requests[0];
    expect(request?.method).toBe("GET");
    // 空 kind 不上送：sidecar 用「键不出现」表示不过滤，所以这里只该有 char_id / tier / limit
    expect(request?.url).toBe("/memory/list?char_id=amber&tier=fact&limit=50");
    expect(request?.headers["x-deskpet-token"]).toBe("test-token");
    await server.close();
  });

  it("deleteMemory 打 DELETE /memory/{id}，deleted=false 说明本来就没有", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deleted: false }));
    });
    const client = makeClient(server.port);
    expect(await client.deleteMemory(12)).toBe(false);
    expect(server.requests[0]?.method).toBe("DELETE");
    expect(server.requests[0]?.url).toBe("/memory/12");
    await server.close();
  });

  it("clearMemories 打 POST /memory/clear：完整重置只发送 char_id", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          deleted: 5,
          snapshot: "C:/deskpet/data/backups/memories-before-memory-clear-20261109-130000.db",
        }),
      );
    });
    const client = makeClient(server.port);
    expect(await client.clearMemories({ char_id: "amber" })).toEqual({
      deleted: 5,
      snapshot: "C:/deskpet/data/backups/memories-before-memory-clear-20261109-130000.db",
    });
    const first = server.requests[0];
    expect(first?.method).toBe("POST");
    expect(first?.url).toBe("/memory/clear");
    expect(JSON.parse(first?.body.toString("utf8") ?? "")).toEqual({ char_id: "amber" });
    await server.close();
  });

  it("memoryEmbeddingStatus 打 GET /memory/embeddings/status（T2.32）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          enabled: true,
          available: false,
          model: "bge-small-zh-v1.5:int8@1",
          provider: "onnx",
          model_dir: "C:/deskpet/models/embedding",
          base_url: "",
          indexed: 4,
          pending: 2,
          error: "offline",
        }),
      );
    });
    const client = makeClient(server.port);
    const status = await client.memoryEmbeddingStatus("小玉");
    expect(status).toEqual({
      enabled: true,
      available: false,
      model: "bge-small-zh-v1.5:int8@1",
      provider: "onnx",
      model_dir: "C:/deskpet/models/embedding",
      base_url: "",
      indexed: 4,
      pending: 2,
      error: "offline",
    });
    expect(server.requests[0]?.method).toBe("GET");
    expect(server.requests[0]?.url).toBe(
      "/memory/embeddings/status?char_id=" + encodeURIComponent("小玉"),
    );
    await server.close();
  });

  it("indexMemoryEmbeddings 打 POST /memory/embeddings/index：limit 省略时不上送（T2.32）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ indexed: 3, pending: 1, error: "" }));
    });
    const client = makeClient(server.port);
    expect(await client.indexMemoryEmbeddings({ char_id: "xiaoyu", limit: 50 })).toEqual({
      indexed: 3,
      pending: 1,
      error: "",
    });
    expect(JSON.parse(server.requests[0]?.body.toString("utf8") ?? "")).toEqual({
      char_id: "xiaoyu",
      limit: 50,
    });
    expect(server.requests[0]?.url).toBe("/memory/embeddings/index");
    await client.indexMemoryEmbeddings({ char_id: "xiaoyu" });
    expect(JSON.parse(server.requests[1]?.body.toString("utf8") ?? "")).toEqual({
      char_id: "xiaoyu",
    });
    await server.close();
  });

  it("editMemory 打 PATCH /memory/{id}：importance 省略时不进请求体（T2.3-B2）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          updated: true,
          merged: false,
          item: {
            id: 7,
            kind: "fact",
            tier: "fact",
            text: "用户养了一只狗",
            importance: 0.9,
            created_at: "2026-10-18T01:00:00+08:00",
            last_used_at: "",
            used_count: 0,
          },
        }),
      );
    });
    const client = makeClient(server.port);
    const first = await client.editMemory({ memory_id: 7, text: "用户养了一只狗" });
    expect(first.updated).toBe(true);
    expect(first.merged).toBe(false);
    expect(first.item?.text).toBe("用户养了一只狗");
    await client.editMemory({ memory_id: 7, text: "用户养了一只狗", importance: 0.9 });
    expect(server.requests[0]?.method).toBe("PATCH");
    expect(server.requests[0]?.url).toBe("/memory/7");
    expect(JSON.parse(server.requests[0]?.body.toString("utf8") ?? "")).toEqual({
      text: "用户养了一只狗",
    });
    expect(JSON.parse(server.requests[1]?.body.toString("utf8") ?? "")).toEqual({
      text: "用户养了一只狗",
      importance: 0.9,
    });
    await server.close();
  });

  it("editMemory 对不存在的 id 回 updated=false 且 item 为 null（T2.3-B2）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ updated: false, merged: false, item: null }));
    });
    const client = makeClient(server.port);
    const result = await client.editMemory({ memory_id: 999, text: "随便" });
    expect(result).toEqual({ updated: false, merged: false, item: null });
    await server.close();
  });

  it("listMessages 打 GET /memory/messages：limit 必带、before_id 有值才带，坏行丢弃（T2.3-B1）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            {
              message_id: 9,
              session_id: "s1",
              role: "assistant",
              text: "在",
              created_at: "2026-10-18T01:00:00+08:00",
              token_len: 1,
              covered_by: 3,
            },
            { message_id: "坏", text: 2 },
            "not-an-object",
          ],
          has_more: true,
        }),
      );
    });
    const client = makeClient(server.port);
    const first = await client.listMessages({ char_id: "amber", limit: 50, before_id: 9 });
    expect(first.items).toEqual([
      {
        message_id: 9,
        session_id: "s1",
        role: "assistant",
        text: "在",
        created_at: "2026-10-18T01:00:00+08:00",
        token_len: 1,
        covered_by: 3,
      },
    ]);
    expect(first.has_more).toBe(true);
    // before_id = null 时不上送（表示「最新一页」），否则 sidecar 会当成真的翻页
    await client.listMessages({ char_id: "amber", limit: 50, before_id: null });
    expect(server.requests[0]?.url).toBe("/memory/messages?char_id=amber&limit=50&before_id=9");
    expect(server.requests[1]?.url).toBe("/memory/messages?char_id=amber&limit=50");
    expect(server.requests[0]?.method).toBe("GET");
    await server.close();
  });

  it("memoryContext 打 GET /memory/context：解析六段与最终文本，坏条目丢弃（T2.3-B1）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          char_id: "amber",
          query: "团子",
          empty: false,
          total_tokens: 30,
          budget_tokens: 2600,
          dropped: ["l2", 7],
          injected_ids: [4, "坏"],
          sections: [
            {
              name: "facts",
              title: "长期记忆（L0）",
              budget_tokens: 400,
              used_tokens: 12,
              dropped: false,
              items: [
                {
                  text: "用户养了一只叫团子的猫",
                  tokens: 12,
                  ref_id: 4,
                  kind: "fact",
                  role: "",
                  importance: 0.8,
                },
                { text: 3 },
              ],
            },
            { name: 7 },
          ],
          text: "【长期记忆（L0）】",
        }),
      );
    });
    const client = makeClient(server.port);
    const context = await client.memoryContext({ char_id: "amber", query: "团子" });
    expect(context.dropped).toEqual(["l2"]);
    expect(context.injected_ids).toEqual([4]);
    expect(context.sections).toHaveLength(1);
    expect(context.sections[0]?.name).toBe("facts");
    expect(context.sections[0]?.items).toEqual([
      {
        text: "用户养了一只叫团子的猫",
        tokens: 12,
        ref_id: 4,
        kind: "fact",
        role: "",
        importance: 0.8,
      },
    ]);
    expect(context.text).toBe("【长期记忆（L0）】");
    expect(context.budget_tokens).toBe(2600);
    expect(server.requests[0]?.url).toBe(
      "/memory/context?char_id=amber&query=" + encodeURIComponent("团子"),
    );
    // query 留空时不上送（= 没有新话题时的基础注入）
    await client.memoryContext({ char_id: "amber", query: "" });
    expect(server.requests[1]?.url).toBe("/memory/context?char_id=amber");
    await server.close();
  });
  it("memoryTimeline / periodDetail 打时间线接口并解析来源（T2.33）", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.startsWith("/memory/timeline/7")) {
        res.end(
          JSON.stringify({
            id: 7,
            char_id: "xiaoyu",
            level: "day",
            period_start: "2026-10-31T00:00:00+08:00",
            period_end: "2026-11-01T00:00:00+08:00",
            label: "2026-10-31",
            day_key: "2026-10-31",
            summary: "今天聊了面试。",
            source_count: 1,
            edited: false,
            sources: [["message", 3]],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          items: [
            {
              id: 7,
              char_id: "xiaoyu",
              level: "day",
              period_start: "2026-10-31T00:00:00+08:00",
              period_end: "2026-11-01T00:00:00+08:00",
              label: "2026-10-31",
              day_key: "2026-10-31",
              summary: "今天聊了面试。",
              source_count: 1,
              edited: false,
            },
          ],
        }),
      );
    });
    const client = makeClient(server.port);
    const timeline = await client.memoryTimeline({
      char_id: "xiaoyu",
      levels: "day",
      limit: 20,
    });
    expect(timeline.items[0]?.summary).toBe("今天聊了面试。");
    expect(server.requests[0]?.url).toBe("/memory/timeline?char_id=xiaoyu&levels=day&limit=20");
    const detail = await client.memoryPeriodDetail(7);
    expect(detail.sources).toEqual([["message", 3]]);
    await server.close();
  });

  it("日记与关系记忆客户端解析正确字段（T2.33）", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/memory/diary") {
        res.end(
          JSON.stringify({
            items: [],
            id: 5,
            char_id: "xiaoyu",
            text: "今天有点累。",
            occurred_at: "2026-10-31T20:00:00+08:00",
            mood: "累",
            tags: "工作",
            created_at: "2026-10-31T20:00:00+08:00",
            updated_at: "2026-10-31T20:00:00+08:00",
          }),
        );
        return;
      }
      if (req.url === "/memory/diary/5") {
        if (req.method === "DELETE") {
          res.end(JSON.stringify({ deleted: true }));
          return;
        }
        res.end(
          JSON.stringify({
            id: 5,
            char_id: "xiaoyu",
            text: "改过了",
            occurred_at: "2026-10-31T20:00:00+08:00",
            mood: "累",
            tags: "工作",
            created_at: "2026-10-31T20:00:00+08:00",
            updated_at: "2026-10-31T20:00:00+08:00",
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          char_id: "xiaoyu",
          familiarity: 0.7,
          trust: 0.8,
          warmth: 0.6,
          unresolved: "面试结果",
          recent_conflict: "",
          updated_at: "2026-10-31T20:00:00+08:00",
        }),
      );
    });
    const client = makeClient(server.port);
    expect((await client.listDiary({ char_id: "xiaoyu" })).items).toEqual([]);
    expect((await client.addDiary({ char_id: "xiaoyu", text: "今天有点累。" })).mood).toBe("累");
    expect((await client.updateDiary({ entry_id: 5, text: "改过了" })).id).toBe(5);
    expect(await client.deleteDiary(5)).toBe(true);
    expect((await client.memoryRelation("xiaoyu")).trust).toBe(0.8);
    expect(
      (
        await client.saveMemoryRelation("xiaoyu", {
          familiarity: 0.7,
          trust: 0.8,
          warmth: 0.6,
          unresolved: "面试结果",
          recent_conflict: "",
        })
      ).unresolved,
    ).toBe("面试结果");
    await server.close();
  });

  it("recordUsage 打 POST /usage/record（T2.3-C1）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recorded: true }));
    });
    const client = makeClient(server.port);
    expect(await client.recordUsage({ fact: "window_shake", char_id: "amber" })).toBe(true);
    const request = server.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/usage/record");
    expect(JSON.parse(request?.body.toString("utf8") ?? "")).toEqual({
      fact: "window_shake",
      char_id: "amber",
    });
    await server.close();
  });

  it("recordUsage 带部位与连击时把可选字段一起发出去（T2.3-C2）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recorded: true }));
    });
    const client = makeClient(server.port);
    expect(
      await client.recordUsage({
        fact: "char_hit",
        char_id: "amber",
        region_id: "head",
        gesture: "tap",
        count: 4,
      }),
    ).toBe(true);
    const request = server.requests[0];
    expect(request?.url).toBe("/usage/record");
    expect(JSON.parse(request?.body.toString("utf8") ?? "")).toEqual({
      fact: "char_hit",
      char_id: "amber",
      region_id: "head",
      gesture: "tap",
      count: 4,
    });
    await server.close();
  });

  it("asrModel 打 GET /asr/model，字段逐一读回来（D7）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "downloading",
          provider: "local",
          model: "small",
          downloaded_bytes: 122_000_000,
          estimated_bytes: 488_000_000,
          progress: 0.25,
          message: "正在下载语音识别模型…已下载 116 MB。",
          user_hint: "下完会自动可用。",
        }),
      );
    });
    const client = makeClient(server.port);
    const state = await client.asrModel();
    expect(server.requests[0]?.method).toBe("GET");
    expect(server.requests[0]?.url).toBe("/asr/model");
    expect(state).toMatchObject({
      status: "downloading",
      provider: "local",
      model: "small",
      downloaded_bytes: 122_000_000,
      estimated_bytes: 488_000_000,
      progress: 0.25,
    });
    await server.close();
  });

  it("asrModel 遇到坏状态/坏数字按「还没下载」兜底（D7）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "weird", progress: 9, downloaded_bytes: -1, model: null }));
    });
    const client = makeClient(server.port);
    const state = await client.asrModel();
    expect(state.status).toBe("missing");
    expect(state.progress).toBe(1);
    expect(state.downloaded_bytes).toBe(0);
    expect(state.model).toBe("");
    await server.close();
  });

  it("prefetchAsrModel 打 POST /asr/model/prefetch", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "downloading", progress: 0 }));
    });
    const client = makeClient(server.port);
    expect((await client.prefetchAsrModel()).status).toBe("downloading");
    expect(server.requests[0]?.method).toBe("POST");
    expect(server.requests[0]?.url).toBe("/asr/model/prefetch");
    await server.close();
  });

  it("recordUsage 拿不到 recorded 字段时当没记上（不假设成功）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const client = makeClient(server.port);
    expect(await client.recordUsage({ fact: "window_shake", char_id: "" })).toBe(false);
    await server.close();
  });
});
