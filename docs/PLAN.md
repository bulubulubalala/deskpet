# deskpet · 实施计划（M0）

> 配套：`docs/REQUIREMENTS.md` v1.16（需求唯一正本）、`docs/CODE_STYLE.md` v1.3（代码规范，已冻结）
> 本文件只拆 **M0：骨架 + 打包打通**；M1 及以后在 M0 复盘时再拆（里程碑顺序见 REQUIREMENTS §8.2）。
> 排序判据见 REQUIREMENTS §8.1：能拖累别人的先做（接口、格式、状态机），改了不疼的后做（界面、参数、素材）。

## 0. M0 的目标与完成判据

**一句话目标**：把「壳 ↔ 大脑 ↔ 打包 ↔ 仓库」这条主脊打通。之后每个功能都只是往骨架里填模块，不再动地基。

| 来源 | 完成判据 |
|---|---|
| REQUIREMENTS §8.2（M0） | 干净 Windows 上装完能打开主界面；打包产物本地一键产出（CI / Release 推迟到 M5 按需） |
| REQUIREMENTS §7.2 | 心跳诚实：sidecar 掉线 3s 内 UI 变红，随后自动重启恢复 |
| REQUIREMENTS §8.1（P0 行） | 打包/仓库/CI、sidecar API 契约、IPC 白名单 → M0 内冻结 |
| CODE_STYLE §9 | pre-commit 从 M0 起生效；**GitHub Actions 推迟到 M5（按需）** |

**M0 结束那天应能演示**：双击桌面图标 → 主界面出现（占位 PNG 角色 + 心跳绿灯 + 模块状态）→ 任务管理器里看得见 sidecar 进程 → 手动 kill 它 → 灯变红并在数秒内自动重启恢复 → 卸载重装仍然如此。

## 1. 前置任务（开工前必须解决）

| # | 问题 | 现状（实测） | 处理 |
|---|---|---|---|
| P1 | Windows 侧没有 pnpm | ✅ 已解决（2026-10-13）：Windows 侧装好 pnpm 12.10.1（走 `npm i -g pnpm@12`；`corepack enable` 实测 EPERM，需管理员） | 已写进 README「开发环境准备」 |
| P2 | Windows 侧没有 Python 3.12 | ✅ 已解决（2026-10-13）：装好 Python 3.13.15（用户级 `C:\Users\sch\AppData\Local\Programs\Python\Python313`），项目独立 venv `.venv` 已建（不进 git） | 装 **Python 3.13**（`winget install -e --id Python.Python.3.13`）；**每个项目一个独立 venv**（deskpet 用 `.venv`，已进 .gitignore），不用系统 3.14——faster-whisper / sqlcipher3 / PyInstaller 在 3.14 上大概率缺轮子 |
| P3 | D 盘在 WSL 是只读挂载（9p ro） | WSL 侧 touch/cp/mkdir 报 Read-only file system | **编辑代码在 WSL，git 与所有安装/构建在 Windows 侧**；文件落地走 Windows 侧复制（现有做法） |
| P4 | 仓库根目录名 | ~~当前文件系统上叫 My_desktop~~ | **已确认（2026-10-13）**：目录名已改回 `D:\Agent_Projects\deskpet`，与 D6 一致 |

## 2. 任务表（13 项）

