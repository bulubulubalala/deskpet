# deskpet · 实施计划（M0）

> 配套：`docs/REQUIREMENTS.md` v1.15（需求唯一正本）、`docs/CODE_STYLE.md` v1.2（代码规范，已冻结）
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
| T0.4 | 日志与错误码骨架 | 没有结构化日志就没法定位；错误码域表已冻结（CODE_STYLE §6.1） | DP-域-三位 常量、JSON 日志、7 天 / 20MB 滚动、UTF-8 强制 | 故意抛异常 → 日志含 code/domain/message/trace，中文不乱码 | T0.2 | 1h |
| T0.5 | sidecar 起服务 + 端口握手 | 大脑地基；心跳是 M0 唯一的「活着」证据。**四层骨架与 /health 已在 T0.3 落地**，本项只剩「真的用 uvicorn 起起来」 | uvicorn 启动 + **runtime.json 端口握手**（§6.10）+ 端口占用自动换端口；/health 返回 status/uptime/modules/gpu | curl 127.0.0.1:<port>/health 200 且 ≤10ms，不加载任何模型；runtime.json 在监听成功后才出现、退出即删 | T0.3 | 1h |
| T0.6 | Electron 壳 + 心跳链路 | §7.2 的诚实状态显示；壳与大脑首次连通 | main 每 2s 轮询 /health，3 次失败判离线并自动重启（≤3 次）；preload 白名单；renderer：占位 PNG + 心跳灯 + 模块状态 + 版本号；托盘图标 | kill sidecar → 3s 内灯红，数秒内自动恢复绿 | T0.5 | 3h |
| T0.7 | 生命周期：单实例 / 端口 / 退出清理 | 常驻桌面程序最容易出的三类脏问题 | requestSingleInstanceLock；端口被占时自动换端口并回传；退出时结束 sidecar（taskkill 兜底） | 双开只出一个窗口；端口被占不崩；退出后任务管理器无残留 | T0.6 | 1h |
| T0.8 | sidecar 打包（PyInstaller onedir） | 打包是 M0 判据，也是「能不能分发」的分水岭 | PyInstaller --onedir + 提交 sidecar.spec；测试用 fake 引擎 | dist/sidecar/sidecar.exe 单独运行，/health 200 | T0.5 | 2h |
| T0.9 | electron-builder NSIS + 免安装 zip | 「干净 Windows 装完能开」是 §8.2 的 M0 判据 | deskpet-Setup-x.y.z.exe、deskpet-portable.zip；sidecar onedir 放 resources/sidecar/（asar 之外） | 干净系统（或全新用户）安装后双击能开，心跳绿 | T0.8 T0.6 | 2h |
| T0.10 | 本地 git 工作流（**不含 GitHub**） | 先让版本管理可用；发布按需再做（M5） | 分支约定 main/dev、提交信息走约定式、SemVer 与 tag 规则写进 README | `git log --oneline` 符合约定式；能正常 tag / branch / merge | T0.1 | 0.5h |
| T0.11 | pre-commit | 规范要落在提交那一刻，而不是靠自觉 | .pre-commit-config.yaml：ruff check / format、mypy、eslint、prettier、tsc --noEmit | 故意提交格式错误被拦下 | T0.2 | 0.5h |
| T0.12 | 冷启动与体积实测 | §3 的实测数据是后续性能决策的基线 | 双击到主界面可见的时间、安装包体积、解压体积、sidecar 冷启动时间 → docs/MEASURED.md | 数字入档，并与 §3 的估算对照 | T0.9 | 0.5h |
| T0.13 | M0 复盘 + 拆 M1 | 走完一轮才知道哪些估时离谱；M1 要靠真实数据拆 | 复盘记录 + 本文件新增 M1 章节 | 对照 §11 核对表第 4 行通过 | 全部 | 0.5h |

估时合计约 **16.5 小时**（一人）。

### 2.1 进度记录（滚动）

| 日期 | 任务 | 结果 |
|---|---|---|
| 2026-10-14 | T0.5 sidecar 起服务 + 端口握手 | 完成：真实入口 `python sidecar/main.py` 起 uvicorn，`data/runtime.json` 在监听成功后落盘（pid/host/port/token/started_at/version），端口被占自动回退随机端口；`GET /health` 200（稳态 1.06ms、首次 141ms）、无 token 401（`DP-SYS-401`）、`POST /tts` 501（`DP-SYS-501`）、优雅退出即删握手文件；token 走 `X-Deskpet-Token` 头 + `secrets.compare_digest`。pytest **29 passed**（`test_runtime_boot.py` 11 + `test_sidecar_launch.py` 1 端到端），ruff / format / mypy 全过 |
| 2026-10-13 | T0.1 仓库与目录骨架 | 完成：`git init -b main`，首个提交 `681916f`（18 个文件），运行时目录 `data/` 整体 gitignore，工作区干净 |
| 2026-10-14 | T0.3 契约先行：sidecar API + IPC 白名单 | 完成：**24 个文件**——`sidecar/contracts/`（routes 路由表 11 条 / health / errors / events / api_models）+ `api`（health 真实现 + 10 个 501 桩 + router）+ `core`（ModuleRegistry、Clock）+ `services`（HealthService）+ `adapters`（SystemClock）+ `app.py` 组合根；导出的 `sidecar/contracts/openapi.json`（11 paths / 8 schemas）与 `llm_events.schema.json` 快照；`app/main/ipc.ts` 的 4 条 channel 常量与 HealthSnapshot / AppInfo 类型；契约测试 `tests/test_api_contract.py`（6）、`tests/test_event_contract.py`（5）、`tests/ipc-contract.test.ts`（5）。验证：pytest **16 passed**、ruff check / format / mypy 全过、`pnpm lint` / `typecheck` / `format:check` / `test`（7 passed）全 exit 0。**契约已写进需求 §6.10**（IPC 白名单 + runtime.json），§13 第 16 条 |
| 2026-10-14 | T0.2 依赖与工具链 | 完成：Windows 侧 Python 3.13.15 + 项目独立 `.venv`、pnpm 12.10.1；sidecar 五层包骨架 + `pyproject.toml`（Ruff 100 列 / mypy strict / pytest）、前端 ESLint 9 + Prettier + tsconfig strict + Vitest；提交 `0bc0ea9`。验证：pytest 6 passed、`ruff check` / `ruff format --check` / `mypy` 全过、`pnpm lint` / `typecheck` / `format:check` / `test` 全 exit 0 |

