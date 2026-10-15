/**
 * 文件职责：单测 app/main/env-file.ts 的 .env 路径推导、解析与合并。
 *
 * 为什么这些用例值得存在：LLM key 只存在于 .env，一旦解析悄悄变空，症状是
 * 「界面上只说网络不通」，极难定位（T1.3 的 key 通路正是靠这一层）。
 * 依赖方向：tests -> app/main（不 import electron）。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyEnvUpdates,
  ENV_FILE_NAME,
  mergeEnv,
  parseDotEnv,
  readEnvFile,
  resolveEnvFilePath,
  updateEnvFile,
} from "../app/main/env-file";

describe("resolveEnvFilePath", () => {
  it("开发模式用仓库根，打包后用 userData", () => {
    const base = {
      appRoot: "C:\\repo",
      userDataDir: "C:\\Users\\sch\\AppData\\deskpet",
      env: {},
    };
    expect(resolveEnvFilePath({ ...base, isDev: true })).toBe(join("C:\\repo", ENV_FILE_NAME));
    expect(resolveEnvFilePath({ ...base, isDev: false })).toBe(
      join("C:\\Users\\sch\\AppData\\deskpet", ENV_FILE_NAME),
    );
  });

  it("DESKPET_ENV_FILE 显式指定时优先，空串按未指定处理", () => {
    const base = { isDev: true, appRoot: "C:\\repo", userDataDir: "C:\\ud" };
    expect(resolveEnvFilePath({ ...base, env: { DESKPET_ENV_FILE: "D:\\secret\\.env" } })).toBe(
      "D:\\secret\\.env",
    );
    expect(resolveEnvFilePath({ ...base, env: { DESKPET_ENV_FILE: "   " } })).toBe(
      join("C:\\repo", ENV_FILE_NAME),
    );
  });
});

describe("parseDotEnv", () => {
  it("解析 KEY=VALUE，跳过空行与 # 注释", () => {
    const parsed = parseDotEnv(
      ["# LLM", "", "DESKPET_LLM_BASE_URL=https://api.example.com/v1", "DESKPET_LLM_MODEL=m"].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({
      DESKPET_LLM_BASE_URL: "https://api.example.com/v1",
      DESKPET_LLM_MODEL: "m",
    });
  });

  it("支持 export 前缀、引号包裹、值里含 = 与 CRLF", () => {
    const parsed = parseDotEnv("export A=\"a b\"\r\nB='c'\r\nC=x=y=z\r\nD=\r\nE = spaced \r\n");
    expect(parsed).toEqual({ A: "a b", B: "c", C: "x=y=z", D: "", E: "spaced" });
  });

  it("无法解析的行整行跳过，不影响其它行", () => {
    const parsed = parseDotEnv(["没有等号", "=空键", "# 注释=其中", "OK=1"].join("\n"));
    expect(parsed).toEqual({ OK: "1" });
  });
});

describe("readEnvFile", () => {
  it("读出文件内容；路径为空或文件不存在都返回空表", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-env-"));
    const file = join(dir, ".env");
    await writeFile(file, "DESKPET_LLM_API_KEY=k\n", "utf8");
    expect(await readEnvFile(file)).toEqual({ DESKPET_LLM_API_KEY: "k" });
    expect(await readEnvFile("")).toEqual({});
    expect(await readEnvFile(join(dir, "missing.env"))).toEqual({});
  });
});

describe("applyEnvUpdates", () => {
  it("就地改值并保住注释、空行、顺序与 export 前缀", () => {
    const before = [
      "# LLM 配置",
      "DESKPET_LLM_PROVIDER=cloud",
      "",
      "export DESKPET_LLM_MODEL=old",
      "# 这是注释里的 DESKPET_LLM_API_KEY=别改我",
      "DESKPET_LOG_LEVEL=debug",
      "",
    ].join("\n");
    const after = applyEnvUpdates(before, {
      DESKPET_LLM_MODEL: "new",
      DESKPET_LLM_PROVIDER: "local",
    });
    expect(after).toBe(
      [
        "# LLM 配置",
        "DESKPET_LLM_PROVIDER=local",
        "",
        "export DESKPET_LLM_MODEL=new",
        "# 这是注释里的 DESKPET_LLM_API_KEY=别改我",
        "DESKPET_LOG_LEVEL=debug",
        "",
      ].join("\n"),
    );
    // 回读一致性：改完再解析，拿到的就是新值
    expect(parseDotEnv(after)).toMatchObject({
      DESKPET_LLM_PROVIDER: "local",
      DESKPET_LLM_MODEL: "new",
      DESKPET_LOG_LEVEL: "debug",
    });
  });

  it("null 表示不修改，空串表示清空，缺失的键追加到文件末尾", () => {
    const after = applyEnvUpdates("DESKPET_LLM_API_KEY=sk-old\n", {
      DESKPET_LLM_API_KEY: null,
      DESKPET_TTS_URL: "http://127.0.0.1:8742",
    });
    expect(after).toContain("DESKPET_LLM_API_KEY=sk-old");
    expect(after).toContain("DESKPET_TTS_URL=http://127.0.0.1:8742");
    expect(parseDotEnv(after)["DESKPET_LLM_API_KEY"]).toBe("sk-old");

    const cleared = applyEnvUpdates("DESKPET_LLM_API_KEY=sk-old\n", {
      DESKPET_LLM_API_KEY: "",
    });
    expect(parseDotEnv(cleared)["DESKPET_LLM_API_KEY"]).toBe("");
  });

  it("值里有空格或 # 时加引号，解析回来仍是原值", () => {
    const text = applyEnvUpdates("", { DESKPET_LLM_API_KEY: "has space#and hash" });
    expect(text).toContain('DESKPET_LLM_API_KEY="has space#and hash"');
    expect(parseDotEnv(text)["DESKPET_LLM_API_KEY"]).toBe("has space#and hash");
  });

  it("空文本与 CRLF 文本都能写", () => {
    expect(applyEnvUpdates("", { A: "1" })).toBe(
      "# 以下由设置窗写入（T1.14b）：新增的配置项，改完重启后台引擎生效\nA=1\n",
    );
    expect(parseDotEnv(applyEnvUpdates("A=1\r\nB=2\r\n", { A: "9" }))).toEqual({ A: "9", B: "2" });
  });
});

describe("updateEnvFile", () => {
  it("文件不存在时新建，写入后可回读；密钥清空后不再是「已配置」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deskpet-env-write-"));
    const file = join(dir, ".env");
    const first = await updateEnvFile(file, {
      DESKPET_LLM_API_KEY: "sk-secret",
      DESKPET_LLM_PROVIDER: "cloud",
    });
    expect(first).toEqual({ DESKPET_LLM_API_KEY: "sk-secret", DESKPET_LLM_PROVIDER: "cloud" });
    expect(await readFile(file, "utf8")).toContain("DESKPET_LLM_API_KEY=sk-secret");

    const second = await updateEnvFile(file, { DESKPET_LLM_API_KEY: "" });
    expect(second["DESKPET_LLM_API_KEY"]).toBe("");
    // 只改了一个键：另一个还在，注释也没被推平
    expect(second["DESKPET_LLM_PROVIDER"]).toBe("cloud");
  });
});

describe("mergeEnv", () => {
  it("进程环境覆盖 .env，且丢掉值为 undefined 的项", () => {
    const merged = mergeEnv(
      { DESKPET_LLM_MODEL: "from-file", DESKPET_LOG_LEVEL: "debug" },
      { DESKPET_LLM_MODEL: "from-process", EMPTY: undefined, PATH: "C:\\bin" },
    );
    expect(merged).toEqual({
      DESKPET_LLM_MODEL: "from-process",
      DESKPET_LOG_LEVEL: "debug",
      PATH: "C:\\bin",
    });
    expect("EMPTY" in merged).toBe(false);
  });
});
