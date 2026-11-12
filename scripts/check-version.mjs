/**
 * 版本一致性检查（D8）：package.json 的 version 是唯一人工来源。
 *
 * 必须对齐的地方：
 *   1. CHANGELOG.md 有「## [x.y.z]」段；
 *   2. sidecar/pyproject.toml 的 project.version（打包出的 sidecar 产物版本）；
 *   3. sidecar/contracts/routes.py 的 SERVICE_VERSION（写进 OpenAPI / runtime.json / /health）；
 *   4. 发版流水线里的 tag（GITHUB_REF_NAME=refs/tags/vX.Y.Z）等于 v + version。
 * 只检查、不改文件，所以可以安全放进 pnpm verify 与 CI。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 取 CHANGELOG 里所有版本号（"## [x.y.z]" 形式；[Unreleased] 不算）。 */
export function changelogVersions(text) {
  return [...text.matchAll(/^##\s*\[([^\]]+)\]/gm)]
    .map((match) => match[1].trim())
    .filter((version) => version.toLowerCase() !== "unreleased");
}

/** 从 pyproject.toml 的 [project] 段取 version（不引 TOML 解析器：只认这一行，错了就报错）。 */
export function pyprojectVersion(text) {
  const project = text.split(/^\[project\]$/m)[1];
  const match = project === undefined ? null : /^version\s*=\s*"([^"]+)"/m.exec(project);
  return match === null ? "" : match[1];
}

/** 从 routes.py 取 SERVICE_VERSION。 */
export function serviceVersion(text) {
  const match = /^SERVICE_VERSION\s*=\s*"([^"]+)"/m.exec(text);
  return match === null ? "" : match[1];
}

/**
 * @param {{version: string, changelog: string, pyproject: string, routes: string, tag?: string}} input
 * @returns {string[]} 出错信息；空数组 = 通过
 */
export function checkVersion({ version, changelog, pyproject, routes, tag }) {
  const problems = [];
  if (!SEMVER.test(version)) {
    problems.push(`package.json version 不是语义化版本：${version}`);
  }
  const versions = changelogVersions(changelog);
  if (!versions.includes(version)) {
    problems.push(
      `CHANGELOG.md 里没有 [${version}] 段（现有：${versions.slice(0, 3).join(", ") || "无"}）`,
    );
  }
  const pyVersion = pyprojectVersion(pyproject);
  if (pyVersion !== version) {
    problems.push(`sidecar/pyproject.toml 是 ${pyVersion || "（读不到）"}，应为 ${version}`);
  }
  const engineVersion = serviceVersion(routes);
  if (engineVersion !== version) {
    problems.push(
      `sidecar/contracts/routes.py 的 SERVICE_VERSION 是 ${engineVersion || "（读不到）"}，应为 ${version}`,
    );
  }
  if (tag !== undefined && tag !== "") {
    const expected = `v${version}`;
    const actual = tag.startsWith("refs/tags/") ? tag.slice("refs/tags/".length) : tag;
    if (actual !== expected) {
      problems.push(`tag 是 ${actual}，而 package.json 是 ${version}（应为 ${expected}）`);
    }
  }
  return problems;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const problems = checkVersion({
    version: String(pkg.version),
    changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    pyproject: readFileSync(join(root, "sidecar", "pyproject.toml"), "utf8"),
    routes: readFileSync(join(root, "sidecar", "contracts", "routes.py"), "utf8"),
    tag: process.env.GITHUB_REF_NAME,
  });
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error("版本不一致：" + problem);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`版本一致：${pkg.version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