## 3. 顺序、依赖与并行

```
关键路径：T0.1 → T0.2 → T0.3 → T0.5 → T0.6 → T0.7 → T0.8 → T0.9 → T0.10 → T0.12 → T0.13
            （T0.8 只依赖 T0.5，可与 T0.6/T0.7 并行）
可随时插入：T0.4 日志骨架、T0.11 pre-commit
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

- **v0.1（2026-10-13）**：M0 任务拆解初稿（13 项任务 + 4 项前置 + 6 条风险）。
- **v0.2（2026-10-13）**：P4 目录名已确认（deskpet）；Python 环境定为**项目独立 venv**（3.13 基础）；T0.10 由「GitHub Actions + Release」改为「本地 git 工作流」，GitHub / Actions / Release 推迟到 M5 按需（需求 v1.13 同步）。
- **v0.5（2026-10-14）**：**T0.5 完成**：新增 `sidecar/config.py`（Settings + load_settings）、`sidecar/main.py`（launch / serve / run：绑定端口 → 生成 token → 写 runtime.json → uvicorn 起服务，finally 删文件）、`sidecar/adapters/runtime_file.py`（原子写 / 读 / 幂等删）、`sidecar/adapters/socket_binding.py`（偏好端口被占则回退 0）、`sidecar/api/auth.py`（`X-Deskpet-Token` 中间件 → 401 `DP-SYS-401`）、`sidecar/contracts/runtime.py`；测试 `tests/test_runtime_boot.py`（11 个）+ `tests/test_sidecar_launch.py`（1 个端到端：真 socket + 真 HTTP + 优雅退出即删），pytest **29 passed**，ruff / format / mypy 全过。**踩坑留档**：① `HTTPException(detail=ErrorEnvelope)` 经 FastAPI 会再包一层，契约测试要读 `body["detail"]["code"]`；401 走中间件直接返回，读顶层；② 开发模式下 `.venv\Scripts\python.exe` 会再起一个子进程，**runtime.json 里的 pid 不是 Popen 拿到的 pid**（实测 launcher 被杀时子进程一起结束）；③ 硬杀 sidecar 时 `finally` 不执行 → runtime.json 残留，主进程必须按陈旧文件处理；④ 文件落地必须走「仓库同布局镜像目录 + robocopy `/E`」（退出码 0/1/3 都算成功）——按文件名逐个拼路径那次把 sidecar 层拷到了仓库根，`api/` 包 shadow 掉 `sidecar/api`（报 `No module named 'api.health'`）；⑤ 冒烟脚本不要把长跑子进程的输出接管道再 `tail`（管道被持有 → 命令挂起撞 deadline），用后台任务 + 重定向到文件。
- **v0.4（2026-10-14）**：**T0.3 完成**（契约先行：sidecar API 路由表 + 模型 + IPC 白名单 + 契约测试 16 项全绿），契约冻结进需求 §6.10；T0.5 因此缩水为「uvicorn 起服务 + runtime.json 端口握手 + /health 实测」（骨架与 /health 已在 T0.3 落地，估时 2h → 1h）。**踩坑留档**：① FastAPI 0.143 起 `include_router` 会包一层 `_IncludedRouter`，`app.routes` 不再是扁平路由列表，契约测试改从 `app.openapi()['paths']` 取实际挂载（跨版本更稳）；② 桩函数带 `-> NoReturn` 时必须显式 `response_model=None`，否则 FastAPI 报 `Invalid args for response field`。
- **v0.3（2026-10-13）**：T0.1 / T0.2 完成（提交 `681916f`、`0bc0ea9`），工具链全绿；P1 / P2 标为已解决；§2.1 新增进度记录。**pnpm 12 的新规矩（踩坑留档）**：依赖的安装脚本默认被忽略，必须显式批准；旧写法 `pnpm.onlyBuiltDependencies`（写在 package.json）已不再被读取，正确写法是 `pnpm-workspace.yaml` 里的 `allowBuilds: { esbuild: true }`，否则 `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 失败。electron 与 electron-builder 尚未安装（T0.6 / T0.9 再加）。