/**
 * 文件职责：单测 app/main/config.ts 的路径推导 —— 尤其便携模式（portable.txt）的分支。
 *
 * 为什么值得单独测：dataDir 决定「记忆库/日志/.env 落在哪」。默认写 userData 是有原因的
 * （安装目录不可写、多账户共用安装会串库、升级覆盖安装目录会丢数据）；便携模式是显式开关，
 * 两者一旦按错，用户看到的现象是「记忆凭空消失」或「%APPDATA% 里没有数据」。
 * 依赖方向：tests -> app/main/config.ts（纯函数，不 import electron、不碰磁盘）。
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadMainConfig, PORTABLE_MARKER } from "../app/main/config";

const exeDir = join("/opt/deskpet");
const execPath = join(exeDir, "deskpet.exe");
const userDataDir = join("/home/u/.config/deskpet");
const appRoot = join(exeDir, "resources", "app.asar");

function packaged(portable: boolean, env: Record<string, string> = {}) {
  return loadMainConfig({
    isDev: false,
    appRoot,
    resourcesRoot: join(exeDir, "resources"),
    userDataDir,
    env,
    execPath,
    portable,
  });
}

describe("loadMainConfig 便携模式", () => {
  it("默认（无 portable.txt）把数据放 userData", () => {
    const config = packaged(false);
    expect(config.dataDir).toBe(join(userDataDir, "data"));
    expect(config.charactersDir).toBe(join(userDataDir, "characters"));
    expect(config.logsDir).toBe(join(userDataDir, "data", "logs"));
    // 内置模型始终跟着发布包走，与数据目录无关
    expect(config.embedModelDir).toBe(join(exeDir, "models", "embedding"));
  });

  it("便携模式把数据与角色都放 exe 同级，仍然读包内模型", () => {
    const config = packaged(true);
    expect(config.dataDir).toBe(join(exeDir, "data"));
    expect(config.charactersDir).toBe(join(exeDir, "characters"));
    expect(config.logsDir).toBe(join(exeDir, "data", "logs"));
    expect(config.bundledRoot).toBe(exeDir);
    expect(config.embedModelDir).toBe(join(exeDir, "models", "embedding"));
  });

  it("显式 DESKPET_DATA_DIR 优先于便携模式", () => {
    const explicit = join("/tmp", "deskpet-data");
    const config = packaged(true, { DESKPET_DATA_DIR: explicit });
    expect(config.dataDir).toBe(explicit);
    expect(config.logsDir).toBe(join(explicit, "logs"));
    expect(config.charactersDir).toBe(join(exeDir, "characters"));
  });

  it("开关文件名稳定（外部脚本按它找）", () => {
    expect(PORTABLE_MARKER).toBe("portable.txt");
  });

  it("开发态不受便携开关影响：仍用仓库 data/ 与 assets/", () => {
    const repo = join("/home/sch/deskpet");
    const config = loadMainConfig({
      isDev: true,
      appRoot: repo,
      resourcesRoot: join(repo, "resources"),
      userDataDir,
      env: {},
      execPath: join(repo, "node_modules", "electron", "electron.exe"),
      portable: true,
    });
    expect(config.dataDir).toBe(join(repo, "data"));
    expect(config.charactersDir).toBe(join(repo, "characters"));
    expect(config.bundledRoot).toBe(join(repo, "assets"));
  });
});