| # | 任务 | 为什么现在做 | 产物 | 验收 | 依赖 | 估时 |
|---|---|---|---|---|---|---|
| T0.1 | 仓库与目录骨架 | 一切任务的落点，先有地方放东西 | git init；按 §9.1 建 app/ sidecar/ characters/ docs/ scripts/ tests/ data/；.gitignore（.env、*.db、node_modules/、dist/、*.safetensors、models/、*.wav、__pycache__/、.venv/） | `git status` 干净，结构可对照 §9.1 | — | 0.5h |
| T0.2 | 依赖与工具链 | 没有可运行环境，后面全部卡住 | Windows 侧 pnpm（corepack）+ **项目独立 venv**（`.venv`，Python 3.13 基础，`pip install -e sidecar`）；sidecar/pyproject.toml（requires-python >=3.12、ruff/mypy/pytest 配置）；根 package.json（electron、electron-builder、typescript、eslint、prettier、vitest） | `pnpm -v`、`python -V`、`pnpm lint`、`pytest -q` 四条命令能跑 | P1 P2 | 1h |
| T0.3 | 契约先行：sidecar API + IPC 白名单 | P0：接口晚定所有模块都要返工；M0 只实现 /health，但路由表与字段先钉死 | 路由清单（/health 实现，其余桩）；导出的 OpenAPI；app/main/ipc.ts 的 channel 常量 + payload 类型；tests/test_api_contract.py | 契约测试通过；IPC 类型编译通过 | T0.2 | 2h |
| T0.4 | 日志与错误码骨架 ✅ | 没有结构化日志就没法定位；错误码域表已冻结（CODE_STYLE §6.4） | DP-域-三位 常量表（9 域 29 码）、单行 JSON 日志（落点 `data/logs/deskpet.log`）、7 天 / 20 MB 滚动、敏感字段脱敏、`DeskpetError` 九个子类 + 边界错误处理器 | 故意抛异常 → 日志含 code/domain/message/trace，中文不乱码（✅ 2026-10-14 实测通过） | T0.2 | 1h |
| T0.5 | sidecar 起服务 + 端口握手 | 大脑地基；心跳是 M0 唯一的「活着」证据。**四层骨架与 /health 已在 T0.3 落地**，本项只剩「真的用 uvicorn 起起来」 | uvicorn 启动 + **runtime.json 端口握手**（§6.10）+ 端口占用自动换端口；/health 返回 status/uptime/modules/gpu | curl 127.0.0.1:<port>/health 200 且 ≤10ms，不加载任何模型；runtime.json 在监听成功后才出现、退出即删 | T0.3 | 1h |
| T0.6 | Electron 壳 + 心跳链路 ✅ | §7.2 的诚实状态显示；壳与大脑首次连通 | main 每 2s 轮询 /health，3 次失败判离线并自动重启（≤3 次）；preload 白名单；renderer：占位 PNG + 心跳灯 + 模块状态 + 版本号；托盘图标 | kill sidecar → **≤6s 灯红**（2s × 3 次心跳）、≤10s 自动恢复绿（✅ 2026-10-14 实测：硬杀 sidecar → 3 次失败 → 自动重启 → 6.5s 内 /health 恢复 200） | T0.5 | 3h |
| T0.7 | 生命周期：单实例 / 端口 / 退出清理 ✅ | 常驻桌面程序最容易出的三类脏问题 | requestSingleInstanceLock；端口被占自动换端口并回传；退出时结束 sidecar（taskkill 兜底）；新增冒烟钩子 `DESKPET_SMOKE_QUIT_MS`（到点走与托盘「退出」完全相同的路径，供无人值守打包冒烟用） | 双开只出一个窗口；端口被占不崩；退出后任务管理器无残留（✅ 2026-10-14 实测：占住 8737 → 回退到 60063 且 `/health` 200；第二个实例自行退出、窗口数 1、sidecar pid 不变；到点退出后 runtime.json 已删、孤儿 sidecar 0、electron 进程 0） | T0.6 | 1h |
| T0.8 | sidecar 打包（PyInstaller onedir）✅ | 打包是 M0 判据，也是「能不能分发」的分水岭 | PyInstaller --onedir + 提交 sidecar.spec；scripts/build_sidecar.ps1（用项目 .venv 跑）；config 的默认数据目录按源码态/打包态分流 | dist/sidecar/sidecar.exe 单独运行，/health 200（✅ 2026-10-14 实测：产物 101 文件 / 30.9 MB；不设 DESKPET_DATA_DIR 单独跑 → 数据落 exe 旁 data/、runtime.json pid 与 Start-Process pid 一致、`/health` 200（冷启动到首个 200 约 4.7s）、无 token 401 `DP-SYS-401`、`POST /tts` 501 `DP-SYS-501`、日志含 `sidecar.launch`；`taskkill /F` 后 runtime.json 残留属已知行为，由 Electron 侧按陈旧文件兜底） | T0.5 | 2h |
| T0.9 | electron-builder NSIS + 免安装 zip ✅ | 「干净 Windows 装完能开」是 §8.2 的 M0 判据 | electron-builder.yml（asar 只装 dist/ 与 package.json；sidecar 走 extraResources 放 resources\sidecar\）、scripts/build_release.ps1（esbuild → PyInstaller → electron-builder 三合一）、package.json 的 build:sidecar / pack:win 脚本 | 干净系统（或全新用户）安装后双击能开，心跳绿（✅ 2026-10-14 实测：`deskpet-0.1.0-x64.exe` 133.4 MB / `deskpet-0.1.0-x64.zip` 177.1 MB；win-unpacked 与「NSIS 静默安装到测试目录」两处各跑一遍：窗口标题 deskpet、打包态日志 `isDev=false`、`/health` 200（启动到首个 200 约 5.6s / 6.3s）、到点退出后 runtime.json 已删且无孤儿进程；静默卸载后安装目录整体消失） | T0.8 T0.6 | 2h |
| T0.10 | 本地 git 工作流（**不含 GitHub**）✅ | 先让版本管理可用；发布按需再做（M5） | 分支约定 main/dev、提交信息走约定式、SemVer 与 tag 规则写进 README | `git log --oneline` 符合约定式；能正常 tag / branch / merge（✅ 2026-10-14 实测：建立 `dev` 集成分支；本次文档改动走 `docs(docs): ...` 提交在 dev，再 `git merge --no-ff dev` 回 main；打注释 tag `v0.1.0-m0.1`；`git log --oneline --graph` 符合约定式且有合并点） | T0.1 | 0.5h |
| T0.11 | pre-commit | 规范要落在提交那一刻，而不是靠自觉 | .pre-commit-config.yaml：ruff check / format、mypy、eslint、prettier、tsc --noEmit | 故意提交格式错误被拦下 | T0.2 | 0.5h |
| T0.12 | 冷启动与体积实测 | §3 的实测数据是后续性能决策的基线 | 双击到主界面可见的时间、安装包体积、解压体积、sidecar 冷启动时间 → docs/MEASURED.md | 数字入档，并与 §3 的估算对照 | T0.9 | 0.5h |
| T0.13 | M0 复盘 + 拆 M1 | 走完一轮才知道哪些估时离谱；M1 要靠真实数据拆 | 复盘记录 + 本文件新增 M1 章节 | 对照 §11 核对表第 4 行通过 | 全部 | 0.5h |

