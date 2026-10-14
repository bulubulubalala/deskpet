# deskpet

常驻 Windows 桌面的 AI 伴侣：有形象、有声音、语音可随时打断、记得住你、会主动找你、看得到屏幕、人格稳定不谄媚；**不操作你的电脑**；可打包为 exe 分发。

- 状态：**需求 v1.16 与代码规范 v1.3 均已冻结，M0 进行中（T0.1 仓库骨架、T0.2 工具链、T0.3 契约先行、T0.4 日志与错误码、T0.5 sidecar 起服务与端口握手、T0.6 Electron 壳与心跳链路、T0.7 单实例与退出清理、T0.8 sidecar 打包、T0.9 安装包与免安装 zip、T0.10 本地 git 工作流已完成；下一步 T0.11 pre-commit）**（任务拆解见 [docs/PLAN.md](docs/PLAN.md)）
- 开发机：Windows 11 + WSL2(mirrored) / RTX 4060 Laptop 8GB / Ryzen 9 7945HX
- 开发约定：**WSL 只用来编辑代码，依赖安装与运行一律在 Windows 侧**

## 文档

所有文档都放在 **docs/**，仓库根只留本 README。

| 文档 | 内容 |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 需求说明书 v1.16（**唯一正本**：决策、实测约束、功能需求、数据契约、验收标准、里程碑） |
| [docs/CODE_STYLE.md](docs/CODE_STYLE.md) | **代码规范 v1.3（已冻结）**：模块化分层 + 注释规则 + 工具链 + 日志行 schema 与脱敏 + 错误码域表 + 提交规范 |
| [docs/PLAN.md](docs/PLAN.md) | 实施计划 v0.11（**M0 任务拆解**：13 项任务 / 前置 4 项 / 顺序与并行 / 验收方式） |
| [docs/PROJECT_DOC.md](docs/PROJECT_DOC.md) | 项目文档（待写） |

## 已锁定的关键决策

| # | 决策 | 选择 |
|---|---|---|
| D1 | 桌面壳 | Electron + Python sidecar |
| D2 | LLM | 云端为主（OpenAI 兼容，base_url / key / model 全可配置） |
| D3 | TTS | IndexTTS-2.5，情感由 LLM 给标签转 8 维向量，不用 QwenEmotion |
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
| M1 | 语音全双工闭环（ASR → LLM → TTS → 打断 + 反应音库 + 推理资源闸门）+ usage.db 记录层（F10） |
| M2 | 记忆系统（SQLite + 四层摘要阶梯 + 角色包导入导出） |
| M3 | 形象与表现（Live2D 接入、口型 / 动作 / 情绪、静态 CG 事件插图） |
| M4 | 屏幕感知与主动性 + 自我状态感知（F9）+ 使用感知的注入与统计页（F10） |
| M5 | 发布与分发（按需）：GitHub 仓库 + Actions CI + Release 附件 |

## 开发环境准备（Windows 侧）

依赖安装与运行一律在 Windows 侧；WSL 只用来编辑代码（D 盘在 WSL 是只读挂载）。

1. Node 24 + pnpm：`npm i -g pnpm@12`（`corepack enable` 要写 `C:\Program Files\nodejs`，实测报 EPERM，需管理员）
2. Python 3.13（项目**独立** venv）：`winget install -e --id Python.Python.3.13`，然后 `py -3.13 -m venv .venv`
3. sidecar 依赖：`.venv\Scripts\python -m pip install -e "sidecar[dev]"`（FastAPI + uvicorn + ruff / mypy / pytest）
4. 前端依赖：`pnpm install`（pnpm 12 默认忽略依赖的构建脚本；本仓库已在 `pnpm-workspace.yaml` 用 `allowBuilds` 批准 esbuild，无需额外参数）
5. 自检（都在仓库根执行）：`.venv\Scripts\python -m pytest`、`pnpm lint`、`pnpm typecheck`、`pnpm test`
6. 单独起 sidecar（可选，Electron 未就绪时排障）：`.venv\Scripts\python sidecar\main.py`，监听端口与 token 见 `data\runtime.json`（`Ctrl+C` 退出时会自动删掉该文件）
7. 冒烟自检（无人值守）：设 `DESKPET_SMOKE_QUIT_MS=8000` 再启动，应用到点会走与托盘「退出」相同的收尾路径（停 sidecar、删 `data\runtime.json`），日志里能看到 `app.smoke_quit`
8. 打包 sidecar（可选）：`powershell -ExecutionPolicy Bypass -File scripts\build_sidecar.ps1 -Clean` → 产物 `dist\sidecar\sidecar.exe`（**onedir：整目录一起分发，不能只拷 exe**）。单独运行它会在 exe 旁生成 `data\`（含 `runtime.json` 与 `logs\deskpet.log`），端口可用 `DESKPET_SIDECAR_PORT` 指定
9. 排障看日志：`data\logs\deskpet.log`（单行 JSON、UTF-8；超过 20 MB 滚动，历史保留 7 天；错误码形如 `DP-TTS-001` 见 CODE_STYLE §6.4）

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

## Git 工作流（本地）

> D 盘在 WSL 是只读挂载，**git 命令一律在 Windows 侧执行**（WSL 只用来编辑代码）。GitHub 仓库与 Actions CI 推迟到 M5（按需），M0 起只做本地 git。

### 分支

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定线，任何时候都能打包 | 只接受 `dev` 或紧急 `fix/*` 的合并；不直接在 main 上开发 |
| `dev` | 集成分支 | 功能先合到这里；小改动可直接提交 |
| `feat/*` `fix/*` `docs/*` `chore/*` | 短生命周期分支 | 一次一件事，合完即删；单次 diff 建议 < 400 行 |

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
## 复用的既有能力

| 能力 | 位置 |
|---|---|
| IndexTTS-2.5（外部已部署，本项目只调用） | D:\IndexTTS |
| 既有角色文本素材（ST 格式的卡，仅人工参考，程序不导入） | /home/sch/cards/、/home/sch/st_work/、/home/sch/projects/ |
| 参考音素材 | /home/sch/voice-memos/ |
| RVC 变声链路 | D:\RVC-WebUI |

## 开工前待定项

1. 语音输入键「按住说话 / 单击切换」的默认值
2. 角色包编辑器的形态（M3 阶段再定）
