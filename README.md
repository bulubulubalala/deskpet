# deskpet

常驻 Windows 桌面的 AI 伴侣：立绘、文字 / 语音 / 互动三种模式、长期记忆、主动陪伴、屏幕识图。数据只存本机，不操作你的电脑。

当前版本：**v0.2.0 测试版**

- 仓库：<https://github.com/bulubulubalala/deskpet>
- 下载：<https://github.com/bulubulubalala/deskpet/releases/tag/v0.2.0>
- 发布形态：**只有便携 zip**，不提供安装包

## 下载与启动

到 Release 页下载：

```text
deskpet-0.2.0-x64.zip
```

启动方式：

1. 把 zip 解压到你自己的目录，不要在压缩包里直接运行。
2. 双击解压目录里的 **`deskpet.exe`**。
3. 不要单独移动 `deskpet.exe`；`resources` 文件夹必须和它放在一起。

zip 根目录自带 `使用说明.txt`，内容和上面一致。**不需要命令行，也不需要安装。**

首次运行可能出现 Windows SmartScreen：点「更多信息」→「仍要运行」。当前 exe 未做代码签名，这是测试版的预期行为。

## 第一次使用

1. 角色出现在桌面上，聊天条在立绘下方。
2. 打开「设置 → 模型供给」，填写 LLM 端点、模型和密钥；或把仓库里的 `.env.example` 复制成 `.env` 后填写。
3. 需要语音识别 / 语音合成 / 屏幕识图时，打开「主动陪伴 → 模型库」下载或选择模型。
4. 屏幕识图需要本机 [Ollama](https://ollama.com/) 或一个 OpenAI 兼容的视觉端点；模型文件和 API Key 不随包内置。
5. 主动陪伴默认开启；第一次开始屏幕观察前需要确认一次。关闭陪伴会停止屏幕观察、主动开口和应用动态。

## 功能

- 三只角色：琥珀 / 小雪 / 莫莫。角色包在 `characters/`，人设、立绘和部位可替换。
- 文字 / 语音 / 互动三选一；文字发送、语音开口和按住触摸都能打断当前回复。
- 立绘部位命中 + 手势（点 / 摸 / 按住 / 揉 / 连拍）；部位编辑器可拖移和缩放。
- 长期记忆：原文 + 提取事实 + L1/L2/L3 摘要；加密 SQLite。设置页显示长期事实与最近对话，开发者模式可编辑 / 删除事实、摘要和原始消息。
- 使用统计（开发版）：会话 / 消息 / 时长、prompt / completion / total token、缓存命中率、平均 / 最大上下文、记忆注入 token；可暂停记录或清空。
- 主动陪伴（开发版）：主窗最小化 / 托盘隐藏 / 语音中 / 麦克风被占用 / Windows 全屏或演示时不开口；安静时段、冷却和被忽略退避；会自动记住并追问未完成的事。
- 屏幕识别（开发版）：RapidOCR 离线 OCR + 视觉摘要回退；`Ctrl+Alt+S` 手动截屏；`characters/` 角色包热重载；设置窗可直接拖入 zip 角色包。
- 模型库：ASR / TTS / 识图模型可下载、安装、切换。
- 角色包导入 / 导出：一个 zip 带人格、立绘、部位框和角色资源；同 `char_id` 默认保留两者并自动改名，明确选择才覆盖。
- 设置窗、独立主动陪伴窗、独立角色包编辑器。
- 设置窗可查看麦克风授权状态，并一键打开 Windows 麦克风 / 声音设置；安全软件（如 Kaspersky）拦截 Electron 麦克风时，需要把它加入允许列表。
- 默认只使用 Chromium 麦克风（AEC + AGC + 共享模式）。设置 →「后台引擎」提供兼容模式，只有显式打开后才允许 Chromium 失败时切到 Windows 原生采集。
- 兼容模式的 WDM-KS 会独占麦克风，切到微信等应用时会自动释放，回到 deskpet 恢复；没有回声消除，助手说话时暂停收音，文字仍可打断。
- 语音面板有实时波形 + partial + 状态；互动面板显示 8 秒冷却条和每分钟 4 次额度。

## 记忆与隐私

- 数据库：`%APPDATA%\deskpet\data\memories.db`，SQLCipher 整库加密。
- 原文在**成功压缩后保留 7 天**；压缩失败、未覆盖的原文不删。
- L1 / L2 在成功聚合到上一层后 7 天清理；L3 永久。
- 重要度 `>= 0.8` 的事实永久保留（`DESKPET_MEMORY_PERMANENT_IMPORTANCE` 可调）。
- 「完全重置该角色记忆」会删除原文、事实、摘要、状态、观察和该角色 usage，并 `VACUUM`；角色包、人设、模型文件不会被删除。
- 屏幕截图只在内存中交给识图模型，默认不落盘；观察记忆只保存摘要。
- 用户对软件的操作只在内存里保留最多 8 条 / 10 分钟，作为下一轮上下文，不写长期记忆。

## 已知限制

- 当前是测试版，exe 未签名，可能出现 SmartScreen 提示。
- 只有便携 zip，没有安装器、开机自启和自动更新。
- TTS 的 Piper 权重已经可以下载，但 **Piper 推理适配器尚未接入**；当前实际发音使用 IndexTTS 外部适配器或 Edge 在线音色。
- 屏幕识图依赖 Ollama / OpenAI 兼容视觉端点；未配置时只能使用普通聊天。
- Chromium 的 WASAPI 采集报 `NotReadableError` 时，先检查安全软件（本机已确认是 Kaspersky 拦截 Electron）；把 `electron.exe` / `deskpet.exe` 加入允许列表。默认不会自动切到原生采集；如确实需要，在设置 →「后台引擎」打开兼容模式。原生模式走 WDM-KS、会独占麦克风且没有 AEC，建议戴耳机。
- 应用默认不采集系统级键鼠，只感知 deskpet 自己的界面操作；屏幕内容由视觉模型观察。
- 模型文件较大，首次下载需要网络和磁盘空间。

## 从源码运行

前置：Windows 10/11 x64、Node 24 + pnpm、Python 3.13。

```powershell
pnpm install
py -3.13 -m venv .venv
.venv\Scripts\python -m pip install -e "sidecar[dev]"
pnpm build
pnpm dev
```

提交前门禁：

```powershell
.venv\Scripts\pre-commit run --all-files
.venv\Scripts\python -m pytest -o addopts= -q
pnpm exec vitest run
```

## 构建便携 zip

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1
```

产物：

```text
release\deskpet-0.2.0-x64.zip
```

zip 根目录应包含 `deskpet.exe`、`使用说明.txt`、`resources/sidecar/sidecar.exe`、`resources/config/model-catalog.json`。

国内网络首次构建可能需要镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 文档

- [需求说明书](docs/REQUIREMENTS.md)
- [实施计划](docs/PLAN.md)
- [实测数据](docs/MEASURED.md)
- [验收说明](docs/ACCEPTANCE.md)
- [交接说明](docs/HANDOFF.md)
- [v0.2.0 Release Notes](docs/RELEASE_v0.2.0.md)
- [代码规范](docs/CODE_STYLE.md)
