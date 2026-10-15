# deskpet

常驻 Windows 桌面的 AI 伴侣：有形象、有声音、语音可随时打断、记得住你、会主动找你、看得到屏幕、人格稳定不谄媚；**不操作你的电脑**；可打包为 exe 分发。

- 状态：**需求 v1.39 与代码规范 v1.7 均已冻结；M0 已完成（T0.1–T0.13 全部收尾，含复盘），M1 已开工——P6 已定案并收尾（IndexTTS 常驻 HTTP 适配器 `tools/indextts_adapter`，契约见需求 §6.12），T1.1 契约扩展已完成，T1.2 最小可换角色包已完成（示例角色包 `characters/amber/`），T1.3 LLM 客户端已完成（`/chat/stream` 成为第一条真实现的路由：§6.2 新增 `e` 错误事件与解析降级规则；真实端点端到端冒烟通过），T1.4 ASR 接入已完成（faster-whisper `small` + int8 + CPU，`/asr` 成为第二条真实现的路由：15s 超时、空 / 幻觉文本不喂 LLM；真实音频冒烟通过），T1.5 TTS 适配器接入已完成（`/tts` 与 `/tts/cancel` 成为第三、四条真实现的路由：调 `tools/indextts_adapter`，单句 ≤40 字、单句超时 30s、引擎侧 `{code,message,hint}` 原样透传），**T1.6 全双工状态机（sidecar 侧）已完成**（`sidecar/core/voice_state.py` 单一状态入口：活动集合推导五态、取消抬 `generation`、三条路由用 `voice.activity` 包住、`/health` 新增 `voice` 字段），**T1.6b 主进程编排已完成**（`app/main/sidecar-client.ts` 的 HTTP / SSE 客户端 + `chat-orchestrator.ts` + `character-voice.ts` + 六条 IPC + `deskpet:tts:audio` 音频回传；**不注册全局热键**，打断走 `deskpet:chat:cancel`），**T1.9 usage.db 记录层已完成**（`sidecar/core/usage.py` + `sidecar/adapters/usage_sqlite.py` + `sidecar/services/usage_service.py`：只记不注入、先写库后结算增量、暂停记录开关、与 `memories.db` 分离），**T1.10 环境事件契约已完成**（`sidecar/core/env_events.py`：十种事件类型 + `fact` / `user_hint` 分离；ASR → `asr.empty`、TTS → `tts.failed`、网络 → `net.down` 各接一处，恢复即撤销；记忆与屏幕的接点随各自模块），**T1.11 反谄媚人格已完成**（`sidecar/core/prompt.py` 默认反附和模板 + `build_variation()` 注入【此刻的状态】（时段 / 情绪 / 关系温度）；人工用例 `docs/PERSONA_CASES.md` + 探针 `scripts/persona_probe.py`；pre-commit 的 ruff 覆盖面扩到 scripts/），**T1.12a 界面形态 + 聊天条（文字版）已完成**（桌宠主窗：无边框 + 透明 + 不进任务栏、立绘即拖动把手、立绘下方聊天条 + 气泡 + 健康小圆点、透明区穿透、位置与缩放记 `data/ui.json`、设置窗 720×520、§6.10 补登记 6 条界面 channel；CDP 实测无标题栏与菜单、kill sidecar 小圆点变红而形态不变），**T1.13a 文字闭环验收已完成**（`scripts/smoke_text.mjs` + `smoke_text.ps1` 拉起真实 Electron 走 CDP：3 轮对话、第 2 轮中途打断；首句 5.6–8.8 s、打断后主进程释放 2.54 s；修掉两个渲染层真 bug——解锁信号改看语音状态、界面就绪标记 `data-ready`）。**T1.8「推理资源闸门 / GPU 锁」已取消**（项目不做任何 GPU 功能，一切模型只负责调用，见需求 D18）；此后按「**文字优先**」推进（T1.11 ✅ → T1.12a ✅ → T1.13a ✅ → 语音 T1.7 → T1.12b → T1.13b，顺序依据见 [docs/PLAN.md](docs/PLAN.md)）**（任务拆解与复盘见 [docs/PLAN.md](docs/PLAN.md)）** **2026-10-15 新决策**：模型供给层改**本地 / 云端双轨**（本地 provider 后置）、语音输入键定**「按住说话」**、**文本阶段必须包含记忆系统**、**角色包导入 / 导出版优先级下调**、**示例角色包先不配音**；**文本功能验收通过后再打首个正式 tag**（排期见 [docs/PLAN.md](docs/PLAN.md) §7.8）。**2026-10-15 追加 v1.35**：**不假设部署环境**（不再列复用清单与显卡预算）、**情感改走 IndexTTS 自带的文本输入**（`emo_text` + `emo_alpha`，本项目不拼 8 维向量）。**T1.14a 模型供给层（sidecar + 契约 + TS 侧）已完成**：`DESKPET_{LLM,ASR,TTS}_PROVIDER` + 端点回退、`usage.db` 会话行三列 provider（旧库自动补列）、`/health` 新增 `providers`、云端 ASR / TTS 明确报未实现而不静默降级。**T1.14b 设置窗「模型供给」+「测试连接」已完成**：三面各一张卡片（来源云端 / 本地 + 端点 / 模型 / 密钥 + 保存 / 测试），配置只写 `.env`（原地改值、保住注释与键顺序）、**密钥只写不回显**（视图只有「已配 / 未配」两个布尔量），新增鉴权路由 `POST /providers/test`（结论契约里没有 `api_key`）与三条 IPC channel；pytest 326 / vitest 13 文件 104 例 / pre-commit 7 钩子全绿。**T1.14 全部完成**。**T2.1a 记忆系统底座已完成（2026-10-16）**：`sidecar/core/memory.py` + `sidecar/adapters/memory_sqlite.py`（SQLCipher 整库加密 + FTS5）+ `adapters/memory_key.py` / `dpapi.py`（主密钥经 DPAPI 托管，解不开报 `DP-MEM-001`、不退化明文）+ `services/memory_service.py`（对话链路读写失败只降级：读失败=这轮没有记忆、写失败只记日志并上报 `mem.readonly` / `mem.key_invalid`；管理端点抛 `DP-MEM-001` / `002` / `003`）+ 四层读取装配与 prompt 注入（`build_messages(..., recall=...)`，L0 片段与用户原话用 `<untrusted_input>` 包住）+ 五条 `/memory/*` 路由（新增 `GET /memory/list` 与 `POST /memory/clear`，其余摘掉 501 桩）+ 12 个 `DESKPET_MEMORY_*` 配置键；pytest **400** / vitest **13 文件 104 例** / ruff / mypy **60 + 9** / pre-commit **7 钩子**全绿。**T2.1b 已完成（2026-10-16）**：`sidecar/services/memory_summary_service.py` 的 `MemorySummarizer` 生成阶梯摘要（L1 由未覆盖消息按条数 / token 阈值触发、生成后 `mark_covered`；L2 / L3 由下层摘要按 `summaries.source_ids` 聚合、不重复聚合；后台 `schedule()` 跑、失败只记日志不影响本轮）+ 三个新阈值键（`SUMMARY_BATCH_MESSAGES` / `L1_AGGREGATE_SUMMARIES` / `L2_AGGREGATE_SUMMARIES`）+ 设置窗「记忆」面板（按角色列出种类 / 层级 / 重要度 / 记于 / 用过几次、单条删除、清空二次确认）+ 三条记忆 IPC channel（`deskpet:memory:list` / `memory:delete` / `memory:clear`）+ F3 四条验收脚本 `scripts/memory_check.py`（重开记得上次话题 / 100 轮后仍记得第 10 轮 / 装配 <80ms 且来源可追溯 / 单条删除即时生效；offline 替身模型 **4/4 通过**，装配 max **0.8ms**）；pytest **420** / vitest **13 文件 108 例** / ruff / mypy **61 + 9** / pre-commit **7 钩子**全绿。**T2.1 全部完成，下一步 T2.2 文本闭环复验与用户验收。**（2026-10-16 T2.2 自动侧已完成：`scripts/smoke_text.ps1 -Turns 3` 3 轮通过——首句 3.9–4.9 s、打断后主进程释放 2.3 s；`scripts/memory_check.py` offline / `--live` 均 **4/4**，live 整轮 45.7 s、装配 max 1.3–1.5 ms；补测：同一数据目录连跑两次应用后，第二次仍记得上一会话（首句回「这话你刚才说过一遍了」），真实端点会按协议吐 m 事件并落成 L0 事实——原文与摘要样本见 [docs/MEASURED.md](docs/MEASURED.md) §8 / §8.1；三条人工验收步骤见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)，**等验收通过后打首个正式 tag**）
- 开发机（**只是这台机器的现状，不代表部署环境**）：Windows 11 + WSL2(mirrored) / Ryzen 9 7945HX
- 开发约定：**WSL 只用来编辑代码，依赖安装与运行一律在 Windows 侧**

