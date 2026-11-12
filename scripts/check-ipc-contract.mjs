/**
 * IPC 契约对账（D2 的静态部分）。
 *
 * 检查五件事，任何一条不满足就 exit 1：
 *   1. 所有通道都必须经 `IpcRegistry` 注册（`registry.handle / registry.on`）；
 *      任何人绕过注册表直接写 `ipcMain.handle` 都算错——那样就绕过了「注册即可注销」的保证；
 *   2. 注册表必须被 dispose（否则「窗口重建后旧 handler 还挂着」的老毛病会回来）；
 *   3. 注册的通道必须出现在 `IPC_CHANNELS` 里（拼错名字靠这条抓）；
 *   4. `IPC_CHANNELS` 里声明了、但整个主进程没人用的通道，提示为死契约；
 *   5. preload 与主进程两边对得上：界面能调的通道必须有实现，实现的通道必须能调，
 *      界面发出去的事件必须有监听者（反之亦然）。
 *
 * 只做文本解析，不 import Electron：CI 与本地都不需要跑起应用。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 注册可能散在 app/main/ipc/* 各域模块里，所以整棵树拼一份语料来解析（不再只读 ipc-handlers.ts）。 */
const MAIN_DIR = join(root, "app", "main");
const CONTRACT_FILE = join(root, "app", "shared", "ipc-channels.ts");
const PRELOAD_FILE = join(root, "app", "preload", "index.ts");
const SCHEMA_FILE = join(root, "app", "shared", "contracts", "ipc-schemas.ts");

