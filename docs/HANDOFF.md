# deskpet 交接说明（HANDOFF）

> **给接手的人（opencode）看的唯一入口。** 先读这一页；需要细节时按 §11 的文档地图跳进去。
> 本文件写于 2026-10-18，基线提交 `8dedc04`（`main` = `dev`），对应需求 **v1.57**、代码规范 **v1.7**。
> 交接时工作区里还有一批**未提交**的语音改动（T1.12b，代码完成但**未真机验证**），见 §7。

## 1. 这是什么

- 常驻 Windows 桌面的 AI 伴侣（Live2D/立绘 + 聊天条 + 透明无边框窗）。
- 技术栈：**Electron 39 壳（TypeScript）+ Python sidecar（FastAPI/uvicorn）**；两者只用本机回环 HTTP/SSE 通信。
- 原始 8 条需求（人设/live2d/语音、可打断、持久记忆+压缩、git/exe、时间感知与主动问候、快速导入人物、屏幕识别、独立人格）在需求书里编号为 **F1–F11**，每项的子功能完成情况见 `docs/REQUIREMENTS.md` v1.57 的逐项表（§F1–§F11 各自的「完成情况（v1.57）」）。
- **文档即规格**：任何行为改动都要同步五份文档（REQUIREMENTS / PLAN / MEASURED / ACCEPTANCE / README），这是本项目的硬约定。

## 2. 目录与数据流

| 路径 | 职责 |
| --- | --- |
| `app/main/` | Electron 主进程：建窗与托盘、sidecar 进程管理、心跳、IPC 处理、聊天编排、TTS 音频回传、拖动/最小化、开发者模式文件 |
| `app/preload/` | `contextBridge` 暴露的 `window.deskpet`（`api.ts` 是类型、`index.ts` 是实现，**两侧必须同时改**，漏一侧 `tsc` 报 TS2741） |
| `app/renderer/` | 界面：`index.html/ts/css`（主窗聊天条 + 立绘 + 手势）、`settings.html/ts`（设置窗）、`editor.html/ts`（角色包编辑器）、`char-hit.ts`（部位命中）、`audio-codec.ts`/`voice-vad.ts`/`voice-playback.ts`/`voice-engine.ts`（语音，**新增未验证**） |
| `sidecar/core/` | 纯逻辑：`prompt.py`（提示词/输出协议/记忆块）、`memory.py`（记忆模型与预算）、`text.py`（分句 ≤40 字）、`usage.py`、`env_events.py`、`voice_state.py`、`errors.py` |
| `sidecar/adapters/` | 外部依赖：`llm_openai.py`、`asr_faster_whisper.py`、`tts_index.py`、`memory_sqlite.py`（SQLCipher）、`usage_sqlite.py`、`dpapi.py`/`memory_key.py`（记忆密钥） |
| `sidecar/services/` | 编排：`chat_service.py`、`memory_service.py`、`memory_summary_service.py`、`behavior_memory_service.py`、`usage_service.py`、`character_store.py`、`provider_test_service.py`、`health_service.py` |
| `sidecar/api/` | FastAPI 路由（`router.py` 汇总；鉴权在 `auth.py`） |
| `sidecar/contracts/` | 契约唯一来源：`routes.py`（路由表）、`api_models.py`、`health.py`、`events.py`、`character.py`、`openapi.json` 与 `llm_events.schema.json`（**生成物，改了模型要重导出**） |
| `tools/indextts_adapter/` | 常驻 IndexTTS HTTP 适配器（本项目只调用它，不装不调参，见 D14） |
| `characters/<char_id>/` | 角色包：`card.json` `pack.json` `appearance.json` `voice.json` `emotion_map.json` `hits.json` `assets/` |
| `scripts/` | 构建、OpenAPI 导出、冒烟与验收脚本（见 §5） |
| `tests/` | pytest（Python，仓库根 `pytest.ini`）+ vitest（TS） |