## 文档

所有文档都放在 **docs/**，仓库根只留本 README。

| 文档 | 内容 |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 需求说明书 v1.39（**唯一正本**：决策、实测约束、功能需求、数据契约、验收标准、里程碑） |
| [docs/CODE_STYLE.md](docs/CODE_STYLE.md) | **代码规范 v1.7（已冻结）**：模块化分层 + 注释规则 + 工具链 + 日志行 schema 与脱敏 + 错误码域表 + 提交规范 |
| [docs/PLAN.md](docs/PLAN.md) | 实施计划 v0.39（**M0 复盘 + M1 拆解**：M0 的 13 项任务与判据对照、估时 vs 实际、教训清单；M1 的前置 P5–P9、任务 T1.1–T1.13、顺序、风险 R7–R11） |
| [docs/MEASURED.md](docs/MEASURED.md) | **实测数据 v0.7**：体积、冷启动、文字链路端到端、记忆系统 F3 四条判据（offline / live，含 §8.1 应用层重启召回与真实 m 事件取证）、「双击到主界面可见」等可复跑数字（脚本 `scripts/smoke_release.ps1` / `scripts/smoke_text.ps1` / `scripts/memory_check.py`） |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | **文本阶段验收说明（T2.2）**：交付清单、怎么跑起来、三条人工验收步骤（文字对话与打断 / 记忆 / 人格）、自动脚本数字与验收记录表 |
| [docs/PROJECT_DOC.md](docs/PROJECT_DOC.md) | 项目文档（待写） |

## 已锁定的关键决策

| # | 决策 | 选择 |
|---|---|---|
| D1 | 桌面壳 | Electron + Python sidecar |
| D2 | LLM | 云端为主（OpenAI 兼容，base_url / key / model 全可配置） |
| D3 | TTS | IndexTTS-2.5，情感走引擎自带的文本输入（`emo_text` + `emo_alpha`），本项目不拼向量 |
| D4 | ASR | faster-whisper（本地，small + int8 + CPU） |
| D5 | 屏幕识别 | 先手动热键截屏，后加自主与常驻轮询；OCR 允许上云 |
| D6 | 项目位置 | D:\Agent_Projects\deskpet |
| D7 | 形象 | 先 PNG 占位，按可替换 Stage 接口实现 |
| D8 | 记忆加密 | SQLCipher 整库加密 + Windows DPAPI 托管密钥 |
| D9 | 输入方式 | 聊天框打字 + 聊天框内语音输入键（默认 Ctrl+Alt+Space，可自定义）；默认非常开 VAD |
| D10 | 形象双轨 | Live2D 与 PNG 同时兼容（统一 StageAdapter） |
| D11 | 主动消息 | 全屏 / 免打扰静默 + 回应判定，连续未回应则降频直至静默 |
| D12 | 角色包边界 | 角色包只含人格 / 形象 / 声音 / 词表 / 素材，**不含记忆** |
| D13 | 能力边界 | **不做生图；不提供任何操作电脑的能力** |
| D14 | 引擎边界 | **只调用 IndexTTS，不安装 / 修复 / 重启 / 调参**（引擎问题由用户自行处理） |
| D15 | 状态感知边界 | 角色可拟人化表达自身状态（F9），但只用**真实事件**、**不替代技术提示**、**不给修复指导** |
| D16 | 使用感知边界 | 只记用户对本应用的操作（会话 / 时长 / 角色切换），**不记其他程序、不记聊天文本、不上报**；跨角色可见性默认**「仅名字」**（别人只给名字，不给内容与统计，可关闭），可暂停可清空（F10） |

## 里程碑

| 里程碑 | 内容 |
|---|---|
| M0 | 骨架 + 打包打通（Electron 空壳 + sidecar 心跳 + git + exe） |
| M1 | 语音全双工闭环（ASR → LLM → TTS → 打断 + 反应音库）+ usage.db 记录层（F10）。**执行顺序为「文字优先」**：T1.9 ✅ → T1.10 ✅ → T1.11 ✅ → T1.12a ✅ → T1.13a ✅，语音（T1.7 / T1.12b / T1.13b）在其后；原 T1.8「推理资源闸门 / GPU 锁」已取消（D18） |
| M2 | 记忆系统（SQLite + 四层摘要阶梯 + 角色包导入导出） |
| M3 | 形象与表现（Live2D 接入、口型 / 动作 / 情绪、静态 CG 事件插图） |
| M4 | 屏幕感知与主动性 + 自我状态感知（F9）+ 使用感知的注入与统计页（F10） |
| M5 | 发布与分发（按需）：GitHub 仓库 + Actions CI + Release 附件 |

## 开发环境准备（Windows 侧）

依赖安装与运行一律在 Windows 侧；WSL 只用来编辑代码（D 盘在 WSL 是只读挂载）。

1. Node 24 + pnpm：`npm i -g pnpm@12`（`corepack enable` 要写 `C:\Program Files\nodejs`，实测报 EPERM，需管理员）
2. Python 3.13（项目**独立** venv）：`winget install -e --id Python.Python.3.13`，然后 `py -3.13 -m venv .venv`
3. sidecar 依赖：`.venv\Scripts\python -m pip install -e "sidecar[dev]"`（FastAPI + uvicorn + ruff / mypy / pytest / pre-commit）
4. 前端依赖：`pnpm install`（pnpm 12 默认忽略依赖的构建脚本；本仓库已在 `pnpm-workspace.yaml` 用 `allowBuilds` 批准 esbuild，无需额外参数）
5. 提交前守门（装一次即可）：`.venv\Scripts\python -m pre_commit install`；想手动全量跑一遍用 `.venv\Scripts\python -m pre_commit run --all-files`。钩子见 `.pre-commit-config.yaml`（ruff / mypy / eslint / prettier / tsc + `.ps1` 必须有 UTF-8 BOM），全部走本地 `.venv` 与 `node_modules`，**不联网**
6. 自检（都在仓库根执行）：`.venv\Scripts\python -m pytest`、`pnpm lint`、`pnpm typecheck`、`pnpm test`
7. 单独起 sidecar（可选，Electron 未就绪时排障）：`.venv\Scripts\python sidecar\main.py`，监听端口与 token 见 `data\runtime.json`（`Ctrl+C` 退出时会自动删掉该文件）
8. 冒烟自检（无人值守）：设 `DESKPET_SMOKE_QUIT_MS=8000` 再启动，应用到点会走与托盘「退出」相同的收尾路径（停 sidecar、删 `data\runtime.json`），日志里能看到 `app.smoke_quit`
9. 打包 sidecar（可选）：`powershell -ExecutionPolicy Bypass -File scripts\build_sidecar.ps1 -Clean` → 产物 `dist\sidecar\sidecar.exe`（**onedir：整目录一起分发，不能只拷 exe**）。单独运行它会在 exe 旁生成 `data\`（含 `runtime.json` 与 `logs\deskpet.log`），端口可用 `DESKPET_SIDECAR_PORT` 指定
10. 排障看日志：`data\logs\deskpet.log`（单行 JSON、UTF-8；超过 20 MB 滚动，历史保留 7 天；错误码形如 `DP-TTS-001` 见 CODE_STYLE §6.4）
11. 配置云端模型（**T1.3 起必需**）：把仓库根的 `.env.example` 复制成 `.env`（已被 gitignore），填 `DESKPET_LLM_BASE_URL` / `DESKPET_LLM_API_KEY` / `DESKPET_LLM_MODEL`（可选 `_FALLBACK_BASE_URL` / `_FALLBACK_MODEL`）。开发模式下主进程会解析仓库根的 `.env` 并注入 sidecar 子进程；打包后读 userData 下的 `.env`，也可用 `DESKPET_ENV_FILE` 指到别处。**没配也不崩**：`/chat/stream` 会先回一条 `e` 事件（`DP-LLM-004`「还没有配置模型服务…」）；该端点的模型可能先吐 `reasoning_content`，客户端只取 `content`（见需求 §6.2）
12. ASR 模型（**T1.4 起**，首次自动下载）：默认 `small` + int8 + CPU，权重落 `data\models\asr`（约 464 MB，已 gitignore），**不用预装**——第一次识别会自动下载（约 200 s）；国内网络请设 `DESKPET_ASR_HF_ENDPOINT=https://hf-mirror.com`（适配器会自动加 `HF_HUB_DISABLE_XET=1`，否则镜像下 401）。想先下好可以不启动应用，直接跑 `.venv\Scripts\python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root=r'data\models\asr')"`；ASR 的实测速度见 docs/MEASURED.md §5
13. 起 **IndexTTS 适配器**（语音功能需要；**必须用 IndexTTS 自己的解释器**，不要用项目 `.venv`）：在仓库根运行 `D:\IndexTTS\.venv\Scripts\python.exe -m tools.indextts_adapter --port 8742`，然后 `GET http://127.0.0.1:8742/health` 应返回 `ready`（首次调用才加载模型，要十几秒到上百秒）。契约见需求 §6.12；本项目不安装 / 不修复引擎（D14）。**T1.5 起 sidecar 会调它**：默认 `http://127.0.0.1:8742`，可用 `DESKPET_TTS_URL` / `DESKPET_TTS_TOKEN` / `DESKPET_TTS_TIMEOUT_S` 覆盖；引擎没起时 `/tts` 明确回 `DP-TTS-503` 并转纯文字，不会假装在说话

## 打包发布（Windows 侧）

一键产出（esbuild → PyInstaller sidecar → electron-builder）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1
```

| 产物（`release\`） | 形态 |
|---|---|
| `deskpet-<版本>-x64.exe` | NSIS 安装包（非一键、可选安装目录、建桌面与开始菜单快捷方式；卸载不删用户数据） |
| `deskpet-<版本>-x64.zip` | 免安装包（解压即用） |

- 两者内部都把 sidecar onedir 放在 `resources\sidecar\`（asar 之外）；asar 里只有 `dist/` 与 package.json。
- 用户数据（记忆 / 日志 / `runtime.json`）统一在 `%APPDATA%\deskpet\data\`，与安装目录无关。
- 首次打包要从 GitHub 拉 Electron / NSIS / winCodeSign / 7zip 二进制，国内先设：
  `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`、
  `$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"`。
- 无人值守冒烟：设 `DESKPET_SMOKE_QUIT_MS=8000` 再启动打包产物，到点自动走正常退出（停 sidecar、删 `runtime.json`），日志见 `%APPDATA%\deskpet\data\logs\`。
- 图标待补：现在用 Electron 默认图标；放 `assets/packaging/icon.ico` 即会被 electron-builder 采用（`directories.buildResources`）。
- 实测冷启动与体积（可复跑，约 90 秒）：`powershell -ExecutionPolicy Bypass -File scripts\smoke_release.ps1`；当前数字见 [docs/MEASURED.md](docs/MEASURED.md)（本机：主界面可见 705 ms、后台就绪 960 ms、安装包 133.4 MB、解压 429.5 MB）。

## Git 工作流（本地）

> D 盘在 WSL 是只读挂载，**git 命令一律在 Windows 侧执行**（WSL 只用来编辑代码）。GitHub 仓库与 Actions CI 推迟到 M5（按需），M0 起只做本地 git。

### 分支

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定线，任何时候都能打包 | 只接受 `dev` 或紧急 `fix/*` 的合并；不直接在 main 上开发 |
| `dev` | 集成分支 | 功能先合到这里；小改动可直接提交 |
| `feat/*` `fix/*` `docs/*` `chore/*` | 短生命周期分支 | 一次一件事，合完即删；单次 diff 建议 < 400 行 |

每次 `git commit` 会自动跑 `.pre-commit-config.yaml` 里的 7 个钩子（ruff check / ruff format / mypy / eslint / prettier / tsc / `.ps1` BOM）；只想跳过时用 `git commit --no-verify`，但别把跳过当默认。

合并用 `--no-ff` 保留分支痕迹（例：`git merge --no-ff feat/memory-l1`），便于日后回溯「这坨功能是一起进来的」。

### 提交信息（Conventional Commits）

格式 `type(scope): 摘要`——摘要用中文、动词开头、说清做了什么；一次提交只做一件事。

- type：`feat` / `fix` / `refactor` / `perf` / `test` / `docs` / `chore` / `build` / `ci`
- scope：`app` / `sidecar` / `api` / `core` / `memory` / `tts` / `asr` / `llm` / `stage` / `pack` / `screen` / `build` / `docs`
- 例：`feat(memory): 实现 L0→L1 会话摘要`、`fix(tts): 打断后残留尾音`
- 需要解释时在正文补「为什么改 / 怎么验证 / 有什么风险」。

### 版本与 tag（SemVer）

- 软件版本从 `0.1.0` 起，**唯一来源是 `package.json` 的 `version`**（打包产物名 `deskpet-<version>-x64.exe` 取自它）。
- 需求文档版本（`v1.x`）与软件版本分开记；角色包的 `pack_version` 也独立。
- tag 一律用带注释的：`git tag -a v0.2.0 -m "M1 语音闭环"`；格式 `v<major>.<minor>.<patch>`，预发布加后缀（如 `v0.1.0-m0.1`）。
- 递增规则：需要用户迁移 / 破坏兼容 → major；新增功能 → minor；修 bug 与内部重构 → patch。
- 里程碑完成打正式 tag（M0 完成 → `v0.1.0`），里程碑中间态打预发布 tag。

## 开工前待定项

1. 角色包编辑器的形态（M3 阶段再定）
