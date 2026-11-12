/**
 * 文件职责：SidecarTransport 的协议单测——token 头、超时、取消、错误信封还原。
 *
 * 为什么单独测这一层：客户端 40 多个业务方法都压在这条路上，出问题的地方也都在这里
 * （先挂 error 监听还是先 abort、非 2xx 怎么读、超时后是否真的断开）。
 * 依赖方向：tests -> app/main/sidecar/transport.ts（起真的回环 http 服务，不 mock）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { MainLogger } from "../app/main/logger";
import { SidecarTransport } from "../app/main/sidecar/transport";
import {
  SidecarCancelledError,
  SidecarHttpError,
  SidecarUnavailableError,
} from "../app/main/sidecar/types";

interface TestServer {
  readonly port: number;
  readonly seen: {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    body: Buffer;
  }[];
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
  const seen: TestServer["seen"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
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
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function makeTransport(
  port: number,
  options: { requestTimeoutMs?: number } = {},
): SidecarTransport {
  const transport = new SidecarTransport(logger, options);
  transport.setEndpoint({ host: "127.0.0.1", port, token: "test-token" });
  return transport;
}

describe("SidecarTransport", () => {
  it("没设端点时直接说没就绪，不发请求", async () => {
    const transport = new SidecarTransport(logger);
    expect(transport.ready).toBe(false);
    await expect(transport.requestJson("POST", "/anything", {})).rejects.toBeInstanceOf(
      SidecarUnavailableError,
    );
  });

  it("带上回环 token 头，并把 JSON 请求体与长度一起发出去", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const transport = makeTransport(server.port);
      await expect(transport.requestJson("POST", "/probe", { a: 1 })).resolves.toEqual({
        ok: true,
      });
      expect(transport.ready).toBe(true);
      expect(server.seen).toHaveLength(1);
      const request = server.seen[0]!;
      expect(request.method).toBe("POST");
      expect(request.headers["x-deskpet-token"]).toBe("test-token");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["content-length"]).toBe(String(Buffer.byteLength('{"a":1}')));
      expect(request.body.toString("utf8")).toBe('{"a":1}');
    } finally {
      await server.close();
    }
  });

  it("非 2xx 还原错误信封，抛出带 code 与用户提示的 SidecarHttpError", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          detail: { code: "DP-MEM-001", message: "参数不合法", user_hint: "检查一下角色 id" },
        }),
      );
    });
    try {
      const transport = makeTransport(server.port);
      const error = await transport
        .requestJson("POST", "/memory/list", {})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SidecarHttpError);
      const httpError = error as SidecarHttpError;
      expect(httpError.status).toBe(400);
      expect(httpError.code).toBe("DP-MEM-001");
      expect(httpError.message).toContain("参数不合法");
      expect(httpError.userHint).toBe("检查一下角色 id");
    } finally {
      await server.close();
    }
  });

  it("超时后断开连接并说明超了多少毫秒", async () => {
    const server = await startServer(() => {
      // 故意不回，等客户端超时
    });
    try {
      const transport = makeTransport(server.port, { requestTimeoutMs: 80 });
      const error = await transport.requestJson("GET", "/slow", undefined).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SidecarUnavailableError);
      expect((error as Error).message).toContain("/slow 超时（80ms）");
    } finally {
      await server.close();
    }
  });

  it("信号已取消时立刻报取消，连不上的端口报连不上", async () => {
    const transport = new SidecarTransport(logger);
    const controller = new AbortController();
    controller.abort();
    transport.setEndpoint({ host: "127.0.0.1", port: 1, token: "t" });
    await expect(
      transport.open("GET", "/x", { signal: controller.signal, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(SidecarCancelledError);

    const dead = new SidecarTransport(logger);
    dead.setEndpoint({ host: "127.0.0.1", port: 1, token: "t" });
    const error = await dead.requestJson("GET", "/x", undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarUnavailableError);
    expect((error as Error).message).toContain("/x 连不上");
  });

  it("二进制请求与响应：content-type 可覆盖，缺头时给默认值", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([1, 2, 3]));
    });
    try {
      const transport = makeTransport(server.port);
      const response = await transport.open("POST", "/tts", {
        body: Buffer.from([9]),
        contentType: "application/octet-stream",
        timeoutMs: 2000,
      });
      expect(transport.header(response, "content-type", "?")).toBe("application/octet-stream");
      expect(transport.numberHeader(response, "x-missing")).toBe(0);
      expect(transport.header(response, "x-missing", "fallback")).toBe("fallback");
      expect([...(await transport.readBody(response))]).toEqual([1, 2, 3]);
      expect(server.seen[0]!.headers["content-type"]).toBe("application/octet-stream");
    } finally {
      await server.close();
    }
  });
});
