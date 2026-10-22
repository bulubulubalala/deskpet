# deskpet v0.1.0 测试版

首个便携测试版，只提供 **解压即用 zip**，不提供 NSIS 安装包。

- 仓库：<https://github.com/bulubulubalala/deskpet>
- Release：<https://github.com/bulubulubalala/deskpet/releases/tag/v0.1.0>
- 文件：`deskpet-0.1.0-x64.zip`（253.9 MiB）
- SHA256：`785ae5c1530b75d33678f4d92a9097e215ffd9c44b1cbc798d9b07ab7543782b`

## 怎么启动

1. 下载并解压 zip。
2. 双击根目录的 `deskpet.exe`。
3. 不要单独移动 exe；`resources` 文件夹必须和它在一起。

不需要命令行、不需要安装 Python/Node。首次运行可能触发 SmartScreen：点“更多信息” → “仍要运行”。

## 这次包含

- 琥珀 / 小雪 / 莫莫三只角色与 1024×1536 立绘、12 个身体部位。
- 文字 / 语音 / 互动三种模式。
- 长期记忆、行为观察与完全重置。
- 主动陪伴独立窗口、模型库、持续屏幕观察。
- 应用动态上下文；操作只作为上下文，不写长期记忆。
- 设置窗、角色包编辑器和角色卡编辑。

## 首次配置

- LLM：设置 → 模型供给，填写 OpenAI 兼容端点 / 模型 / API Key。
- ASR：本地 faster-whisper 首次识别时下载，或使用 sherpa 流式模型。
- TTS：当前实际发音走 IndexTTS 外部适配器或 Edge 在线音色。
- 识图：需要 Ollama 或 OpenAI 兼容视觉端点；在“主动陪伴 → 模型库”选择或安装。
- 模型文件、API Key 不随包内置。

## 记忆

- 数据目录：`%APPDATA%\deskpet\data`，记忆库 SQLCipher 加密。
- 原文在成功压缩后保留 7 天；压缩失败不清。
- L1/L2 成功聚合后 7 天清理；L3 与 importance ≥ 0.8 永久。
- 完全重置会删除该角色的原文、事实、摘要、状态、观察和使用统计；角色包不动。
- 屏幕截图只在内存中处理，默认不落盘。

## 已知限制

- exe 未签名，可能有 SmartScreen 提示。
- 只有便携 zip，没有安装器、开机自启、自动更新。
- Piper TTS 权重可下载，但推理适配器尚未接入。
- 未配置视觉端点时，屏幕识图不可用。
- 语音采集 / 播放的真机 AEC、AudioWorklet、句内流式 TTS 仍未验收。

## 验证

- pytest **564 passed**
- vitest **29 文件 270 例**
- pre-commit **7 钩子**
- 便携包冒烟：窗口 **6306 ms**、`/health` **7158 ms**、退出后 `runtime.json` 删除、无孤儿 sidecar
- app.asar **1.4 MiB**（已排除 `dist/sidecar`）