/** 注册：registry.handle(IPC_CHANNELS.x / registry.on(IPC_CHANNELS.x，允许换行。 */
const REGISTER = /\bregistry\.(handle|on)\(\s*IPC_CHANNELS\.([A-Za-z0-9_]+)/g;
/** 绕过注册表的直接注册。 */
const BARE_REGISTER = /\bipcMain\.(handle|on)\(/g;

/**
 * 去掉块注释与整行行注释。
 *
 * 只给「有没有裸调 ipcMain」这一项检查用：模块头的 docstring 里常常要拿 `ipcMain.handle`
 * 当反例说明，那是文字不是代码，不该被判违规。
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
/** preload 侧：界面调用（invoke）与界面发事件（send）。 */
const PRELOAD_INVOKE = /\bipcRenderer\.invoke\(\s*IPC_CHANNELS\.([A-Za-z0-9_]+)/g;
const PRELOAD_SEND = /\bipcRenderer\.send\(\s*IPC_CHANNELS\.([A-Za-z0-9_]+)/g;

/** @returns {{handle: Set<string>, on: Set<string>}} */
export function parseRegistrations(source) {
  const result = { handle: new Set(), on: new Set() };
  for (const match of source.matchAll(REGISTER)) {
    result[match[1] === "handle" ? "handle" : "on"].add(match[2]);
  }
  return result;
}

/** 从 app/shared/ipc-channels.ts 的 `export const IPC_CHANNELS = { ... } as const` 里取通道名。 */
export function parseChannelNames(source) {
  const start = source.indexOf("export const IPC_CHANNELS");
  if (start < 0) {
    return [];
  }
  const body = source.slice(start);
  const end = body.indexOf("} as const");
  const block = end < 0 ? body : body.slice(0, end);
  return [...block.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*"[^"]+"/gm)].map((match) => match[1]);
}

/**
 * @param {{handlersSource: string, registered: {handle: Set<string>, on: Set<string>}, channels: string[]}} input
 * @returns {string[]} 问题列表；空数组 = 通过
 */
export function findIpcProblems({ handlersSource, registered, channels }) {
  const problems = [];
  const known = new Set(channels);

  const code = stripComments(handlersSource);
  for (const match of code.matchAll(BARE_REGISTER)) {
    problems.push(
      `app/main 里还有直接调用 ipcMain.${match[1]}(...) 的通道：改成 registry.${match[1]}(...)（否则退出时不会被注销）`,
    );
  }
  if (!/\bregistry\.dispose\(\)/.test(handlersSource)) {
    problems.push("app/main 里没有 registry.dispose()：重启引擎/重建窗口后旧 handler 会继续响应");
  }
  for (const name of [...registered.handle, ...registered.on]) {
    if (!known.has(name)) {
      problems.push(`通道 ${name} 不在 IPC_CHANNELS 里：拼错了，或者契约忘了声明`);
    }
  }
  return problems;
}

/**
 * preload 与主进程的通道对账。
 *
 * 这里抓的是「界面与实现漂移」：preload 里写了 `invoke(IPC_CHANNELS.x)` 但主进程没注册
 * x，用户点到那个按钮才会拿到 `Error: No handler registered`；反过来注册了没暴露，
 * 就是死代码。两边都是纯文本可判定的，不需要跑起来。
 *
 * @param {{registered: {handle: Set<string>, on: Set<string>}, invoked: Set<string>, sent: Set<string>}} input
 */
export function findPreloadDrift({ registered, invoked, sent }) {
  const problems = [];
  for (const name of invoked) {
    if (!registered.handle.has(name)) {
      problems.push(
        `preload 会调用 ${name}，但主进程没有这个 handle：界面一点就报「No handler registered」`,
      );
    }
  }
  for (const name of registered.handle) {
    if (!invoked.has(name)) {
      problems.push(`主进程实现了 ${name}，但 preload 没暴露给界面：这段代码永远跑不到`);
    }
  }
  for (const name of sent) {
    if (!registered.on.has(name)) {
      problems.push(`preload 会往 ${name} 发消息，但主进程没有监听：消息直接丢掉`);
    }
  }
  for (const name of registered.on) {
    if (!sent.has(name)) {
      problems.push(`主进程在监听 ${name}，但 preload 从不发：这个监听器是死代码`);
    }
  }
  return problems;
}

/** 入参形状表的条目：`[IPC_CHANNELS.x]: schema`。 */
const SCHEMA_ENTRY = /\[IPC_CHANNELS\.([A-Za-z0-9_]+)\]\s*:/g;

/** @returns {Set<string>} 登记了入参形状的通道名 */
export function parseSchemaChannels(source) {
  // 注释里的示例条目不算登记（形状表里会写「[IPC_CHANNELS.x]: ...」当说明）
  return new Set([...stripComments(source).matchAll(SCHEMA_ENTRY)].map((match) => match[1]));
}

/**
 * 入参校验覆盖对账：每个 handle 都要有形状，每个形状都要有 handle。
 *
 * 为什么要卡这一条：形状表是手写的，漏一条不会报错——那条通道就会静默地「什么都收」，
 * 而这正是我们想消灭的那类隐患。少一条或多了死条目都在 CI 里红。
 *
 * @param {{registered: {handle: Set<string>}, schemas: Set<string>}} input
 */
export function findSchemaGaps({ registered, schemas }) {
  const problems = [];
  for (const name of registered.handle) {
    if (!schemas.has(name)) {
      problems.push(
        `通道 ${name} 没有入参形状：在 app/shared/contracts/ipc-schemas.ts 里补一条（不带参数就写 none()）`,
      );
    }
  }
  for (const name of schemas) {
    if (!registered.handle.has(name)) {
      problems.push(`ipc-schemas.ts 给 ${name} 登记了形状，但主进程没有这个 handle：死条目`);
    }
  }
  return problems;
}

/** @returns {{invoked: Set<string>, sent: Set<string>}} */
export function parsePreloadChannels(source) {
  return {
    invoked: new Set([...source.matchAll(PRELOAD_INVOKE)].map((match) => match[1])),
    sent: new Set([...source.matchAll(PRELOAD_SEND)].map((match) => match[1])),
  };
}

/** 递归读 app/main 下所有 .ts，拼成一份语料（判断通道是否只出现在注释里）。 */
export function collectMainSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 注意：这里 push 的是「子目录的整份语料」这个字符串，不是它的展开——
      // 展开会把字符串拆成一个个字符（曾经因此让 71 条注册只剩 1 条被解析到）。
      files.push(collectMainSources(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(readFileSync(full, "utf8"));
    }
  }
  return files.join("\n");
}

/** 契约里有、但既没注册也没在 `webContents.send` 里出现的通道（多半是死契约）。 */
export function findOrphanChannels(channels, registered, allSource) {
  const all = new Set([...registered.handle, ...registered.on]);
  return channels.filter((name) => !all.has(name) && !allSource.includes(`IPC_CHANNELS.${name}`));
}

function main() {
  const contract = readFileSync(CONTRACT_FILE, "utf8");
  const mainSources = collectMainSources(MAIN_DIR);
  const preload = parsePreloadChannels(readFileSync(PRELOAD_FILE, "utf8"));
  const registered = parseRegistrations(mainSources);
  const channels = parseChannelNames(contract);
  const schemas = parseSchemaChannels(readFileSync(SCHEMA_FILE, "utf8"));
  const problems = [
    ...findIpcProblems({ handlersSource: mainSources, registered, channels }),
    ...findPreloadDrift({ registered, invoked: preload.invoked, sent: preload.sent }),
    ...findSchemaGaps({ registered, schemas }),
  ];
  for (const orphan of findOrphanChannels(channels, registered, mainSources)) {
    console.warn(`提示：IPC_CHANNELS.${orphan} 在主进程里没有注册也没被发送（死契约？）`);
  }
  const total = registered.handle.size + registered.on.size;
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error("IPC 契约不一致：" + problem);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `IPC 契约一致：${registered.handle.size} 个 handle + ${registered.on.size} 个 on（共 ${total} 条），全部经注册表登记、退出时统一注销，preload 与实现一一对应，${schemas.size} 个 handle 都有入参形状校验`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
