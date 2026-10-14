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
  GPU_USAGE_FIELDS,
  HEALTH_SNAPSHOT_FIELDS,
  IPC_CHANNELS,
  MODULE_HEALTH_FIELDS,
  MODULE_NAMES,
  MODULE_STATES,
} from "../app/main/ipc";

interface SchemaObject {
  properties?: Record<string, unknown>;
  enum?: string[];
}

interface OpenApiDocument {
  components: { schemas: Record<string, SchemaObject> };
}

const OPENAPI_PATH = "sidecar/contracts/openapi.json";
const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDocument;

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
});
