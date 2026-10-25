# deskpet v0.2.0

v0.2.0 正式发布，GitHub Release 标记为 **Latest（非 Pre-release）**；仍只提供 **解压即用 zip**，不提供 NSIS 安装包。

- 仓库：<https://github.com/bulubulubalala/deskpet>
- Release：<https://github.com/bulubulubalala/deskpet/releases/tag/v0.2.0>
- 文件：`deskpet-0.2.0-x64.zip`（330.8 MiB）
- SHA256：`da7c276c89b34fe82781e6ca05aebbd86d81c5489103f6e3e232fa9feecf310d`

## 怎么启动

1. 下载并解压 zip。
2. 双击根目录的 `deskpet.exe`。
3. 不要单独移动 exe；`resources` 文件夹必须和它在一起。

不需要命令行、不需要安装 Python/Node。首次运行可能触发 SmartScreen：点“更多信息” → “仍要运行”。

## 这次包含

- 三只示例角色：琥珀 / 小雪 / 莫莫，1024×1536 透明立绘与 12 个身体部位。
- 文字 / 语音 / 互动三种模式；文字、语音开口和触摸都能打断当前回复。
- 长期记忆：原文、事实、L1/L2/L3 摘要；设置页显示长期事实与最近对话。
- 开发者模式可编辑 / 删除事实、摘要和原始消息；消息编辑同步 FTS 与 token。
- 使用统计：会话 / 消息 / 时长、prompt / completion / total token、缓存命中、上下文与记忆注入 token；支持暂停、恢复和清空。
- 主动陪伴：最小化 / 托盘 / 语音中 / 麦克风被占用 / Windows 全屏或演示时静默；安静时段、退避、每小时上限与自动追问未完成事项。
- 持久 CharacterState：心情、精力、关系、注意力、最近话题与未完成事项参与提示词。
- 角色包：文件夹即用、编辑器、角色卡与部位编辑、zip 导入导出、覆盖 / 保留两者、`characters/` 热重载、设置窗拖拽 zip。
- 屏幕识别：RapidOCR 离线 OCR + 视觉摘要回退；`Ctrl+Alt+S` 手动截屏进入对话。
- 麦克风：Kaspersky 放行后默认走 Chromium（AEC + AGC + 共享模式）；原生 WDM-KS 仅作为设置中显式开启的兼容模式，失焦自动释放。
- 修复：设置页记忆空白、角色切换后设置不同步、连续切换立绘叠加、引擎重启后健康状态停留“正在重启”。

## 首次配置

- LLM：设置 → 模型供给，填写 OpenAI 兼容端点 / 模型 / API Key。
- ASR：本地 faster-whisper 首次识别时下载，或使用 sherpa 流式模型。
- TTS：当前实际发音走 IndexTTS 外部适配器或 Edge 在线音色。
- 识图：需要 Ollama 或 OpenAI 兼容视觉端点；在“主动陪伴 → 模型库”选择或安装。
- 模型文件、API Key 不随包内置。

## 记忆与隐私

- 数据目录：`%APPDATA%\deskpet\data`，记忆库 SQLCipher 加密。
- 原文在成功压缩后保留 7 天；压缩失败不清。
- L1/L2 成功聚合后 7 天清理；L3 与 importance ≥ 0.8 永久。
- 完全重置会删除该角色的原文、事实、摘要、状态、观察和使用统计；角色包不动。
- 屏幕截图只在内存中处理，默认不落盘。

## 已知限制

- exe 未签名，可能有 SmartScreen 提示。
- 只有便携 zip，没有安装器、开机自启、自动更新。
- Live2D 仍是占位接口，当前使用 PNG 立绘。
- Piper TTS 权重可下载，但推理适配器尚未接入。
- 未配置视觉端点时，屏幕识图不可用。
- 语音采集 / 播放的真机 AEC、AudioWorklet、句内流式 TTS 仍未验收。
- 开发者记忆编辑暂不包含 CharacterState。

## 验证

- pytest **593 passed**
- vitest **34 文件 287 例**
- pre-commit **7 钩子**
- 便携包冒烟：窗口 **1652 ms**、应用启动到 `/health` **2203 ms**、sidecar 冷启动 **942 ms** / 热启动 **824 ms**
- 退出后 `runtime.json` 已删除、无孤儿 sidecar、无残留应用进程
- app.asar **2.0 MiB**（已排除 `dist/sidecar`）
- zip 共 **503** 个条目，包含 `deskpet.exe`、`使用说明.txt`、`resources/sidecar/sidecar.exe` 和 `resources/config/model-catalog.json`
