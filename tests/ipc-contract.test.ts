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
  HEALTH_SNAPSHOT_FIELDS,
  IPC_CHANNELS,
  MEMORY_ITEM_FIELDS,
  MEMORY_KINDS,
  MODULE_HEALTH_FIELDS,
  MODULE_NAMES,
  MODULE_STATES,
  PROVIDER_CAPABILITIES,
  PROVIDER_HEALTH_FIELDS,
  PROVIDER_PROBE_FIELDS,
  PROVIDER_SETTINGS_FIELDS,
  type UiMetricsMessage,
  UI_METRICS_FIELDS,
  UI_STATE_FIELDS,
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

  it("模块名与 ModuleName 一致", () => {
    expect(schema("ModuleName").enum ?? []).toEqual([...MODULE_NAMES]);
  });

  it("模块状态与 ModuleState 一致", () => {
    expect(schema("ModuleState").enum ?? []).toEqual([...MODULE_STATES]);
  });

  it("ProviderHealth 字段一致", () => {
    expect(sortedKeys(schema("ProviderHealth").properties)).toEqual(
      [...PROVIDER_HEALTH_FIELDS].sort(),
    );
  });

  it("供给面枚举与 ProviderCapability 一致", () => {
    // Literal 类型在 OpenAPI 里是内联 enum，不单独出 schema（与 voice 同样处理）
    const capability = schema("ProviderHealth").properties?.["capability"] as
      { enum?: string[] } | undefined;
    if (capability?.enum === undefined) {
      throw new Error("OpenAPI 快照里 ProviderHealth.capability 没有声明枚举");
    }
    expect(capability.enum).toEqual([...PROVIDER_CAPABILITIES]);
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

  it("界面七条通道与 ui.json 字段已登记（T1.12a / §6.11；T2.2 加 ui:metrics）", () => {
    expect(IPC_CHANNELS.uiGetState).toBe("deskpet:ui:get-state");
    expect(IPC_CHANNELS.uiSetState).toBe("deskpet:ui:set-state");
    expect(IPC_CHANNELS.uiStateChanged).toBe("deskpet:ui:state-changed");
    expect(IPC_CHANNELS.uiPointer).toBe("deskpet:ui:pointer");
    // 素材包围盒只能由渲染层量（PNG naturalWidth / Live2D 包围盒），主进程据此定窗口尺寸
    expect(IPC_CHANNELS.uiMetrics).toBe("deskpet:ui:metrics");
    expect(IPC_CHANNELS.settingsOpen).toBe("deskpet:settings:open");
    expect(IPC_CHANNELS.charList).toBe("deskpet:char:list");
    expect(new Set(UI_STATE_FIELDS).size).toBe(UI_STATE_FIELDS.length);
    // data/ui.json 的字段就是白名单字段，别处不许私自加（§6.11）
    expect([...UI_STATE_FIELDS].sort()).toEqual([
      "always_on_top",
      "char_id",
      "click_through",
      "scale",
      "stage_height",
      "stage_width",
      "x",
      "y",
    ]);
    // 上报消息的字段就是这三个：多一个少一个都会把窗口尺寸算错
    const metrics: UiMetricsMessage = { stage_width: 512, stage_height: 768, chatbar_height: 92 };
    expect(sortedKeys({ ...metrics })).toEqual([...UI_METRICS_FIELDS].sort());
  });

  it("模型供给设置与探测结论已登记，探测结论与 sidecar 逐字段对账（T1.14b）", () => {
    expect(IPC_CHANNELS.providersGet).toBe("deskpet:settings:providers:get");
    expect(IPC_CHANNELS.providersSet).toBe("deskpet:settings:providers:set");
    expect(IPC_CHANNELS.providersTest).toBe("deskpet:settings:providers:test");
    expect(new Set(PROVIDER_SETTINGS_FIELDS).size).toBe(PROVIDER_SETTINGS_FIELDS.length);
    // 设置视图的字段就是白名单字段：界面不许私自加「明文密钥」这类字段
    expect([...PROVIDER_SETTINGS_FIELDS].sort()).toEqual([
      "capability",
      "cloud_api_key_set",
      "cloud_base_url",
      "cloud_model",
      "fallback_base_url",
      "fallback_model",
      "local_base_url",
      "local_model",
      "local_token_set",
      "provider",
    ]);
    // 探测结论照 sidecar 的 ProviderProbeResult 抄，一条也不许少（密钥字段本来就不在其中）
    expect(sortedKeys(schema("ProviderProbeResult").properties)).toEqual(
      [...PROVIDER_PROBE_FIELDS].sort(),
    );
    expect(sortedKeys(schema("ProviderTestResponse").properties)).toEqual([
      "capability",
      "results",
    ]);
  });

  it("记忆三条通道与 MemoryListItem 已登记（T2.1b）", () => {
    expect(IPC_CHANNELS.memoryList).toBe("deskpet:memory:list");
    expect(IPC_CHANNELS.memoryDelete).toBe("deskpet:memory:delete");
    expect(IPC_CHANNELS.memoryClear).toBe("deskpet:memory:clear");
    // 设置窗看到的字段就是 sidecar 回的字段（界面不许私自加字段）
    expect(sortedKeys(schema("MemoryListItem").properties)).toEqual([...MEMORY_ITEM_FIELDS].sort());
    // 记忆种类照抄 MemoryWriteRequest.kind 的 Literal：写入口在 sidecar，界面只用来筛选
    const kind = schema("MemoryWriteRequest").properties?.["kind"] as
      { enum?: string[] } | undefined;
    if (kind?.enum === undefined) {
      throw new Error("OpenAPI 快照里 MemoryWriteRequest.kind 没有声明枚举");
    }
    expect(kind.enum).toEqual([...MEMORY_KINDS]);
    expect(sortedKeys(schema("MemoryClearResponse").properties)).toEqual(["deleted"]);
  });
});
