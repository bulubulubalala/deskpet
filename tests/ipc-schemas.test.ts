import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IPC_INPUT_SCHEMAS } from "../app/shared/contracts/ipc-schemas";
import { ContractViolation } from "../app/shared/contracts/validate";
import { IPC_CHANNELS } from "../app/shared/ipc-channels";

const schemas: Record<string, { parse: (value: unknown, path: string) => unknown }> =
  IPC_INPUT_SCHEMAS;

function parse(name: keyof typeof IPC_CHANNELS, value: unknown): unknown {
  const schema = schemas[IPC_CHANNELS[name]];
  if (schema === undefined) {
    throw new Error("通道 " + name + " 没有入参形状");
  }
  return schema.parse(value, "请求");
}

function rejects(name: keyof typeof IPC_CHANNELS, value: unknown, pattern: RegExp): void {
  expect(() => parse(name, value)).toThrow(pattern);
}

/** 读主进程 IPC 各域模块，取出 registry.handle(IPC_CHANNELS.x 里的 x（登记名，不是通道值）。 */
function registeredHandles(): string[] {
  const dir = join(process.cwd(), "app", "main", "ipc");
  const names: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/registry\.handle\(\s*IPC_CHANNELS\.([A-Za-z0-9_]+)/g)) {
      names.push(match[1] ?? "");
    }
  }
  return names;
}

describe("IPC 入参形状表", () => {
  it("每个 handle 都登记了形状，且没有死条目", () => {
    const registered = registeredHandles();
    expect(registered.length).toBeGreaterThan(60);
    const covered = new Set(
      Object.keys(schemas).map(
        (channel) =>
          Object.entries(IPC_CHANNELS).find(([, value]) => value === channel)?.[0] ?? channel,
      ),
    );
    const missing = registered.filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
    const stale = [...covered].filter((name) => !registered.includes(name));
    expect(stale).toEqual([]);
  });

  it("带参数的通道：形状对了就放行，不对就报出字段路径", () => {
    expect(parse("memoryDelete", { memory_id: 3 })).toEqual({ memory_id: 3 });
    rejects("memoryDelete", { memory_id: "3" }, /请求\.memory_id：必须是整数/);
    rejects("memoryDelete", {}, /请求\.memory_id：必须是整数/);
    rejects("memoryClear", {}, /请求\.char_id：必须是字符串/);
    rejects("memoryClear", { char_id: "" }, /请求\.char_id：不能为空/);
  });

  it("聊天：必填字段、枚举与嵌套互动事实", () => {
    const ok = {
      session_id: "s1",
      char_id: "snow",
      text: "你好",
      input_mode: "text",
      interaction: {
        gesture: "tap",
        regions: [{ id: "head", name: "头" }],
        count: 2,
        duration_ms: 300,
      },
    };
    expect(parse("chatSend", ok)).toMatchObject({ session_id: "s1", input_mode: "text" });
    rejects("chatSend", { ...ok, input_mode: "speech" }, /必须是以下之一/);
    rejects("chatSend", { ...ok, interaction: { ...ok.interaction, gesture: "pinch" } }, /gesture/);
    rejects("chatSend", { ...ok, text: 42 }, /请求\.text：必须是字符串/);
  });

  it("标量通道：直接校验那一个参数", () => {
    expect(parse("modelsInstall", "asr-sherpa")).toBe("asr-sherpa");
    rejects("modelsInstall", 1, /必须是字符串/);
    rejects("usageSetRecording", "on", /必须是 true \/ false/);
    rejects("memoryPeriodDetail", 0, /不能小于 1/);
    expect(parse("providersTest", { capability: "llm" })).toMatchObject({ capability: "llm" });
    rejects("providersTest", "llm", /必须是对象/);
    rejects(
      "providersTest",
      { capability: "llm", overrides: { provider: "gpu" } },
      /必须是以下之一/,
    );
    expect(
      parse("providersTest", {
        capability: "llm",
        overrides: { preset: "opencode-go", cloud_api_key: "sk-probe" },
      }),
    ).toMatchObject({ overrides: { preset: "opencode-go" } });
  });

  it("不带参数的通道：传了参数就是界面在乱调", () => {
    expect(parse("healthGet", undefined)).toBeUndefined();
    rejects("healthGet", {}, /不需要参数/);
  });

  it("可缺省的通道：undefined 与 null 都当没填", () => {
    expect(parse("settingsOpen", undefined)).toBeUndefined();
    expect(parse("settingsOpen", { pane: "providers" })).toMatchObject({ pane: "providers" });
    rejects("settingsOpen", { pane: "unknown" }, /必须是以下之一/);
    expect(parse("packImport", undefined)).toBeUndefined();
  });

  it("界面上能出现的「只读」值用 null 表达，不被当成缺省", () => {
    expect(parse("devModeSet", { enabled: null })).toEqual({ enabled: null });
    expect(parse("memoryBehavior", { enabled: true })).toEqual({ enabled: true });
    rejects("memoryBehavior", { enabled: "true" }, /必须是 true \/ false/);
  });

  it("陪伴设置：勿扰时间允许 -1（界面用 -1 表示不启用）", () => {
    const patch = {
      companion: { quiet_hours_start: -1, quiet_hours_end: 23, screen_interval_s: 5 },
    };
    expect(parse("uiSetState", patch)).toMatchObject({ companion: { quiet_hours_start: -1 } });
    rejects("uiSetState", { companion: { quiet_hours_start: 24 } }, /不能大于 23/);
  });

  it("角色包部位草稿：v2 的可选字段必须原样带过去（优先级 / 网格绑定不能被子集形状洗掉）", () => {
    const region = {
      id: "head",
      name: "头",
      rect: [0.1, 0.2, 0.3, 0.4],
      color: "#fff",
      act: "idle",
      priority: 3,
      padding: 0.02,
      drawables: ["ParamAngleX"],
    };
    expect(parse("packSaveRegions", { char_id: "snow", regions: [region] })).toMatchObject({
      regions: [region],
    });
  });

  it("多余字段默认放过（旧主进程 + 新界面不该互相拒绝）", () => {
    expect(parse("memoryList", { char_id: "snow", kind: "fact", unknown_field: 1 })).toMatchObject({
      char_id: "snow",
      kind: "fact",
      unknown_field: 1,
    });
  });

  it("校验失败一定是 ContractViolation（注册表据此记日志并转成一句人话）", () => {
    expect(() => parse("memoryTimelineRebuild", {})).toThrow(ContractViolation);
  });
});