**请求链路**：renderer → preload → IPC（通道集中登记在 `app/main/ipc.ts` 的 `IPC_CHANNELS`，`tests/ipc-contract.test.ts` 与 sidecar 逐字段对账）→ 主进程 → sidecar（`127.0.0.1:<port>`，`X-Deskpet-Token`；真实端口与 token 在 `<数据目录>/runtime.json`，六字段 pid/host/port/token/started_at/version）→ LLM / ASR / TTS。合成音频经 `deskpet:tts:audio` 回渲染层播放。

**三条不可破坏的约定**：
1. sidecar 只监听回环 + token 鉴权；端口被占自动退回随机端口，主进程按 `runtime.json` 兜底。
2. LLM 流式输出协议：`t=s`（句）`m`（记忆事实）`a`（动作）`e`（错误，必紧跟 `end`）`end`；单句 ≤40 汉字（`sidecar/core/text.py`）。
3. 记忆四层 L0 事实 → L1 摘要 → L2 → L3，注入预算（默认 L3 200 / L2 300 / L1 200 / L0 400 / 历史 1200 token），裁剪顺序**历史 → L0 → L1 → L2，L3 只截不丢**；屏幕 OCR 文本与用户操作明细不进记忆库（后者进 `usage.db`）。

## 3. 环境准备（Windows 侧；这台机器是 WSL + D 盘双份，见 §10）

```bat
cd /d D:\Agent_Projects\deskpet
:: Python 依赖（项目自带 .venv，Windows Python 3.13）
.venv\Scripts\python.exe -m pip install -e "sidecar[dev]"
:: Node 依赖（pnpm 12；corepack enable 在本机被 EPERM 挡，用 npm 全局装）
npm i -g pnpm@12
pnpm install
```

- 装依赖前如果卡住：`C:\Users\sch\.npmrc` 里有一条**死代理** `127.0.0.1:10808`。临时移走它，并加 `--registry=https://registry.npmmirror.com`；electron 需要 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。pnpm 12 只允许被批准的依赖跑安装脚本（`pnpm-workspace.yaml` 的 `allowBuilds: esbuild/electron/electron-winstaller: true`）。
- `.env`：从 `.env.example` 复制到**仓库根**（已被 `.gitignore`）。最小配置是 LLM 三键：`DESKPET_LLM_PROVIDER=cloud`、`DESKPET_LLM_BASE_URL`、`DESKPET_LLM_API_KEY`、`DESKPET_LLM_MODEL`。完整键表见 `.env.example`（LLM / ASR / TTS / sidecar / 日志 / 15 个 `DESKPET_MEMORY_*`）。
- ASR：faster-whisper `small` + CPU + int8，模型约 460MB 首次识别时下载到 `<数据目录>/models/asr`（**不进安装包**）。国内下载要 `HF_HUB_DISABLE_XET=1`（否则 HuggingFace Xet CAS 报 401），或设 `DESKPET_ASR_HF_ENDPOINT=https://hf-mirror.com`。
- TTS（可选）：自己部署 IndexTTS 适配器（`python -m tools.indextts_adapter`，监听 `http://127.0.0.1:8742`）。**没启动时不影响文字聊天**，只是聊到第三句左右会冒一条「语音引擎没有在运行…」提示气泡，可忽略（冒烟脚本把它记成 `hints` 而非失败）。
- 角色包素材：`characters/{amber,snow,momo}/`（三只示例人格，立绘 512×724 PNG，`hits.json` 是部位框）。

## 4. 跑起来

```bat
cd /d D:\Agent_Projects\deskpet
pnpm dev            :: = pnpm build（esbuild 打 dist/）&& electron .
```

