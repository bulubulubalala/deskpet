// 文件职责：scripts/check-ipc-contract.mjs 的纯函数测试。
//
// 为什么值得测：这个脚本是「通道必须经注册表、必须注销」的唯一守卫，写错了会静默放行。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectMainSources,
  findIpcProblems,
  findOrphanChannels,
  findPreloadDrift,
  findSchemaGaps,
  parseChannelNames,
  parsePreloadChannels,
  parseRegistrations,
  parseSchemaChannels,
  stripComments,
} from "../scripts/check-ipc-contract.mjs";

const CHANNELS = `export const IPC_CHANNELS = {
  chatSend: "deskpet:chat:send",
  chatCancel: "deskpet:chat:cancel",
  healthChanged: "deskpet:health:changed",
} as const;`;

function registrations(source) {
  return parseRegistrations(source);
}

describe("parseRegistrations", () => {
  it("认得 registry.handle / registry.on，含换行写法", () => {
    const source = `
      registry.handle(IPC_CHANNELS.chatSend, () => {});
      registry.on(
        IPC_CHANNELS.chatCancel,
        () => {},
      );
    `;
    const parsed = registrations(source);
    expect([...parsed.handle]).toEqual(["chatSend"]);
    expect([...parsed.on]).toEqual(["chatCancel"]);
  });
});

describe("parseChannelNames", () => {
  it("从 app/shared/ipc-channels.ts 的形状里取出通道名", () => {
    expect(parseChannelNames(CHANNELS)).toEqual(["chatSend", "chatCancel", "healthChanged"]);
  });

  it("找不到 export 时返回空数组而不是抛错", () => {
    expect(parseChannelNames("const X = {};")).toEqual([]);
  });
});

