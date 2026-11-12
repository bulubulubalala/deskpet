# deskpet v0.1.0

首个公开测试版，提供 **便携 zip** 和 **NSIS 安装包**，两种任选其一。

- 仓库：<https://github.com/bulubulubalala/deskpet>
- Release：<https://github.com/bulubulubalala/deskpet/releases/tag/v0.1.0>
- `deskpet-0.1.0-x64.zip`（323.7 MiB）
  SHA256：`20fc050158beb55533ba6efb3165f14b8d0328668995adae0e9bfd5fc9659df0`
- `deskpet-0.1.0-x64-setup.exe`（251.3 MiB）
  SHA256：`ec12295eb7318542509edbd0850163b6d1c6b2f81828619e7030c6dcdfd0ba0f`

## 怎么启动

- 便携包：解压 zip，双击根目录的 `deskpet.exe`；不要单独移动 exe，`resources` 文件夹必须和它在一起。
- 安装包：双击 `deskpet-0.1.0-x64-setup.exe`，按向导安装，从桌面快捷方式或开始菜单启动。

不需要命令行、不需要安装 Python/Node。两种包都不包含 API Key、`settings.json`、`data/`、记忆库或备份。首次运行可能触发 SmartScreen：点“更多信息” → “仍要运行”。

## 这次包含

- 默认角色 **小玉**：人格文本、透明立绘、Live2D 模型与身体部位随仓库和发布包一起提供。
- 文字 / 语音 / 互动三种模式；文字发送、语音开口和触摸都能打断当前回复。
- 长期记忆 v2：原文、事实、时间金字塔、日记、关系、待办与知识图谱；设置页支持一键初始化记忆，滑条确认后清空。
- 模型供给：LLM / ASR / TTS 云端与本地配置分组显示，只测试当前选中的 provider；LLM 云端配置支持“获取模型列表”。
- 主动陪伴：安静时段、冷却、退避、应用动态与屏幕观察；默认开启，首次屏幕观察前确认。
- 屏幕识别：RapidOCR 离线 OCR + 视觉摘要回退；`Ctrl+Alt+S` 手动截屏。
- 角色包：文件夹即用、编辑器、部位框、zip 导入导出、热重载与覆盖 / 保留两者。
- 备份与恢复：每日快照、操作前留底、立即备份、从数据包恢复并一键重启引擎。
- 设置窗、独立主动陪伴窗、独立角色包编辑器；Mint Ink 界面与整窗圆角边框。
- 内置 bge-small-zh-v1.5 量化 ONNX 向量模型，离线可用；也可切换到本机 Ollama BGE-M3。

## 首次配置

- LLM：设置 → 模型供给，填写 OpenAI 兼容端点 / 模型 / API Key；也可用预设。
- ASR：本地 faster-whisper、sherpa 流式模型，或云端 OpenAI 兼容端点。
- TTS：当前实际发音走 IndexTTS 外部适配器或 Edge 在线音色。
- 识图：需要 Ollama 或 OpenAI 兼容视觉端点；在“主动陪伴 → 模型库”选择或安装。
- 模型文件、API Key 不随包内置。

## 记忆与隐私

- 数据目录：`%APPDATA%\deskpet\data`，记忆库 SQLCipher 加密。
- 原文默认保留 30 天；压缩失败不清。
- 时间桶 / 日记 / 关系 / 前瞻记忆不随原文清理；importance ≥ 0.8 的事实永久保留。
- 完全重置会删除该角色的原文、事实、摘要、状态、观察和使用统计；角色包不动。
- 屏幕截图只在内存中处理，默认不落盘。

## 已知限制

- exe 未签名，可能有 SmartScreen 提示。
- 没有开机自启和自动更新。
- Piper TTS 权重可下载，但推理适配器尚未接入。
- 未配置视觉端点时，屏幕识图不可用。
- 语音采集 / 播放的真机 AEC、AudioWorklet、句内流式 TTS 仍未验收。

## 验证

- pytest **733 passed**
- vitest **73 文件 591 例**
- `pnpm verify` 通过
- 便携包冒烟：窗口、sidecar 握手、语音 WebSocket 与正常退出通过
