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
  CHAR_HIT_REGION_FIELDS,
  CHARACTER_APPEARANCE_FIELDS,
  type CharacterAppearance,
  CHARACTERS_CHANGED_FIELDS,
  type CharactersChangedMessage,
  CHAT_EVENT_FIELDS,
  CHAT_EVENT_KINDS,
  CHAT_INTERACTION_FIELDS,
  type ChatEventKind,
  type ChatInteraction,
  DEV_MODE_FIELDS,
  type DevModeRequest,
  HEALTH_SNAPSHOT_FIELDS,
  INTERACT_TRIGGERS,
  IPC_CHANNELS,
  MEMORY_BEHAVIOR_FIELDS,
  MEMORY_CONTEXT_ITEM_FIELDS,
  MEMORY_CONTEXT_SECTION_FIELDS,
  MEMORY_EDIT_REQUEST_FIELDS,
  MEMORY_ITEM_FIELDS,
  MEMORY_KINDS,
  MEMORY_MESSAGE_FIELDS,
  MEMORY_QUERY_KINDS,
  type MemoryBehaviorRequest,
  type MemoryContextItem,
  type MemoryContextRequest,
  type MemoryContextSection,
  type MemoryEditRequest,
  type MemoryEditResponse,
  type MemoryItem,
  type MemoryMessageItem,
  type MemoryMessagesRequest,
  MODULE_HEALTH_FIELDS,
  MODULE_NAMES,
  MODULE_STATES,
  PACK_PICK_IMAGE_FIELDS,
  PACK_REGION_FIELDS,
  PACK_SAVE_REQUEST_FIELDS,
  PACK_SAVE_RESPONSE_FIELDS,
  type PackPickImageResponse,
  type PackRegionDraft,
  type PackSaveRequest,
  type PackSaveResponse,
  PROVIDER_CAPABILITIES,
  PROVIDER_HEALTH_FIELDS,
  PROVIDER_PROBE_FIELDS,
  PROVIDER_SETTINGS_FIELDS,
  STAGE_KINDS,
  TOUCH_GESTURES,
  TOUCH_MESSAGE_FIELDS,
  TOUCH_REGION_FIELDS,
  type TouchMessage,
  UI_DRAG_ACTIONS,
  type UiDragMessage,
  UI_DRAG_FIELDS,
  UI_GESTURE_FIELDS,
  type UiGestureSettings,
  type UiMetricsMessage,
  UI_METRICS_FIELDS,
  UI_STATE_FIELDS,
  USAGE_FACTS,
  USAGE_RECORD_FIELDS,
  USAGE_RECORD_REQUEST_FIELDS,
  type UsageRecordRequest,
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

  it("界面九条通道与 ui.json 字段已登记（T1.12a / §6.11；T2.2 加 ui:metrics 与 ui:drag；T2.3-C2c 加 ui:minimize 与 gestures）", () => {
    expect(IPC_CHANNELS.uiGetState).toBe("deskpet:ui:get-state");
    expect(IPC_CHANNELS.uiSetState).toBe("deskpet:ui:set-state");
    expect(IPC_CHANNELS.uiStateChanged).toBe("deskpet:ui:state-changed");
    expect(IPC_CHANNELS.uiPointer).toBe("deskpet:ui:pointer");
    // 素材包围盒只能由渲染层量（PNG naturalWidth / Live2D 包围盒），主进程据此定窗口尺寸
    expect(IPC_CHANNELS.uiMetrics).toBe("deskpet:ui:metrics");
    // 拖动只报开始 / 结束，位移由主进程读系统光标算：app-region 拖不动透明像素，也无法自动验证
    expect(IPC_CHANNELS.uiDrag).toBe("deskpet:ui:drag");
    // 最小化只请求隐藏主窗（托盘图标还在），不退出程序
    expect(IPC_CHANNELS.uiMinimize).toBe("deskpet:ui:minimize");
    expect(IPC_CHANNELS.settingsOpen).toBe("deskpet:settings:open");
    expect(IPC_CHANNELS.charList).toBe("deskpet:char:list");
    expect(new Set(UI_STATE_FIELDS).size).toBe(UI_STATE_FIELDS.length);
    // data/ui.json 的字段就是白名单字段，别处不许私自加（§6.11）
    expect([...UI_STATE_FIELDS].sort()).toEqual([
      "always_on_top",
      "char_id",
      "click_through",
      "gestures",
      "scale",
      "stage_height",
      "stage_width",
      "x",
      "y",
    ]);
    // 上报消息的字段就是这三个：多一个少一个都会把窗口尺寸算错
    const metrics: UiMetricsMessage = { stage_width: 512, stage_height: 768, chatbar_height: 92 };
    expect(sortedKeys({ ...metrics })).toEqual([...UI_METRICS_FIELDS].sort());
    const drag: UiDragMessage = { action: "start" };
    expect(sortedKeys({ ...drag })).toEqual([...UI_DRAG_FIELDS].sort());
    expect(UI_DRAG_ACTIONS).toEqual(["start", "end"]);
    // 手势偏好（方案 §5.1）：哪些方式能进互动模式、哪些手势启用；只落 data/ui.json
    const gestures: UiGestureSettings = { triggers: ["button"], enabled: ["tap"] };
    expect(sortedKeys({ ...gestures })).toEqual([...UI_GESTURE_FIELDS].sort());
    expect([...INTERACT_TRIGGERS]).toEqual(["button", "stroke"]);
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

  it("编辑 L0 的通道与字段与 sidecar 逐字段对账（T2.3-B2）", () => {
    expect(IPC_CHANNELS.memoryEdit).toBe("deskpet:memory:edit");
    // importance 显式给 null 也允许：那是「只改文本」的写法
    const request: MemoryEditRequest = { memory_id: 7, text: "用户养了一只狗", importance: null };
    expect(sortedKeys({ ...request })).toEqual([...MEMORY_EDIT_REQUEST_FIELDS].sort());
    expect(MEMORY_EDIT_REQUEST_FIELDS).toEqual(["memory_id", "text", "importance"]);

    // IPC 请求比请求体多一个 memory_id：它进路径 /memory/{memory_id}，sidecar 的体里只有两个键
    expect(sortedKeys(schema("MemoryEditRequest").properties)).toEqual(["importance", "text"]);

    const item: MemoryItem = {
      id: 7,
      kind: "fact",
      tier: "fact",
      text: "用户养了一只狗",
      importance: 0.5,
      created_at: "2026-10-18T01:00:00+08:00",
      last_used_at: "",
      used_count: 0,
    };
    const response: MemoryEditResponse = { updated: true, merged: false, item };
    expect(sortedKeys({ ...response })).toEqual(["item", "merged", "updated"]);
    expect(sortedKeys(schema("MemoryEditResponse").properties)).toEqual([
      "item",
      "merged",
      "updated",
    ]);
  });

  it("行为记忆开关已登记，筛选种类与写入口分开（T2.1c）", () => {
    expect(IPC_CHANNELS.memoryBehavior).toBe("deskpet:memory:behavior");
    // 四个筛选种类里多出的 action 只由行为记忆派生：绝不能出现在写入口的枚举里
    expect([...MEMORY_QUERY_KINDS]).toEqual(["fact", "preference", "event", "action"]);
    const kind = schema("MemoryWriteRequest").properties?.["kind"] as
      { enum?: string[] } | undefined;
    expect(kind?.enum).not.toContain("action");
    // 开关的请求 / 响应字段就是界面上的勾选，没有第二个字段
    const request: MemoryBehaviorRequest = { enabled: null };
    expect(sortedKeys({ ...request })).toEqual([...MEMORY_BEHAVIOR_FIELDS].sort());
    expect(MEMORY_BEHAVIOR_FIELDS).toEqual(["enabled"]);
  });

  it("开发者模式与角色记忆页的通道、字段与 sidecar 逐字段对账（T2.3-B1）", () => {
    expect(IPC_CHANNELS.devModeGet).toBe("deskpet:dev:get");
    expect(IPC_CHANNELS.devModeSet).toBe("deskpet:dev:set");
    expect(IPC_CHANNELS.memoryMessages).toBe("deskpet:memory:messages");
    expect(IPC_CHANNELS.memoryContext).toBe("deskpet:memory:context");

    // 开关只有一个布尔：请求侧的 null 表示「只读」
    const dev: DevModeRequest = { enabled: null };
    expect(sortedKeys({ ...dev })).toEqual([...DEV_MODE_FIELDS].sort());
    expect(DEV_MODE_FIELDS).toEqual(["enabled"]);

    // 原文页：本地接口与 sidecar 的 MemoryMessageItem 字段必须一字不差
    const message: MemoryMessageItem = {
      message_id: 1,
      session_id: "s1",
      role: "user",
      text: "在",
      created_at: "2026-10-18T01:00:00+08:00",
      token_len: 1,
      covered_by: 0,
    };
    expect(sortedKeys({ ...message })).toEqual([...MEMORY_MESSAGE_FIELDS].sort());
    expect(sortedKeys(schema("MemoryMessageItem").properties)).toEqual(
      [...MEMORY_MESSAGE_FIELDS].sort(),
    );
    const messages: MemoryMessagesRequest = { char_id: "amber", limit: 50, before_id: 9 };
    expect(sortedKeys({ ...messages })).toEqual(["before_id", "char_id", "limit"]);

    // 注入预览页：段与条目两层都要对账（少一个字段，设置窗就会少显示一列）
    const item: MemoryContextItem = {
      text: "在",
      tokens: 1,
      ref_id: 0,
      kind: "",
      role: "",
      importance: 0,
    };
    expect(sortedKeys({ ...item })).toEqual([...MEMORY_CONTEXT_ITEM_FIELDS].sort());
    expect(sortedKeys(schema("MemoryContextItem").properties)).toEqual(
      [...MEMORY_CONTEXT_ITEM_FIELDS].sort(),
    );
    const section: MemoryContextSection = {
      name: "facts",
      title: "长期记忆（L0）",
      budget_tokens: 400,
      used_tokens: 12,
      dropped: false,
      items: [item],
    };
    expect(sortedKeys({ ...section })).toEqual([...MEMORY_CONTEXT_SECTION_FIELDS].sort());
    expect(sortedKeys(schema("MemoryContextSection").properties)).toEqual(
      [...MEMORY_CONTEXT_SECTION_FIELDS].sort(),
    );
    const context: MemoryContextRequest = { char_id: "amber", query: "" };
    expect(sortedKeys({ ...context })).toEqual(["char_id", "query"]);
    expect(sortedKeys(schema("MemoryContextResponse").properties)).toEqual(
      [
        "budget_tokens",
        "char_id",
        "dropped",
        "empty",
        "injected_ids",
        "query",
        "sections",
        "text",
        "total_tokens",
      ].sort(),
    );
  });
  it("触摸互动的通道与字段已登记，gesture 枚举与 sidecar 逐字对齐（T2.3-C2c）", () => {
    // 立绘与部位定义都由主进程读角色包，渲染层只拿 data URL 与归一化框（CSP 不放 file://）
    expect(IPC_CHANNELS.charPortrait).toBe("deskpet:char:portrait");
    expect(IPC_CHANNELS.charHits).toBe("deskpet:char:hits");
    expect(IPC_CHANNELS.uiCharHit).toBe("deskpet:ui:char-hit");
    const message: TouchMessage = {
      gesture: "tap",
      regions: [{ id: "head", name: "头" }],
      count: 2,
      duration_ms: 400,
    };
    expect(sortedKeys({ ...message })).toEqual([...TOUCH_MESSAGE_FIELDS].sort());
    expect(sortedKeys({ ...(message.regions[0] ?? {}) })).toEqual([...TOUCH_REGION_FIELDS].sort());
    expect([...TOUCH_GESTURES]).toEqual(["tap", "stroke", "hold", "knead", "pat"]);
    // hits.json 的一项就是这五个字段：台词改由 LLM 现场生成，角色包里不再有预制反应
    expect([...CHAR_HIT_REGION_FIELDS]).toEqual(["id", "name", "rect", "color", "act"]);
  });

  it("形象舞台 appearance 通道与字段已登记，stage 枚举与 sidecar 对齐（T2.4）", () => {
    // 渲染层不再直接碰立绘：由 Stage 抽象层按 appearance.json 决定用 PNG 还是 Live2D（§6.6 / D10）
    expect(IPC_CHANNELS.charAppearance).toBe("deskpet:char:appearance");
    const sample: CharacterAppearance = {
      stage: "png",
      portrait: "assets/portrait.png",
      model: null,
      png_fallback: null,
      motions: {},
      expressions: {},
      acts: { wave: { live2d: "M_wave", png: "bounce" } },
    };
    expect(sortedKeys({ ...sample }).sort()).toEqual([...CHARACTER_APPEARANCE_FIELDS].sort());
    expect([...STAGE_KINDS]).toEqual(["png", "live2d", "hybrid"]);
  });

  it("互动事实（触摸走 LLM）的字段与 sidecar 逐字对齐（T2.3-C2c）", () => {
    // 主进程发起互动轮时把这些字段塞进 /chat/stream；sidecar 会拼成本轮用户消息（core/prompt.py）
    const interaction: ChatInteraction = {
      gesture: "tap",
      regions: [{ id: "head", name: "头" }],
      count: 2,
      duration_ms: 400,
    };
    expect(sortedKeys({ ...interaction }).sort()).toEqual([...CHAT_INTERACTION_FIELDS].sort());
    expect(sortedKeys(schema("ChatInteraction").properties)).toEqual(
      [...CHAT_INTERACTION_FIELDS].sort(),
    );
    const gesture = schema("ChatInteraction").properties?.["gesture"] as
      { enum?: string[]; const?: string } | undefined;
    const allowed = gesture?.enum ?? (gesture?.const === undefined ? undefined : [gesture.const]);
    if (allowed === undefined) {
      throw new Error("OpenAPI 快照里 ChatInteraction.gesture 没有声明取值");
    }
    expect(allowed).toEqual([...TOUCH_GESTURES]);
    // 有互动时 text 可以是空串：ChatStreamRequest 上必须真的有这个可选字段
    const chat = schema("ChatStreamRequest").properties ?? {};
    expect(Object.keys(chat)).toContain("interaction");
    expect(Object.keys(chat)).toContain("text");
  });

  it("使用事实上报已登记，fact 枚举与请求字段与 sidecar 逐字对齐（T2.3-C1/C2c）", () => {
    // 请求体字段两边必须一致：多一个 sidecar 会 422，少一个就丢信息（部位 / 连击数）
    const request: UsageRecordRequest = {
      fact: "char_hit",
      char_id: "amber",
      region_id: "head",
      gesture: "tap",
      count: 3,
    };
    expect(sortedKeys({ ...request }).sort()).toEqual([...USAGE_RECORD_REQUEST_FIELDS].sort());
    expect(sortedKeys(schema("UsageRecordRequest").properties)).toEqual(
      [...USAGE_RECORD_REQUEST_FIELDS].sort(),
    );
    // 外部方法多传一个枚举值就是契约漂移，这里必须与 sidecar 的 Literal 一模一样
    // 单值 Literal 在 Pydantic 里导出成 const、多值才导出 enum，两种都要认
    const fact = schema("UsageRecordRequest").properties?.["fact"] as
      { enum?: string[]; const?: string } | undefined;
    const allowed = fact?.enum ?? (fact?.const === undefined ? undefined : [fact.const]);
    if (allowed === undefined) {
      throw new Error("OpenAPI 快照里 UsageRecordRequest.fact 没有声明取值");
    }
    expect(allowed).toEqual([...USAGE_FACTS]);
    // recorded=false 是「没收下」而不是错误，所以响应只有一个布尔字段
    expect(sortedKeys(schema("UsageRecordResponse").properties)).toEqual([...USAGE_RECORD_FIELDS]);
    expect([...USAGE_RECORD_FIELDS]).toEqual(["recorded"]);
  });
  it("角色包编辑器的通道与字段已登记（T2.3-D）", () => {
    // 编辑器是第三个渲染层入口：它拿不到 fs，选图与落盘都得经 main（CSP 也不放 file://）
    expect(IPC_CHANNELS.packOpenEditor).toBe("deskpet:pack:open-editor");
    expect(IPC_CHANNELS.packPickImage).toBe("deskpet:pack:pick-image");
    expect(IPC_CHANNELS.packSave).toBe("deskpet:pack:save");
    expect(IPC_CHANNELS.charactersChanged).toBe("deskpet:characters:changed");
    const pick: PackPickImageResponse = {
      canceled: false,
      data_url: "data:image/png;base64,AA==",
      file_name: "a.png",
    };
    expect(sortedKeys({ ...pick })).toEqual([...PACK_PICK_IMAGE_FIELDS].sort());
    const region: PackRegionDraft = {
      id: "",
      name: "head",
      rect: [0.1, 0.1, 0.2, 0.2],
      color: "#ffb347",
      act: "",
    };
    expect(sortedKeys({ ...region })).toEqual([...PACK_REGION_FIELDS].sort());
    const save: PackSaveRequest = {
      char_id: "yukari",
      display_name: "紫",
      description: "",
      personality: "",
      speaking_style: "",
      portrait_data_url: "data:image/png;base64,AA==",
      regions: [region],
    };
    expect(sortedKeys({ ...save })).toEqual([...PACK_SAVE_REQUEST_FIELDS].sort());
    const response: PackSaveResponse = {
      ok: true,
      char_id: "yukari",
      error: "",
      files: ["assets/portrait.png"],
    };
    expect(sortedKeys({ ...response })).toEqual([...PACK_SAVE_RESPONSE_FIELDS].sort());
    const changed: CharactersChangedMessage = { char_id: "yukari" };
    expect(sortedKeys({ ...changed })).toEqual([...CHARACTERS_CHANGED_FIELDS].sort());
  });
});
