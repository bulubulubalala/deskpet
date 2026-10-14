# deskpet

常驻 Windows 桌面的 AI 伴侣：有形象、有声音、语音可随时打断、记得住你、会主动找你、看得到屏幕、人格稳定不谄媚；**不操作你的电脑**；可打包为 exe 分发。

- 状态：**需求 v1.15 与代码规范 v1.2 均已冻结，M0 进行中（T0.1 仓库骨架、T0.2 工具链、T0.3 契约先行、T0.5 sidecar 起服务与端口握手已完成）**（任务拆解见 [docs/PLAN.md](docs/PLAN.md)）
- 开发机：Windows 11 + WSL2(mirrored) / RTX 4060 Laptop 8GB / Ryzen 9 7945HX
- 开发约定：**WSL 只用来编辑代码，依赖安装与运行一律在 Windows 侧**

## 文档

所有文档都放在 **docs/**，仓库根只留本 README。

| 文档 | 内容 |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 需求说明书 v1.15（**唯一正本**：决策、实测约束、功能需求、数据契约、验收标准、里程碑） |
| [docs/CODE_STYLE.md](docs/CODE_STYLE.md) | **代码规范 v1.2（已冻结）**：模块化分层 + 注释规则 + 工具链 + 错误码域表 + 提交规范 |
| [docs/PLAN.md](docs/PLAN.md) | 实施计划 v0.5（**M0 任务拆解**：13 项任务 / 前置 4 项 / 顺序与并行 / 验收方式） |
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