估时合计约 **16.5 小时**（一人）。

### 2.1 进度记录（滚动）

| 日期 | 任务 | 结果 |
|---|---|---|
| 2026-10-14 | T0.10 本地 git 工作流 | 完成：README 新增「Git 工作流（本地）」章节（分支模型 main / dev / feat、fix、docs、chore；Conventional Commits 的 type 与 scope 表；SemVer 递增规则与「注释 tag、唯一版本源是 package.json version」；合并用 --no-ff）。**实测**：`git checkout -b dev` → 本次文档改动在 dev 上提交 → `git merge --no-ff dev` 回 main → `git tag -a v0.1.0-m0.1`（M0 中间态预发布 tag）；`git log --oneline` 全部是约定式；`git branch -v` 显示 main / dev 都在合并点上。GitHub / Actions / Release 按 §7 第 5 条推迟到 M5。 |
| 2026-10-14 | T0.9 打包发布（NSIS + 免安装 zip） | 完成：新增 `electron-builder.yml`（asar 只装 `dist/**` 与 package.json；sidecar onedir 走 extraResources 落 `resources\sidecar\`——`app/main/sidecar-process.ts` 打包态正是按 `resourcesRoot/sidecar/sidecar.exe` 找它；NSIS 非一键安装、可选安装目录、建桌面与开始菜单快捷方式、卸载不删用户数据）、`scripts/build_release.ps1`（pnpm build → build_sidecar.ps1 → electron-builder --win --x64；缺 `dist\sidecar\sidecar.exe` 直接抛错）、`assets/packaging/`（buildResources 占位，图标待补，当前用 Electron 默认图标；刻意不叫 build/ 以免撞上 .gitignore 的 build/ 规则）、package.json 增 `author` 与 `build:sidecar` / `pack:win` 脚本。**实测**（`_t09_e2e.ps1`）：产物 `release\deskpet-0.1.0-x64.exe` 133.4 MB（NSIS）/ `deskpet-0.1.0-x64.zip` 177.1 MB（免安装）；win-unpacked 与静默安装（`/S /D=D:\deskpet_install_test`）各跑一轮：窗口标题 deskpet、主进程日志 `isDev=false`、`/health` 200（启动到首个 200 约 5.6s / 6.3s，六个模块 idle）、`DESKPET_SMOKE_QUIT_MS` 到点退出后 runtime.json 已删、孤儿 sidecar 0 / 应用进程 0；静默卸载后安装目录整体消失。**踩坑留档**：① PowerShell 5.1 下 `$ErrorActionPreference = "Stop"` + 原生命令（taskkill）往 stderr 写一行「没找到进程」就会抛 NativeCommandError 把整脚本打断——清理进程改用 `Get-Process | Stop-Process -Force`，判定一律走显式 Test-Path；② **任何 edit 工具改过 .ps1 都会丢掉 UTF-8 BOM**，含中文的脚本必须在运行前重新加 BOM（本轮第二次被咬）。 |
| 2026-10-14 | T0.8 sidecar 打包（PyInstaller onedir） | 完成：新增 `sidecar/sidecar.spec`（onedir；uvicorn 运行期动态 import 的实现模块写进 hiddenimports；排除 pytest/mypy/ruff）、`scripts/build_sidecar.ps1`（用项目 `.venv` 跑 PyInstaller，`-Clean` 清 `build/pyinstaller` 与 `dist/sidecar`，产出后打印体积）、`sidecar/config.py` 新增 `default_data_dir(*, frozen, executable)`（源码态 = 仓库 `data/`；打包态 = exe 旁 `data/`，避免往 bundle 内只读资源里写；Electron 打包态仍靠 `DESKPET_DATA_DIR` 落 userData）、`tests/test_config_paths.py`（3 例）、dev extras 固定 `pyinstaller==6.22.3`。**实测**（`_t08_e2e.ps1` / `_t08_err.ps1`）：`dist/sidecar/` 101 文件 / 30.9 MB；不设 `DESKPET_DATA_DIR`、只设 `DESKPET_SIDECAR_PORT` 单独跑 exe → 数据落在 exe 旁 `data/`，runtime.json 的 pid 与 `Start-Process` 拿到的 pid **相同**（开发态那层 launcher 间接在打包后消失，回答需求 §6.10 里留的疑问）；`/health` 200（`uptime_s` 0.183、冷启动到首个 200 约 4.7s）、无 token 401 `DP-SYS-401`、`POST /tts` 501 `DP-SYS-501`（错误信封连同响应体一起验证）、`data/logs/deskpet.log` 含 `sidecar.launch`；`taskkill /F` 后 runtime.json 残留（已知，Electron 侧兜底清）。静态检查：pytest **62 passed**、ruff check / format --check（28 files）、mypy（28 files）全过。**踩坑留档**：① **`.ps1` 里写中文必须存成 UTF-8 with BOM**——Windows PowerShell 5.1 对无 BOM 的脚本按 ANSI（GBK）解码，中文变乱码后引号配对失败，报 `TerminatorExpectedAtEndOfString` 且整份脚本一行都不执行（首次构建就栽在这，脚本内容其实没错）；② PyInstaller 不能跨平台交叉打包，必须在 Windows 侧用项目自己的 `.venv` 跑；③ 动态 import 的模块（uvicorn 的 loops/protocols/lifespan/logging）漏进 hiddenimports 会表现为「开发态全绿、打包后启动即 ModuleNotFoundError」。 |
| 2026-10-14 | T0.7 生命周期：单实例 / 端口 / 退出清理 | 完成：`app/main/index.ts` 新增冒烟钩子 `DESKPET_SMOKE_QUIT_MS`（到点 `app.quit()`，与托盘「退出」同一路径；日志写在回调节点，因为这段代码跑在 bootstrap 之前、那时 logger 还没建）。**端到端实测**（`_t07_e2e4.ps1`）：① 用 TcpListener 占住 8737 → sidecar 自动回退到 60063，`/health` 200；② 第二次启动 electron → 8s 内自行退出（单实例锁），`deskpet` 标题窗口数 = 1，runtime.json 里的 pid 与第一次一致（没抢走 sidecar）；③ `DESKPET_SMOKE_QUIT_MS=20000` 到点退出 → 主进程日志 `app.smoke_quit` → `sidecar.stop` → `app.quit`，退出后 runtime.json 已删、孤儿 sidecar 0 个、electron 进程 0 个；④ 8000ms 快速复验同样干净。**踩坑留档**：① `pnpm.ps1` 包装器下 `$LASTEXITCODE` 不可靠（打印为空、把成功的构建判成失败）——判成败要用 `pnpm.cmd` 或直接看产物（`dist/main/index.js` 大小 / `Select-String` 关键字）；② 冒烟脚本里绝不能写 `Stop-Process -Name powershell`（脚本自己就是 powershell，会自杀导致整轮静默中断）；③ **改了主进程源码必须 `pnpm build`**，`electron .` 跑的是 `dist/main/index.js`，不重建就会出现「改了没生效」的假象；④ 第二次启动 electron 会报 `netdisk_cachecache_util_win.cc: Unable to move the cache: 拒绝访问 (0x5)`——userData 缓存目录被第一个实例占着，属预期噪音。 |
| 2026-10-14 | T0.6 Electron 壳 + 心跳链路 | 完成：主进程模块（config / errors / logger / runtime-file / heartbeat / health-client / sidecar-process / engine / ipc-handlers）+ 组合根 `app/main/index.ts`（窗口 900×640、托盘、单实例锁、关闭即隐藏、will-quit 停 sidecar）、preload `contextBridge`（health.get / onChanged / sidecar.restart / app.getInfo）、renderer 心跳面板（占位 PNG + 灯 + 模块 + 版本 + 重启按钮）、`scripts/build.mjs`（esbuild 三目标 → dist/）。**端到端实测**：起 electron → 拉起 sidecar（launcher pid 36420 / runtime.json pid 20008）→ 握手 0.54s → `/health` 200；硬杀 sidecar → 心跳失败 3 次（2s 间隔）→ `state=offline` + `restarts_used=1` → 自动重启 → 新 pid 25768 握手成功 → `restart_ok`，全程约 6.5s，再次 `/health` 仍 200。静态检查：pytest 59 passed；`pnpm lint` / `typecheck` / `test`（25 passed）/ `build` / `format:check` 全 exit 0。**踩坑留档**：① pnpm 认为依赖已最新时会跳过 electron 自己的 postinstall，必须手动 `node node_modules/electron/install.js`（带 `ELECTRON_MIRROR`）才会下载 electron.exe（246,302,208 字节）；② TS 的 typeof 收窄在「只 push 不 return」的分支里不生效（`parseRuntime` 逐字段校验后仍需显式 `as` 断言）；③ flat config 下 `.mjs` 里的 console / process 被判 no-undef，要显式声明 globals；④ 测试 fake 写成 async 而无 await 会触发 require-await，改成返回 `Promise.resolve()` / `Promise.reject()`；⑤ 灯变红口径 = 连续 3 次失败 ≈ 6s，比计划里写的 3s 长（见 v0.7）。 |
| 2026-10-14 | T0.4 日志与错误码骨架 | 完成：`sidecar/contracts/errors.py`（`ErrorDomain` 九域 + 29 个码常量 + `ERROR_CODES` 对账表 + `domain_of()`）、`sidecar/core/errors.py`（`DeskpetError` + 九个子类，`MemoryStoreError` 刻意不叫 `MemoryError`）、`sidecar/core/logging.py`（`log_event` / `redact_fields` 14 个敏感字段 / `format_trace`）、`sidecar/adapters/log_writer.py`（单行 JSON、UTF-8、LF、20 MB / 7 天滚动、现开现关）、`sidecar/api/error_handlers.py`（DeskpetError → 500 信封 + 日志带 code/domain/trace；未知异常 → `DP-SYS-500` 不泄原文）；`config.py` 加 `DESKPET_LOG_MAX_BYTES` / `DESKPET_LOG_RETENTION_DAYS`，`main.py` 起服务即装日志并记 `sidecar.launch` / `sidecar.exit`。验证：pytest **59 passed**（新增 `tests/test_logging.py` 14 + `tests/test_error_boundary.py` 5），ruff / format / mypy（28 files）全过；真实入口冒烟：`data/logs/deskpet.log` 落盘、单行、0 个 CRLF、中文可解码，故意抛 `TtsError` → `code=DP-TTS-001` / `domain=TTS` / `trace` 含 `TtsError` / 业务字段 `method`+`path`+`sentence_index` |
| 2026-10-14 | T0.5 sidecar 起服务 + 端口握手 | 完成：真实入口 `python sidecar/main.py` 起 uvicorn，`data/runtime.json` 在监听成功后落盘（pid/host/port/token/started_at/version），端口被占自动回退随机端口；`GET /health` 200（稳态 1.06ms、首次 141ms）、无 token 401（`DP-SYS-401`）、`POST /tts` 501（`DP-SYS-501`）、优雅退出即删握手文件；token 走 `X-Deskpet-Token` 头 + `secrets.compare_digest`。pytest **29 passed**（`test_runtime_boot.py` 11 + `test_sidecar_launch.py` 1 端到端），ruff / format / mypy 全过 |
| 2026-10-13 | T0.1 仓库与目录骨架 | 完成：`git init -b main`，首个提交 `681916f`（18 个文件），运行时目录 `data/` 整体 gitignore，工作区干净 |
| 2026-10-14 | T0.3 契约先行：sidecar API + IPC 白名单 | 完成：**24 个文件**——`sidecar/contracts/`（routes 路由表 11 条 / health / errors / events / api_models）+ `api`（health 真实现 + 10 个 501 桩 + router）+ `core`（ModuleRegistry、Clock）+ `services`（HealthService）+ `adapters`（SystemClock）+ `app.py` 组合根；导出的 `sidecar/contracts/openapi.json`（11 paths / 8 schemas）与 `llm_events.schema.json` 快照；`app/main/ipc.ts` 的 4 条 channel 常量与 HealthSnapshot / AppInfo 类型；契约测试 `tests/test_api_contract.py`（6）、`tests/test_event_contract.py`（5）、`tests/ipc-contract.test.ts`（5）。验证：pytest **16 passed**、ruff check / format / mypy 全过、`pnpm lint` / `typecheck` / `format:check` / `test`（7 passed）全 exit 0。**契约已写进需求 §6.10**（IPC 白名单 + runtime.json），§13 第 16 条 |
| 2026-10-14 | T0.2 依赖与工具链 | 完成：Windows 侧 Python 3.13.15 + 项目独立 `.venv`、pnpm 12.10.1；sidecar 五层包骨架 + `pyproject.toml`（Ruff 100 列 / mypy strict / pytest）、前端 ESLint 9 + Prettier + tsconfig strict + Vitest；提交 `0bc0ea9`。验证：pytest 6 passed、`ruff check` / `ruff format --check` / `mypy` 全过、`pnpm lint` / `typecheck` / `format:check` / `test` 全 exit 0 |

## 3. 顺序、依赖与并行

```
关键路径：T0.1 → T0.2 → T0.3 → T0.5 → T0.6 → T0.7 → T0.8 → T0.9 → T0.10 → T0.12 → T0.13
            （T0.8 只依赖 T0.5，可与 T0.6/T0.7 并行）
