/**
 * 文件职责：读 .env（LLM 端点与 key 所在处），提供路径推导、解析与合并三个纯函数 + 一个薄 IO 包装。
 *
 * 为什么需要它：Electron 不会自动加载 .env，而 D2/D3 的 API key 只放在 gitignored 的 .env 里；
 * 少了这一步，sidecar 永远拿不到 DESKPET_LLM_*（T1.3 才发现 key 到不了子进程）。
 * 优先级：真实进程环境变量 > .env 文件——部署时设环境变量即可覆盖文件，不必改文件。
 * 依赖方向：main -> node:fs + node:path；不 import electron，vitest 可直接单测。
 * 谁调用：app/main/index.ts 装配配置前读一次；tests/env-file.test.ts 单测解析与路径推导。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 开发与打包模式同名，只是所在目录不同。 */
export const ENV_FILE_NAME = ".env";

export interface EnvFileInput {
  readonly isDev: boolean;
  readonly appRoot: string;
  readonly userDataDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * 推导 .env 路径：优先 DESKPET_ENV_FILE（显式指定，多环境与测试最省事）；
 * 否则开发模式用仓库根、打包后 userData（安装目录不一定可写，用户目录一定可写）。
 */
export function resolveEnvFilePath(input: EnvFileInput): string {
  const explicit = input.env["DESKPET_ENV_FILE"];
  if (explicit !== undefined && explicit.trim() !== "") {
    return explicit;
  }
  return input.isDev ? join(input.appRoot, ENV_FILE_NAME) : join(input.userDataDir, ENV_FILE_NAME);
}

/**
 * 解析 .env 文本。支持：空行、# 注释、export 前缀、单/双引号包裹、CRLF。
 * 不支持：多行值、行内注释、变量插值——这些是 dotenv 的进阶语法，我们只需要 KEY=VALUE。
 * 语法越少越不容易出现「配置看起来生效了其实没有」；解析不了的行一律跳过，
 * 与 config.ts 的 positiveNumberOr 同策略：一个坏行不该让应用起不来（§6.7 A 级自愈）。
 */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = body.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value.slice(0, 1);
      const last = value.slice(-1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    result[key] = value;
  }
  return result;
}

/** 读 .env；路径为空、文件不存在、读不动都返回空表——缺配置的后果由 sidecar 按 §6.7 明示。 */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (path.trim() === "") {
    return {};
  }
  try {
    return parseDotEnv(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/** 合并两份环境变量：文件值做底，真实进程环境覆盖它（并丢掉值为 undefined 的项）。 */
export function mergeEnv(
  fileEnv: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...fileEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
