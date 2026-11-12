/**
 * 文件职责：首次启动把打包随附的默认角色复制到用户数据目录。
 *
 * 为什么需要：characters/ 是用户可写目录（导入 / 编辑 / 删除），不能直接放安装目录；
 * 但全新用户又需要先看到默认角色（当前是小玉）。只在用户角色目录为空时复制，绝不覆盖已有角色。
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DefaultCharactersLogger {
  info(event: string, message: string, detail?: Record<string, unknown>): void;
  warn(event: string, message: string, detail?: Record<string, unknown>): void;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 返回是否真的复制了默认角色。
 * - 开发态 / 没有 defaultCharactersDir：什么都不做
 * - 用户目录已有内容：尊重用户，什么都不做
 * - 复制失败：只记 warning，不影响启动
 */
export async function ensureDefaultCharacters(
  charactersDir: string,
  defaultCharactersDir: string,
  logger: DefaultCharactersLogger,
): Promise<boolean> {
  if (!(await isDirectory(defaultCharactersDir))) {
    return false;
  }
  let existing: string[] = [];
  try {
    existing = await readdir(charactersDir);
  } catch {
    await mkdir(charactersDir, { recursive: true });
  }
  if (existing.length > 0) {
    return false;
  }
  try {
    const entries = await readdir(defaultCharactersDir);
    await mkdir(charactersDir, { recursive: true });
    for (const entry of entries) {
      await cp(join(defaultCharactersDir, entry), join(charactersDir, entry), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
    logger.info("characters.seeded", "已复制默认角色包", {
      count: entries.length,
      characters_dir: charactersDir,
    });
    return true;
  } catch (error) {
    logger.warn("characters.seed_failed", "复制默认角色失败，继续启动", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