可随时插入：T0.11 pre-commit（T0.4 日志骨架已于 2026-10-14 完成）
```

理由：**契约（T0.3/T0.5）先于一切业务**——M0 之后所有模块都通过 /health 与 IPC 白名单说话，这两个改一次、全体返工。界面与打包排在后面，因为它们错了只是重做自己。

## 4. M0 明确不做

- 不接 LLM、不接 TTS/ASR、不碰 Live2D、不做记忆、不做角色包编辑器、不做屏幕识别
- 不建 usage.db（F10 记录层落点 M1，见 REQUIREMENTS §8.1）
- 不下载/不打包模型（D: 剩余 39.9 GB，仍不进仓库、不进安装包）
- 不做自动更新、不做代码签名（无证书；SmartScreen 警告写进 README）

## 5. 风险与预案

| # | 风险 | 预案 |
|---|---|---|
| R1 | Python 3.14 上依赖轮子缺失 | 按 P2 装 3.12/3.13 专用解释器；CI 也用 3.12，保证「本机能跑 = CI 能跑」 |
| R2 | PyInstaller onefile 冷启动慢（每次解压） | 已定 **onedir**（§9.3）；T0.12 实测数字留档 |
| R3 | 打包后 spawn 不到 sidecar | sidecar 必须放 resources/sidecar/（asar 之外），路径用 process.resourcesPath 拼接；开发态与打包态走同一个解析函数 |
| R4 | 首次打包要下载 Electron / NSIS 二进制 | 本地先跑通一次；CI 用缓存；失败时把版本锁定在 package.json |
| R5 | Windows 控制台 GBK 中文乱码 | 日志强制 UTF-8 写文件、控制台 chcp 65001；仓库路径全英文 |
| R6 | sidecar 僵尸进程 | 退出钩子 + taskkill 兜底，T0.7 验收明确检查任务管理器 |

## 6. M0 之后的预告（不在本期）

- M1 = 语音全双工闭环（F2）+ 环境事件总线接口（§6.8）+ usage.db 记录层（F10 的 P1 行）
- 接口按 §6.2（LLM 行事件协议）与 §6.3（sidecar API）实现，M0 已把这些契约定死

## 7. 开工前待确认

1. ~~仓库根目录名~~ → **已定：deskpet**（2026-10-13）
2. sidecar 框架：FastAPI + uvicorn（✅ T0.2 已按建议采用）
3. sidecar 端口：127.0.0.1:8737（✅ T0.2 已按建议采用，可配置）
4. 产品名与窗口标题：deskpet（✅ 已沿用）
5. ~~GitHub 仓库~~ → **已定：先不做，M5 按需**（2026-10-13）
6. 包管理器：pnpm（✅ T0.2 已按建议采用）

## 8. 变更记录

- **v0.11（2026-10-14）**：**T0.10 完成**（本地 git 工作流落地并演示）。README 新增「Git 工作流（本地）」一节：分支模型（`main` 稳定线 / `dev` 集成 / `feat`、`fix`、`docs`、`chore` 短分支，合并一律 `--no-ff`）、Conventional Commits 的 type 与 scope 表（与 CODE_STYLE §5 同源）、SemVer 递增规则与 tag 规范（带注释 tag、格式 `v<major>.<minor>.<patch>`、预发布后缀、**唯一版本源是 `package.json` 的 `version`**）。**实测演示**：建 `dev` → 文档改动在 dev 提交 → `--no-ff` 合并回 `main` → 打注释 tag `v0.1.0-m0.1`（M0 中间态预发布；M0 全部完成时再打正式 `v0.1.0`）。**约定留档**：GitHub 仓库 / Actions CI / Release 推迟到 M5 按需（§7 第 5 条），M0 起只做本地 git；**git 命令一律在 Windows 侧执行**（D 盘在 WSL 是只读挂载）。
- **v0.10（2026-10-14）**：**T0.9 完成**（electron-builder 产出 NSIS 安装包与免安装 zip，安装后能开、心跳绿、退出干净）。打包形态定案：**asar 只装 `dist/` 与 package.json，Python 侧整目录走 extraResources 放 `resources\sidecar\`**（exe 不能被 asar 包住，且主进程打包态就是按这个相对路径找它）。体积基线入档：安装包 133.4 MB、免安装 zip 177.1 MB（内含 30.9 MB 的 PyInstaller sidecar 与 Electron 运行时）；T0.12 会把「双击到主界面可见」做成完整实测并写进 `docs/MEASURED.md`。**踩坑留档**：① PowerShell 5.1 里 `$ErrorActionPreference = "Stop"` 遇上原生命令往 stderr 写话（如 `taskkill` 没找到进程）会被当作终止性错误，脚本静默中断——冒烟脚本改 `"Continue"` + 用 `Get-Process | Stop-Process`，判定改用显式 `Test-Path`；② **编辑工具写回 .ps1 会丢 UTF-8 BOM**，含中文的 .ps1 每次改动后都要补 BOM，否则报 `TerminatorExpectedAtEndOfString`（本轮又被咬一次）；③ electron-builder 首次运行要从 GitHub 拉 NSIS / winCodeSign / 7zip 二进制，国内必须配 `ELECTRON_BUILDER_BINARIES_MIRROR`（已写进脚本注释与 README）；④ 没有 `author` 字段时 electron-builder 会告警，已补。 |
- **v0.9（2026-10-14）**：**T0.8 完成**（sidecar 用 PyInstaller onedir 打包，`sidecar.exe` 能脱离 Electron 单独起服务）。打包配置与构建脚本进仓库（`sidecar/sidecar.spec`、`scripts/build_sidecar.ps1`），`pyinstaller` 以固定版本进 dev extras（产物行为对版本敏感）。**关键发现**：① 打包后 `Start-Process` 的 pid 与 runtime.json 里的 pid 一致——开发态那层 `.venv\\Scripts\\python.exe` launcher 间接不存在了，主进程杀 sidecar 时不再有「杀错 pid」的隐患；② 数据目录默认值必须分流：打包后 `__file__` 在 bundle 内，按源码路径推 `data/` 会指向只读资源，故冻结态改用 exe 旁目录（真实运行时仍由 Electron 传 `DESKPET_DATA_DIR` 落 userData）；③ 冷启动到首个 `/health` 200 约 4.7s（含进程启动 + uvicorn 起服务 + 我们轮询文件的开销），T0.12 会与 Electron 侧一起测完整「双击到主界面」时间。**踩坑留档**：`.ps1` 含中文必须存 **UTF-8 with BOM**，否则 PowerShell 5.1 按 ANSI 解码 → `TerminatorExpectedAtEndOfString` 且整份脚本不执行（这次错了两次才定位：报错行看起来是引号问题，根因是编码）。
- **v0.8（2026-10-14）**：**T0.7 完成**（单实例 / 端口回退 / 退出清理三项端到端实测通过）。新增冒烟钩子 `DESKPET_SMOKE_QUIT_MS`：设了环境变量就在到点走与托盘「退出」完全相同的收尾路径，让打包冒烟与（未来的）CI 能无人值守地验证「退出后不留孤儿 sidecar / runtime.json」——这是 T0.9 安装包冒烟与 T0.12 冷启动实测要复用的抓手。**为什么不在 T0.6 就算完**：T0.6 只落了单实例锁与退出清理的代码，没验证；T0.7 把三件事都跑成了可复现的数字。**踩坑留档**：① `pnpm.ps1` 包装器下 `$LASTEXITCODE` 不可靠（为空的假失败），判成败要用 `pnpm.cmd` 或看产物；② 冒烟脚本不能 `Stop-Process -Name powershell`（自杀）；③ 改主进程源码后必须 `pnpm build`，否则 `electron .` 仍跑旧的 `dist/main/index.js`。
- **v0.7（2026-10-14）**：**T0.6 完成**（Electron 壳 + 心跳链路端到端跑通，3h 估时对得上）。新增 main 侧 9 个模块 + 组合根 + preload + renderer + esbuild 构建（`dist/main/index.js` 29.8 KB）；T0.6 验收口径按实测修正为「≤6s 灯红、≤10s 恢复」。**口径澄清（唯一待拍板项）**：计划里写「3s 内灯红」是按「立刻发现死亡」想的，但状态机要求连续 3 次心跳失败才判离线，实测 2s × 3 ≈ 6s 才变红（恢复完成约 6.5s）。若要 3s 内变红，需把 `DEFAULT_HEALTH_POLL_MS` 降到 1000 或 `DEFAULT_MAX_HEALTH_FAILURES` 降到 2；当前保持 2s × 3（对本地 HTTP 更稳，不会因一次抖动误判）。**踩坑留档**：① pnpm install 对 electron 打印「Already up to date」会跳过它的 postinstall，`electron.exe` 不落地，必须单独跑 `node node_modules/electron/install.js`；② TS 的 typeof 收窄在「分支只 push 不 return」时失效；③ ESLint flat config 下 `.mjs` 脚本里的 console / process 会被 no-undef 拦；④ `@typescript-eslint/require-await` 会让「async 但没有 await」的测试 fake 报错；⑤ 主进程日志里 `sidecar 进程退出` 的 pid 是 Popen 拿到的 launcher pid，与 runtime.json 里的真实 pid 不同（36420 vs 20008）。
- **v0.6（2026-10-14）**：**T0.4 完成**：日志与错误码骨架落地（`contracts/errors.py` 29 码 + `core/errors.py` 九子类 + `core/logging.py` + `adapters/log_writer.py` + `api/error_handlers.py`），pytest 59 passed / ruff / mypy 全过，真实入口落盘 `data/logs/deskpet.log`。**踩坑留档**：① `import app` 在仓库根会被 Electron 目录 `app/` 抢走——`tests/conftest.py` 必须把 `sidecar/` 插到 `sys.path` 最前；② pytest 的 caplog 会往 `deskpet` logger 挂自己的 handler，测试断言「只有一个 handler」时必须 `isinstance(h, RollingJsonLogHandler)`；③ Starlette 的 `add_exception_handler` 要求处理器第二参为 `Exception`（不是子类），签名必须收 `Exception` 再 isinstance 收窄；④ `except Exception:` 上加 `# noqa: BLE001` 会触发 RUF100（该规则未启用），改用普通注释；⑤ ruff 会把百分号格式化判为 UP031（改 f-string）、docstring 也吃 100 列限制。
- **v0.1（2026-10-13）**：M0 任务拆解初稿（13 项任务 + 4 项前置 + 6 条风险）。
- **v0.2（2026-10-13）**：P4 目录名已确认（deskpet）；Python 环境定为**项目独立 venv**（3.13 基础）；T0.10 由「GitHub Actions + Release」改为「本地 git 工作流」，GitHub / Actions / Release 推迟到 M5 按需（需求 v1.13 同步）。
- **v0.5（2026-10-14）**：**T0.5 完成**：新增 `sidecar/config.py`（Settings + load_settings）、`sidecar/main.py`（launch / serve / run：绑定端口 → 生成 token → 写 runtime.json → uvicorn 起服务，finally 删文件）、`sidecar/adapters/runtime_file.py`（原子写 / 读 / 幂等删）、`sidecar/adapters/socket_binding.py`（偏好端口被占则回退 0）、`sidecar/api/auth.py`（`X-Deskpet-Token` 中间件 → 401 `DP-SYS-401`）、`sidecar/contracts/runtime.py`；测试 `tests/test_runtime_boot.py`（11 个）+ `tests/test_sidecar_launch.py`（1 个端到端：真 socket + 真 HTTP + 优雅退出即删），pytest **29 passed**，ruff / format / mypy 全过。**踩坑留档**：① `HTTPException(detail=ErrorEnvelope)` 经 FastAPI 会再包一层，契约测试要读 `body["detail"]["code"]`；401 走中间件直接返回，读顶层；② 开发模式下 `.venv\Scripts\python.exe` 会再起一个子进程，**runtime.json 里的 pid 不是 Popen 拿到的 pid**（实测 launcher 被杀时子进程一起结束）；③ 硬杀 sidecar 时 `finally` 不执行 → runtime.json 残留，主进程必须按陈旧文件处理；④ 文件落地必须走「仓库同布局镜像目录 + robocopy `/E`」（退出码 0/1/3 都算成功）——按文件名逐个拼路径那次把 sidecar 层拷到了仓库根，`api/` 包 shadow 掉 `sidecar/api`（报 `No module named 'api.health'`）；⑤ 冒烟脚本不要把长跑子进程的输出接管道再 `tail`（管道被持有 → 命令挂起撞 deadline），用后台任务 + 重定向到文件。
- **v0.4（2026-10-14）**：**T0.3 完成**（契约先行：sidecar API 路由表 + 模型 + IPC 白名单 + 契约测试 16 项全绿），契约冻结进需求 §6.10；T0.5 因此缩水为「uvicorn 起服务 + runtime.json 端口握手 + /health 实测」（骨架与 /health 已在 T0.3 落地，估时 2h → 1h）。**踩坑留档**：① FastAPI 0.143 起 `include_router` 会包一层 `_IncludedRouter`，`app.routes` 不再是扁平路由列表，契约测试改从 `app.openapi()['paths']` 取实际挂载（跨版本更稳）；② 桩函数带 `-> NoReturn` 时必须显式 `response_model=None`，否则 FastAPI 报 `Invalid args for response field`。
- **v0.3（2026-10-13）**：T0.1 / T0.2 完成（提交 `681916f`、`0bc0ea9`），工具链全绿；P1 / P2 标为已解决；§2.1 新增进度记录。**pnpm 12 的新规矩（踩坑留档）**：依赖的安装脚本默认被忽略，必须显式批准；旧写法 `pnpm.onlyBuiltDependencies`（写在 package.json）已不再被读取，正确写法是 `pnpm-workspace.yaml` 里的 `allowBuilds: { esbuild: true }`，否则 `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 失败。electron 与 electron-builder 尚未安装（T0.6 / T0.9 再加）。