describe("findIpcProblems", () => {
  const channels = ["chatSend", "chatCancel", "healthChanged"];

  it("注册表正常使用时不报错", () => {
    const problems = findIpcProblems({
      handlersSource: "registry.handle(IPC_CHANNELS.chatSend, () => {}); registry.dispose();",
      registered: registrations("registry.handle(IPC_CHANNELS.chatSend, () => {});"),
      channels,
    });
    expect(problems).toEqual([]);
  });

  it("绕过注册表直接用 ipcMain.handle 会被抓出来", () => {
    const problems = findIpcProblems({
      handlersSource: "ipcMain.handle(IPC_CHANNELS.chatSend, () => {}); registry.dispose();",
      registered: registrations(""),
      channels,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ipcMain.handle");
  });

  it("没有 dispose 会被抓出来", () => {
    const problems = findIpcProblems({
      handlersSource: "registry.handle(IPC_CHANNELS.chatSend, () => {});",
      registered: registrations("registry.handle(IPC_CHANNELS.chatSend, () => {});"),
      channels,
    });
    expect(problems.join()).toContain("dispose");
  });

  it("注册了契约里没有的通道会被抓出来（拼错名字）", () => {
    const problems = findIpcProblems({
      handlersSource: "registry.handle(IPC_CHANNELS.chatSendd, () => {}); registry.dispose();",
      registered: registrations("registry.handle(IPC_CHANNELS.chatSendd, () => {});"),
      channels,
    });
    expect(problems.join()).toContain("chatSendd");
  });
});

describe("findPreloadDrift", () => {
  const registered = { handle: new Set(["chatSend"]), on: new Set(["voiceAudio"]) };

  it("两边对齐时没有意见", () => {
    expect(
      findPreloadDrift({
        registered,
        invoked: new Set(["chatSend"]),
        sent: new Set(["voiceAudio"]),
      }),
    ).toEqual([]);
  });

  it("界面能调但主进程没实现：调用会抛 No handler registered", () => {
    const problems = findPreloadDrift({
      registered,
      invoked: new Set(["chatSend", "chatSendd"]),
      sent: new Set(["voiceAudio"]),
    });
    expect(problems.join()).toContain("No handler registered");
    expect(problems.join()).toContain("chatSendd");
  });

  it("实现了但界面调不到：死代码", () => {
    const problems = findPreloadDrift({
      registered,
      invoked: new Set(),
      sent: new Set(["voiceAudio"]),
    });
    expect(problems.join()).toContain("preload 没暴露");
  });

  it("界面发事件但没人监听 / 监听了但没人发", () => {
    const noListener = findPreloadDrift({
      registered,
      invoked: new Set(["chatSend"]),
      sent: new Set(["voiceAudio", "voiceAudio2"]),
    });
    expect(noListener.join()).toContain("voiceAudio2");

    const noSender = findPreloadDrift({
      registered: { handle: new Set(["chatSend"]), on: new Set(["voiceAudio", "voiceAudio3"]) },
      invoked: new Set(["chatSend"]),
      sent: new Set(["voiceAudio"]),
    });
    expect(noSender.join()).toContain("voiceAudio3");
  });
});

describe("parsePreloadChannels", () => {
  it("认出 ipcRenderer.invoke / send 里的通道名", () => {
    const source = `
      const a = () => ipcRenderer.invoke(IPC_CHANNELS.healthGet);
      const b = () => ipcRenderer.send(IPC_CHANNELS.voiceAudio, chunk);
    `;
    const parsed = parsePreloadChannels(source);
    expect([...parsed.invoked]).toEqual(["healthGet"]);
    expect([...parsed.sent]).toEqual(["voiceAudio"]);
  });
});

describe("findOrphanChannels", () => {
  it("契约里有、但既没注册也没发送的通道被列出来", () => {
    const orphans = findOrphanChannels(
      ["chatSend", "healthChanged"],
      { handle: new Set(["chatSend"]), on: new Set() },
      "webContents.send(IPC_CHANNELS.healthChanged, view)",
    );
    expect(orphans).toEqual([]);
  });

  it("完全没人提的通道算死契约", () => {
    const orphans = findOrphanChannels(
      ["chatSend", "chatCancel"],
      { handle: new Set(["chatSend"]), on: new Set() },
      "",
    );
    expect(orphans).toEqual(["chatCancel"]);
  });
});

describe("collectMainSources", () => {
  it("递归读子目录：子目录里的注册也要被解析到", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-ipc-"));
    try {
      await mkdir(join(dir, "ipc"));
      await writeFile(join(dir, "a.ts"), "registry.handle(IPC_CHANNELS.chatSend, () => {});");
      await writeFile(join(dir, "ipc", "b.ts"), "registry.on(IPC_CHANNELS.voiceAudio, () => {});");
      const parsed = parseRegistrations(collectMainSources(dir));
      expect([...parsed.handle]).toEqual(["chatSend"]);
      expect([...parsed.on]).toEqual(["voiceAudio"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("入参形状对账", () => {
  it("parseSchemaChannels 只认 [IPC_CHANNELS.x]: 这种条目", () => {
    const source = [
      "export const IPC_INPUT_SCHEMAS = {",
      "  [IPC_CHANNELS.memoryDelete]: object({ memory_id: integer() }),",
      "  [IPC_CHANNELS.chatSend]: chatSendShape,",
      "  // [IPC_CHANNELS.commented]: 注释里的不算",
      "  otherKey: none(),",
      "};",
    ].join("\n");
    expect([...parseSchemaChannels(source)]).toEqual(["memoryDelete", "chatSend"]);
  });

  it("findSchemaGaps 两个方向都报：handle 缺形状、形状缺 handle", () => {
    expect(
      findSchemaGaps({ registered: { handle: new Set(["a", "b"]) }, schemas: new Set(["b", "c"]) }),
    ).toEqual([
      "通道 a 没有入参形状：在 app/shared/contracts/ipc-schemas.ts 里补一条（不带参数就写 none()）",
      "ipc-schemas.ts 给 c 登记了形状，但主进程没有这个 handle：死条目",
    ]);
    expect(
      findSchemaGaps({ registered: { handle: new Set(["a"]) }, schemas: new Set(["a"]) }),
    ).toEqual([]);
  });
});

describe("stripComments", () => {
  it("docstring 里拿 ipcMain.handle 当反例不算违规，真调用才算", () => {
    const source = [
      "/** 不要写 ipcMain.handle(...)，一律走注册表 */",
      "// ipcMain.on(...) 也是反例",
      "ipcMain.on(IPC_CHANNELS.voiceAudio, () => {});",
      "registry.dispose();",
    ].join("\n");
    expect(stripComments(source)).not.toContain("ipcMain.handle");
    const problems = findIpcProblems({
      handlersSource: source,
      registered: { handle: new Set(), on: new Set() },
      channels: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ipcMain.on");
  });
});
