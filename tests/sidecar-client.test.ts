/**
 * 文件职责：SidecarClient 的协议单测——SSE 解析、二进制合成、裸 PCM 识别、错误信封还原。
 *
 * 为什么用真的 node:http 服务端：这个模块的难点全在 HTTP/SSE 细节（分块边界、坏行、状态码），
 * mock 掉 http 就测不到；同时它不依赖 Electron，可以用回环端口直接跑。
 * 依赖方向：tests -> app/main/sidecar-client.ts（不起 sidecar 进程）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { ChatEvent } from "../app/main/ipc";
import type { MainLogger } from "../app/main/logger";
import {
  SidecarCancelledError,
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
  it("把 SSE 逐行交给 onEvent，跨分块的 JSON 与坏行都能正确处理", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // 故意把一行的 JSON 拆到两个 chunk 里，验证缓冲拼接
      res.write('data: {"t":"s","i":0,"te');
      res.write('xt":"第一句","intensity":0.5}\n\n');
      res.write("event: ping\n"); // 不是 data: 行
      res.write("data: {坏掉的 JSON\n"); // 解析失败
      res.write('data: {"t":"x","i":9}\n'); // 未知事件类型
      res.write('data: {"t":"end"}'); // 结尾不带换行
      res.end();
    });
    const client = makeClient(server.port);
    const events: ChatEvent[] = [];
    await client.streamChat(
      { session_id: "s1", char_id: "amber", text: "你好" },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    expect(events.map((event) => event.t)).toEqual(["s", "end"]);
    expect(events[0]).toMatchObject({ t: "s", text: "第一句" });
    const first = server.requests[0];
    expect(first?.method).toBe("POST");
    expect(first?.url).toBe("/chat/stream");
    expect(first?.headers["x-deskpet-token"]).toBe("test-token");
    expect(JSON.parse(first?.body.toString("utf8") ?? "")).toMatchObject({ char_id: "amber" });
    await server.close();
  });

  it("缺少端点时直接报不可用，不去连网络", async () => {
    const client = new SidecarClient(logger);
    await expect(
      client.streamChat(
        { session_id: "s1", char_id: "amber", text: "你好" },
        { onEvent: () => {} },
      ),
    ).rejects.toThrow(SidecarUnavailableError);
    expect(client.ready).toBe(false);
  });

  it("synthesize 读二进制音频与性能头", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "X-Deskpet-Request-Id": "req-7",
        "X-Deskpet-Gen-Ms": "1234",
        "X-Deskpet-Audio-Ms": "3000",
        "X-Deskpet-Rtf": "0.41",
        "X-Deskpet-Voice": "amber.wav",
      });
      res.end(Buffer.from([82, 73, 70, 70]));
    });
    const client = makeClient(server.port);
    const result = await client.synthesize({
      text: "你好",
      voiceId: "amber.wav",
      lang: "zh",
      emoVector: [0, 0, 0, 0, 0, 0, 0, 0.6],
      requestId: "req-7",
    });
    expect(result.audio.equals(Buffer.from([82, 73, 70, 70]))).toBe(true);
    expect(result.requestId).toBe("req-7");
    expect(result.genMs).toBe(1234);
    expect(result.audioMs).toBe(3000);
    expect(result.rtf).toBeCloseTo(0.41);
    expect(result.voice).toBe("amber.wav");
    const sent = JSON.parse(server.requests[0]?.body.toString("utf8") ?? "") as Record<
      string,
      unknown
    >;
    expect(sent["text"]).toBe("你好");
    expect(sent["emo_vector"]).toHaveLength(8);
    await server.close();
  });

  it("transcribe 发送裸 PCM 与查询参数", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "你好", confidence: 0.8, duration_s: 1.5, language: "zh" }));
    });
    const client = makeClient(server.port);
    const result = await client.transcribe({
      pcm: Buffer.from([1, 2, 3, 4]),
      sampleRate: 16000,
      requestId: "asr-1",
      lang: "zh",
    });
    expect(result).toEqual({ text: "你好", confidence: 0.8, durationS: 1.5, language: "zh" });
    const sent = server.requests[0];
    expect(sent?.url).toBe("/asr?sample_rate=16000&request_id=asr-1&lang=zh");
    expect(sent?.headers["content-type"]).toBe("application/octet-stream");
    expect(sent?.body.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    await server.close();
  });

  it("transcribe 缺 language 时返回 null（不假装识别出语言）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "", confidence: 0, duration_s: 0.0 }));
    });
    const client = makeClient(server.port);
    const result = await client.transcribe({
      pcm: Buffer.from([0, 0]),
      sampleRate: 16000,
      requestId: "asr-2",
    });
    expect(result).toEqual({ text: "", confidence: 0, durationS: 0, language: null });
    expect(server.requests[0]?.url).toBe("/asr?sample_rate=16000&request_id=asr-2");
    await server.close();
  });

  it("错误信封两种形状都还原成 SidecarHttpError", async () => {
    const flat = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "DP-SYS-401", message: "未授权", user_hint: "带上 token" }));
    });
    const flatClient = makeClient(flat.port);
    await expect(flatClient.cancelTts("req-1")).rejects.toMatchObject({
      name: "SidecarHttpError",
      status: 401,
      code: "DP-SYS-401",
      userHint: "带上 token",
    });
    await flat.close();

    const wrapped = await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: { code: "DP-TTS-500", message: "合成失败" } }));
    });
    const wrappedClient = makeClient(wrapped.port);
    const error = await wrappedClient.cancelTts("req-2").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SidecarHttpError);
    expect((error as SidecarHttpError).code).toBe("DP-TTS-500");
    expect((error as SidecarHttpError).userHint).toBeUndefined();
    await wrapped.close();
  });

  it("cancelTts 解析 cancelled 与 reason", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cancelled: false, reason: "already_done" }));
    });
    const client = makeClient(server.port);
    expect(await client.cancelTts("req-9")).toEqual({ cancelled: false, reason: "already_done" });
    const sent = JSON.parse(server.requests[0]?.body.toString("utf8") ?? "") as Record<
      string,
      unknown
    >;
    expect(sent["request_id"]).toBe("req-9");
    await server.close();
  });

  it("连不上时抛 SidecarUnavailableError（不是业务错误）", async () => {
    const probe = await startServer((_req, res) => {
      res.end();
    });
    const port = probe.port;
    await probe.close();
    const client = makeClient(port);
    await expect(client.cancelTts("req-1")).rejects.toMatchObject({
      name: "SidecarUnavailableError",
    });
  });

  it("调用方 abort 抛 SidecarCancelledError（打断不是故障）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    const client = makeClient(server.port);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.streamChat(
        { session_id: "s1", char_id: "amber", text: "你好" },
        { signal: controller.signal, onEvent: () => {} },
      ),
    ).rejects.toThrow(SidecarCancelledError);
    await server.close();
  });
});