- 主窗约 0.7s 可见、sidecar 就绪约 1s（首次真机冷启动可能 4–5s）。
- 数据目录：开发态默认 `<仓库根>\data\`（`DESKPET_DATA_DIR` 可覆盖；安装包态是 `userData\data`）。里面有 `memories.db`（SQLCipher）、`key.blob`（Windows DPAPI 保护的密钥）、`ui.json`、`runtime.json`、`logs/deskpet.log`（sidecar，JSON 行）与 `logs/deskpet-main.log`（主进程）。
- 窗口不见了/位置离谱：删 `<数据目录>\ui.json` 复位；托盘右键有「显示主界面 / 位置重置到屏幕中央 / 最小化 / 设置 / 退出」。
- 开发者模式：设置窗连续点版本号 20 次（间隔 >1s 归零），开启后出现「关闭开发者模式」与「角色记忆」；记忆两页 = 原文（L0 消息）/ 注入预览（模型实际看到的上下文），L0 事实可编辑，行为观察（`kind=action`）不可编辑。

## 5. 怎么验证（改完必须全绿才算完）

### 5.1 门禁四件套（都在 D 盘仓库根跑）

```bat
.venv\Scripts\python.exe -m pytest                 :: 526 passed（当前基线）
node node_modules\vitest\vitest.mjs run             :: 22 文件 208 例（当前基线）
node node_modules\typescript\bin\tsc --noEmit
node node_modules\eslint\bin\eslint.js app tests
.venv\Scripts\python.exe -m pre_commit run --all-files   :: 7 个钩子
```

- **vitest / prettier / build 必须用 Windows 的 node**（`C:\Program Files\nodejs\node.exe`）。在 WSL 里跑 `node node_modules/...` 会因 `/mnt/d` 只读报 `EROFS`，rollup 也装不了 win32 版。
- `pytest.ini` 的 `addopts` 已含 `-q`，命令行再加 `-q` 会吞掉 summary 行。
- ruff 一律走 `--config sidecar/pyproject.toml`（行宽 100）。**手写 `ruff check <显式路径>` 会用默认配置报一堆假问题**，别照它改代码——pre-commit 钩子是唯一口径。
 - 格式化顺序（踩过）：改镜像 → robocopy 到 D → **在 D 上** prettier/ruff format → **把 D 的文件 cp 回镜像** → 再跑门禁。只做一半，下一次 robocopy 会把未格式化版本盖回去。

### 5.2 改了契约要重导出 OpenAPI

```bat
.venv\Scripts\python.exe scripts\export_openapi.py
:: 产出 sidecar/contracts/openapi.json 与 sidecar/contracts/llm_events.schema.json
:: /mnt/d 只读，生成后要 cp 回 WSL 镜像仓库；不重导出时 tests/ipc-contract.test.ts 会对不上
```

### 5.3 真机冒烟（真实 Electron + 真实 LLM 端点）

| 脚本 | 验什么 | 备注 |
| --- | --- | --- |
| `powershell -ExecutionPolicy Bypass -File scripts\smoke_text.ps1 -Turns 3` | 文字闭环：首句时延、打断释放、思考气泡 1→2→3 个「·」 | 前置 `pnpm build`；路径必须用正斜杠 |
| `scripts\smoke_memory.ps1` | 说事实 → 重开 → 问出来（tell/ask 两阶段） | `-Clean` 用干净数据目录 |
| `scripts\smoke_settings.ps1` | 设置窗：3 张供给卡 + 真实「测试连接」、记忆列表/删除/清空、开发者模式开关、手势菜单 | 会自己 build、自己清残留 electron |
| `scripts\smoke_release.ps1` | 打包产物冷启动与体积 | M0 时代口径 |

### 5.4 离线/专项探针

| 脚本 | 验什么 |
| --- | --- |
| `.venv\Scripts\python.exe scripts\memory_check.py`（`--live` 走真实模型） | F3 四条判据：重开记得 / 100 轮后仍能回忆第 10 轮事实 / 装配 <80ms 且来源可追溯 / 单条删除即时生效 |
| `scripts\persona_switch_check.py`（`--live`） | 三只人格导入 + 换人感知五条判据（人格生效 / 记忆隔离 / 切换留痕 / 观察派生 / 风格可分） |
| `scripts\persona_probe.py` | 反谄媚人格人工探针（10 条不合理请求 + 10 个立场题，多标签分类） |

人工验收步骤在 `docs/ACCEPTANCE.md` §3（文字对话与打断 / 记忆 / 人格三条）。

## 6. 当前状态

### 6.1 git 与版本

- 分支：`main`（稳定）与 `dev`（集成），当前 **HEAD = main = dev = `8dedc04`**，工作区有未提交的语音改动（§7）。
- 流程：`dev` 上 `commit -F <消息文件>` → `checkout main` → `merge --no-ff dev` → `branch -f dev main`。提交信息一律写文件再 `-F`（内联中文在 bash 里容易被吃）；**git 必须用 Windows 的 `/mnt/d/Git/cmd/git.exe -C 'D:/Agent_Projects/deskpet'`**，在 WSL 里跑 git 会报 `index.lock: Read-only file system`。
- 版本号唯一来源 `package.json` = **0.1.0**；全仓唯一 tag 是 M0 的 `v0.1.0-m0.1`。**首个正式 tag 还没打**（等用户确认版本号）。
- `git remote -v` 为空：GitHub 发布按用户决策推迟（M5）。

### 6.2 已完成（简表；逐项证据见 `docs/REQUIREMENTS.md` v1.57）

| 面 | 状态 |
| --- | --- |
| 人设与反谄媚人格 F8 | ✅ 三只示例人格（amber/snow/momo）可切换；立场题 10/10 有异议 |
| 记忆 F3 | ✅ 四层 L0→L3 + 摘要压缩 + 行为观察 + 设置窗/开发者模式管理与 L0 编辑；offline/live 4/4 |
| 界面 F11 | ✅ 透明无边框主窗、聊天条、拖动/置顶/托盘位置重置、思考气泡、立绘真加载、部位点击与五种手势、最小化 |
| 角色包 F6 | 🔶 文件夹放进去即用 + 独立编辑器（选图/裁切/画部位框/填卡/写包）；导入导出向导后置 |
| 模型供给 T1.14 | ✅ 每个能力面 cloud/local 双轨 + 设置页配置与「测试连接」（云端 ASR/TTS 后置） |
| 打包 F4 | 🔶 NSIS/zip 链路 M0 已通；`release/` 里的产物是 M0 的，文字阶段改动**未重新打包** |
| 语音 F2 | 🔶 引擎侧齐（五态状态机 + 播放侧打断 + IPC），渲染层音频代码刚写完全绿但**未真机验证**（§7） |
| 时间感知 F5 | 🔶 时段/情绪/关系变体已注入提示词；**主动发消息没做** |
| 屏幕识别 F7 | ⬜ 未做（`POST /screen/capture` 仍是 501 桩） |
| Live2D M3 | ⬜ 未做（只有契约字段） |

### 6.3 还没做完的（下一任的活）

1. **T1.12b 语音接线真机验证**（最重要，见 §7）。
2. `POST /screen/capture`（F7 屏幕识别）与 `POST /persona/import`（F6 导入向导）——**全仓只剩这两个 501 桩**，其余路由都已实现。
3. 主动问候（F5）：角色卡已有 `proactive` 字段、`memories` 表已有 `last_proactive_ts`/`proactive_ignored_streak` 列，**逻辑没写**。
4. Live2D（M3）：契约里有 `live2d_expr`/`stage: png|live2d|hybrid`，没有实现。
5. 语音阶段其余：T1.7 反应音库、T1.13b 语音端到端冒烟；`voice.json` 的参考音**没有接进 TTS**（`tts_index.py` 只发 text/voice_id/emo_vector，snow 与 momo 目前没有 `voice.json`）；`emotion_map.json` 还是 8 维格式、`emo_text`/`emo_alpha` 未接线（D20 后情感应由 IndexTTS 文本输入承担）。
6. 重新打包（`pnpm build:sidecar` → `pnpm pack:win`）并更新 `release/`。
7. GitHub 发布（M5）：加 remote、推 main/dev、打正式 tag。

## 7. 进行中的工作：T1.12b 语音接线（**代码完成、单元测试全绿、未经任何真机验证**）

用户已定案 **D20：语音形态 = 常开麦全双工**（麦克风常开 + VAD 断句 + Chromium `getUserMedia` 自带 AEC），「按住说话」降为可选。

### 7.1 已落地的文件（未提交，在 `main` 的工作区）

| 文件 | 职责 |
| --- | --- |
| `app/renderer/audio-codec.ts` | 重采样到 16k、float→PCM16、RMS、拼帧（`ASR_SAMPLE_RATE = 16000`） |
| `app/renderer/voice-vad.ts` | `UtteranceSegmenter`：静音阈值/最短语音/尾静音/最长句/预滚；事件 `speech_start` / `utterance` / `speech_dropped` |
| `app/renderer/voice-playback.ts` | `PlaybackQueue`：串行播放、`interrupt()` 用 generation 作废排队项 |
| `app/renderer/voice-engine.ts` | `getUserMedia({echoCancellation,noiseSuppression,autoGainControl,channelCount:1})` + `createScriptProcessor(2048,1,1)` + 静音 GainNode 接 destination（保住 AEC）；麦克风按钮开关 |
| `app/renderer/index.ts` / `index.html` / `style.css` | 常开麦接线：`speech_start` → 打断 + `api.voice.start()`；整句 → `api.voice.stop()` → 有文本就发 `api.chat.send({input_mode:"voice"})`，没听清提示「没听清，再说一次。」；`deskpet:tts:audio` → 播放队列 |
| `app/main/chat-orchestrator.ts` | `stopListening` 增加「空 PCM = 关麦」分支（返回 `{text:"",confidence:0,heard:false}`） |
| `tests/voice-audio.test.ts`（13 例）、`tests/voice-playback.test.ts`（4 例）、`tests/chat-orchestrator.test.ts`（新增「空 PCM 按关麦处理」） | 单测 |

### 7.2 已验证 / 未验证

- ✅ 已验证：`tsc --noEmit` 0、`eslint app tests` 0、vitest **22 文件 208 例全过**（含新增 17 例）。
- ❌ **未验证**（交接重点）：麦克风权限流程、AEC 实际效果（会不会把自己播的话听回去）、真实打断时延（目标 <200ms 停播）、VAD 误触发率与环境噪声、长时间常开麦的资源占用、与 TTS 播放的并行表现。
- ❌ 未做：Electron 假音频设备注入（`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>`），这是自动化验语音的正确入口。
- ❌ 未做：五份文档的 T1.12b 段落（必须如实写「代码完成、未真机验证」）。

### 7.3 下一步（建议顺序）

1. 先在 D 盘 `pnpm dev` 手动试一次：点麦克风按钮 → Windows 弹出权限 → 说一句 → 看出字幕气泡与 TTS 播放；说话时是否立刻停播。
2. 用 Electron 假音频参数 + 一个 wav 做可重复的自动化（新增 `scripts/smoke_voice.ps1` + `.mjs`，照 `scripts/smoke_text.ps1` 的骨架写，CDP 驱动，产物落 `D:\Agent_Projects\_probe_out\`）。
3. 量三个数：整句识别延迟、说话到停播的时延、误触发次数（静音房间 5 分钟）。
4. 数字进 `docs/MEASURED.md` 新区段，需求书 §F2 与 §6.x 更新，README 状态行更新，然后按 §6.1 的流程提交。

## 8. 已知欠账 / 技术债（不影响跑，但接手的要知道）

1. **覆盖率门槛没有执行者**：需求写「core ≥85% / 整体 ≥70%」，但全仓没有 `--cov` / `fail_under`，CI 也没有。
2. **pre-commit 的 ruff 钩子只覆盖 `sidecar|tools|scripts`，不含 `tests/`**，所以 tests 里存在超 100 列的历史行。要收口就改 `.pre-commit-config.yaml` 的 `files:` 并一次性格式化。
3. 近似重复的 L0 事实会各存一行（去重键按整句归一化，措辞不同就不合并）。
4. `hits.json` 的部位框是**目测画的第一版**（角色包编辑器可事后调）。
5. `#pause-button` 是死 UI（渲染层没有绑定，虽然 sidecar 有 `META_RECORDING_ENABLED` 开关）；`clear_usage()` 也没有 API 路由与界面入口。
6. 记忆/用量批量落盘窗口是 **300s**（`sidecar/core/usage.py` 的 `DEFAULT_FLUSH_INTERVAL_S`），短跑冒烟时表可能是空的——验记账要么跑够 5 分钟，要么写单测。
7. `dist/`、`release/` 是构建产物且已 `gitignore`；`release/` 里的安装包是 M0 时代的。
8. `README.md` 第 5 行是一条超长状态单行（约 1.2 万字符），`read` 工具会截断——要用脚本读整行再切片。

