/**
 * 文件职责：跨语言契约测试 —— 比对 TS 侧 IPC 契约与 Python 侧导出的 OpenAPI 快照。
 *
 * 为什么：需求 §6.3 的契约在两侧各有一份定义（Pydantic 与 TS 类型），字段名或枚举
 * 只要有一侧漂移，这里就会红（CODE_STYLE §1.8：改契约必须同时改两侧）。
 * 依赖方向：tests -> app/main/ipc.ts 与 sidecar/contracts/openapi.json（只读）。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CHAT_EVENT_FIELDS,
  CHAT_EVENT_KINDS,
  type ChatEventKind,
  GPU_USAGE_FIELDS,
  HEALTH_SNAPSHOT_FIELDS,
  IPC_CHANNELS,
  MODULE_HEALTH_FIELDS,
  MODULE_NAMES,
  MODULE_STATES,
  VOICE_STATES,
} from "../app/main/ipc";

interface SchemaObject {
  properties?: Record<string, unknown>;
  enum?: string[];
  const?: string;
}

interface OperationObject {
  responses?: Record<string, { content?: Record<string, { schema?: SchemaObject }> }>;
}

interface OpenApiDocument {
  components: { schemas: Record<string, SchemaObject> };
  paths: Record<string, Record<string, OperationObject>>;
}

interface LlmEventsSchema {
  $defs: Record<string, SchemaObject>;
}

const OPENAPI_PATH = "sidecar/contracts/openapi.json";
const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDocument;

const LLM_EVENTS_PATH = "sidecar/contracts/llm_events.schema.json";
const llmEvents = JSON.parse(readFileSync(LLM_EVENTS_PATH, "utf8")) as LlmEventsSchema;

/** §6.2 的 t 判别值 → contracts/events.py 里的模型名。 */
const CHAT_EVENT_SCHEMA_NAMES: Record<ChatEventKind, string> = {
  s: "SentenceEvent",
  m: "MemoryEvent",
  a: "ActEvent",
  end: "EndEvent",
  e: "ErrorEvent",
};

function schema(name: string): SchemaObject {
  const found = openapi.components.schemas[name];
  if (found === undefined) throw new Error("OpenAPI 快照里缺少 schema：" + name);
  return found;
}

function sortedKeys(value: Record<string, unknown> | undefined): string[] {
  return Object.keys(value ?? {}).sort();
}

describe("IPC 契约与 sidecar OpenAPI 对账", () => {
  it("HealthSnapshot 字段与 HealthResponse 一致", () => {
    expect(sortedKeys(schema("HealthResponse").properties)).toEqual(
      [...HEALTH_SNAPSHOT_FIELDS].sort(),
    );
  });

  it("语音状态枚举与 VoiceState 一致", () => {
    const voice = schema("HealthResponse").properties?.["voice"] as { enum?: string[] } | undefined;
    if (voice?.enum === undefined) {
      throw new Error("OpenAPI 快照里 HealthResponse.voice 没有声明枚举");
    }
    expect(voice.enum).toEqual([...VOICE_STATES]);
  });

  it("ModuleHealth 字段一致", () => {
    expect(sortedKeys(schema("ModuleHealth").properties)).toEqual([...MODULE_HEALTH_FIELDS].sort());
  });

  it("GpuUsage 字段一致", () => {
    expect(sortedKeys(schema("GpuUsage").properties)).toEqual([...GPU_USAGE_FIELDS].sort());
  });

  it("模块名与 ModuleName 一致", () => {
    expect(schema("ModuleName").enum ?? []).toEqual([...MODULE_NAMES]);
  });

  it("模块状态与 ModuleState 一致", () => {
    expect(schema("ModuleState").enum ?? []).toEqual([...MODULE_STATES]);
  });

  it("channel 名唯一且带 deskpet: 前缀", () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) {
      expect(channel.startsWith("deskpet:")).toBe(true);
    }
  });

  it("会话六条通道与音频回传通道都在白名单里（T1.6b）", () => {
    expect(IPC_CHANNELS.chatSend).toBe("deskpet:chat:send");
    expect(IPC_CHANNELS.chatEvent).toBe("deskpet:chat:event");
    expect(IPC_CHANNELS.chatCancel).toBe("deskpet:chat:cancel");
    expect(IPC_CHANNELS.voiceStart).toBe("deskpet:voice:start");
    expect(IPC_CHANNELS.voiceStop).toBe("deskpet:voice:stop");
    expect(IPC_CHANNELS.voiceState).toBe("deskpet:voice:state");
    // 音频只能经 IPC 内存回传（不落盘，§7.3），§6.10 原十条通道里没有能承载它的
    expect(IPC_CHANNELS.ttsAudio).toBe("deskpet:tts:audio");
  });

  it("五种聊天事件的字段与 events.py 逐一对账", () => {
    for (const kind of CHAT_EVENT_KINDS) {
      const schemaName = CHAT_EVENT_SCHEMA_NAMES[kind];
      const definition = llmEvents.$defs[schemaName];
      if (definition === undefined) {
        throw new Error("llm_events.schema.json 里缺少 $defs：" + schemaName);
      }
      expect(definition.properties?.["t"]).toMatchObject({ const: kind });
      expect(sortedKeys(definition.properties)).toEqual([...CHAT_EVENT_FIELDS[kind]].sort());
    }
  });

  it("/chat/stream 的 SSE 判别值与 CHAT_EVENT_KINDS 一致", () => {
    const operation = openapi.paths["/chat/stream"]?.["post"];
    const schema = operation?.responses?.["200"]?.content?.["text/event-stream"]?.schema;
    const discriminator = schema?.properties?.["t"] as { enum?: string[] } | undefined;
    if (discriminator?.enum === undefined) {
      throw new Error("openapi.json 里 /chat/stream 没有声明 SSE 的 t 判别值");
    }
    expect(discriminator.enum).toEqual([...CHAT_EVENT_KINDS]);
  });

  it("语音状态机状态唯一且含 listening / speaking（F2）", () => {
    expect(new Set(VOICE_STATES).size).toBe(VOICE_STATES.length);
    expect(VOICE_STATES).toContain("listening");
    expect(VOICE_STATES).toContain("speaking");
  });
});