## 9. 这台机器的环境陷阱（每条都真的踩过）

1. **`/mnt/c` 与 `/mnt/d` 从 WSL 看是只读 9p 挂载**：`touch/cp/rm` 报 `Read-only file system`。所有写入先在 WSL 镜像 `/home/sch/DSH_workspace/_t04` 做，再用 robocopy 同步到 `D:\Agent_Projects\deskpet`；删 D 盘文件用 `cmd.exe /d /c "del /q D:\..."`。
2. **robocopy 同步**：`/mnt/c/Windows/System32/robocopy.exe '\\wsl.localhost\Ubuntu\home\sch\DSH_workspace\_t04' 'D:\Agent_Projects\deskpet' /E /XD .mypy_cache .ruff_cache __pycache__ .pytest_cache .git node_modules .venv dist release /NFL /NDL /NJH /NP`，返回码 **3 或 1 都是成功**。只同步单个文件时目标要写**目录**并只写裸文件名（带子目录路径会静默不复制）；cmd 里路径**不要加双引号**（会 rc=16）。
3. **同步方向**：`_t04` 是权威副本，D 盘只用来构建/运行。在 D 上格式化（prettier / ruff format）之后**必须把 D 的文件 cp 回镜像**，否则下次 robocopy 会覆盖回去。
4. **`.ps1` 必须 UTF-8 BOM**：PowerShell 5.1 按 cp936 读无 BOM 的中文脚本会报「意外的标记」；`tools.edit` 会丢 BOM，`scripts/check_ps1_bom.py` 就是拦这个的。补 BOM 时先 `.replace(/^\uFEFF+/, '')` 去重，否则会写出双 BOM。
5. **真机 Electron 有单实例锁**：起之前先 `taskkill /F /IM electron.exe`（退出码 128 = 没有该进程，正常），否则新实例静默自退、CDP 报 `fetch failed`。
6. **CDP 探针**：`scripts/lib/cdp.mjs` 的 `connectPage(port, needle)` 返回 `{cdp, socket}`（不是 cdp 本身）；`Cdp.evaluate` 已 `returnByValue`，**不要再套 `JSON.parse`**；合成点击要先把指针 hover 到落点再按下，否则会产生一个跨屏 `mousemove` 被误判成「滑动」。
7. **本会话的 bash 工具**曾坏于 `spawn bwrap ENOENT`（后来恢复）。兜底写法是在 `run_code` 里 `cp.spawnSync('/mnt/c/Windows/System32/cmd.exe', ['/d','/c','cd /d D:\Agent_Projects\deskpet && <cmd>'], { env, cwd:'/mnt/d' })`，env 至少给 `SystemRoot`/`windir`/`PATH`（含 `C:\Program Files\nodejs`、`D:\Agent_Projects\deskpet\.venv\Scripts`）/`PATHEXT`/`TEMP`/`USERPROFILE`/`PYTHONIOENCODING=utf-8`；cmd 串里 exe 绝对路径**不要加双引号**。
8. **控制台编码**：Windows Python 默认 GBK，中文/✓✗ 过管道会乱码或抛 `UnicodeEncodeError`。脚本里 `sys.stdout.reconfigure(encoding="utf-8")`；读回用 node:fs + `TextDecoder('gbk'/'utf-8')` 兜；PowerShell 的 `>` 重定向写 UTF-16LE。
9. **后台长链作业会僵尸**（robocopy→tsc→eslint→vitest→pytest→pre-commit 一条命令时 `job_output` 永远 running）：拆成每段 <115s 的分步命令。
10. **探针文件不能进提交**：一律以 `scripts/_probe*` / `scripts/_harness*` 命名，提交前两侧删净（`ls scripts | grep -c '^_probe'` = 0）；截图/报告落仓库外的 `D:\Agent_Projects\_probe_out\`。
11. **记忆密钥是 Windows DPAPI**（`sidecar/adapters/dpapi.py`）：非 Windows 上 `default_protector()` 直接抛错、**绝不退化明文**。所以 sidecar 的完整链路只能在 Windows 跑（纯逻辑与单测可以在别处跑）。
12. **不要 `pnpm run` / `pnpm exec`**：pnpm 12 的 lockfile 供应链校验要联网，在坏代理环境会卡死提交。pre-commit 钩子直接调 `.venv/Scripts/python.exe` 与 `node_modules/.bin/*.cmd`。

## 10. 文档地图

| 文档 | 作用 |
| --- | --- |
| `docs/REQUIREMENTS.md` | **唯一正本**：富需求 + 决策表 D1–D20 + F1–F11 逐项完成情况（v1.57） |
| `docs/PLAN.md` | 里程碑与任务拆解、进度表、变更记录 |
| `docs/MEASURED.md` | 所有实测数字（冷启动/时延/记忆装配/手势/编辑器…），§8.1A–§8.1W 每轮取证 |
| `docs/ACCEPTANCE.md` | 文本阶段交付清单、怎么跑、三条人工验收步骤、自动脚本数字表 |
| `docs/CODE_STYLE.md` | 代码规范（行宽 100、中文注释 + 英文标识符、拆分判据、覆盖率目标） |
| `docs/AUDIT_MODULARITY.md` | 模块化与规范审计（文件行数排行、重复片段、规范盲区） |
| `docs/PROPOSAL_INTERACTION.md` | 开发者模式 / 角色记忆 / 部位点击 / 编辑器的方案（已获批） |
| `docs/PROPOSAL_TOUCH.md` | 触摸互动方案 v0.2（手势、互动模式、手势菜单、最小化） |
| `docs/PERSONA_CASES.md` | 反谄媚人格的人工用例清单 |
| `README.md` | 门面：文档表 + 一条超长状态行 |

## 11. 交接检查单

- [ ] 在 Windows 侧克隆/同步到 `D:\Agent_Projects\deskpet`，按 §3 建 `.venv` 与 `node_modules`，填 `.env`。
- [ ] `pnpm dev` 能起来、能文字聊天、设置窗能开（这一步通了说明环境没问题）。
- [ ] 跑 §5.1 四件套，确认与本文基线一致（pytest 526 / vitest 22 文件 208 例 会因 §7 提交而变化）。
- [ ] 先处理 §7 的语音真机验证（要么验完、要么明确回退掉这批改动再交接）。
- [ ] 需要打包时：`pnpm build:sidecar` → `pnpm pack:win`，并更新 `docs/MEASURED.md` 与 `release/` 说明。
- [ ] 与本项目的主人确认版本号后再打首个正式 tag（`package.json` 目前 0.1.0）。

