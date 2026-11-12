# deskpet

常驻 Windows 桌面的 AI 伴侣：立绘、文字 / 语音 / 互动三种模式、长期记忆、主动陪伴、屏幕识图。数据只存本机，不操作你的电脑。

当前版本：**v0.1.0 公开测试版**。

- 仓库：<https://github.com/bulubulubalala/deskpet>
- 下载：<https://github.com/bulubulubalala/deskpet/releases/tag/v0.1.0>
- 发布形态：**便携 zip + NSIS 安装包**，两种任选其一

## 下载与启动

到 Release 页下载：

```text
deskpet-0.1.0-x64-setup.exe   安装包：双击安装，可选安装目录
deskpet-0.1.0-x64.zip         便携包：解压后直接运行
```

便携包启动方式：

1. 把 zip 解压到你自己的目录，不要在压缩包里直接运行。
2. 双击解压目录里的 **`deskpet.exe`**。
3. 不要单独移动 `deskpet.exe`；`resources` 文件夹必须和它放在一起。

安装包启动方式：双击 `deskpet-0.1.0-x64-setup.exe`，按向导安装；安装完成后从桌面快捷方式或开始菜单启动。

两种包都不包含你的 API Key、`settings.json`、`data/`、记忆库或备份。首次运行可能出现 Windows SmartScreen：点「更多信息」→「仍要运行」。当前 exe 未做代码签名，这是测试版的预期行为。

## 第一次使用

1. 角色出现在桌面上，聊天条在立绘下方。
2. 打开「设置 → 模型供给」，填写 LLM 端点、模型和密钥。配置存在 `data\settings.json`（设置窗底部会显示路径），
   密钥用系统加密保存；开发期如果已有旧的 `.env`，第一次启动会自动导入一次，之后不再读写它。
3. 需要语音识别 / 语音合成 / 屏幕识图 / 向量模型时，打开「主动陪伴 → 模型库」下载或选择模型。
4. 需要语义记忆时，先安装并启动 [Ollama](https://ollama.com/)，再到「设置 → 记忆与统计 → 语义检索」下载 `BGE-M3`（约 1.2 GB）并启用；只提示重启，不会自动重启。
5. 屏幕识图需要本机 Ollama 或一个 OpenAI 兼容的视觉端点；模型文件和 API Key 不随包内置。
6. 主动陪伴默认开启；第一次开始屏幕观察前需要确认一次。关闭陪伴会停止屏幕观察、主动开口和应用动态。

## 功能

- 默认角色：小玉（`characters/xiaoyu/`），人格文本、透明立绘、Live2D 模型与部位框随仓库和发布包一起提供，可继续替换；PNG 立绘保留为加载失败回退。
- 全桌面视线跟随：Live2D 角色眼睛 / 头 / 身体跟随 Windows 桌面任意位置的鼠标；窗口隐藏或最小化时自动暂停。视线支点在「编辑当前角色部位」里显示为十字准星，可拖动；Live2D 角色默认按 PSD2Live faceRig 放到脸部中心，也可一键复位。视线带脸部死区和 180ms 缓动，窗口边缘不会满幅转头。
- 微信式聊天记录：用户消息在右、角色回复在左，气泡淡入淡出、可滚动；旧消息超上限或切换角色时淡出，互动模式自动隐藏。
- 文字 / 语音 / 互动三选一；文字发送、语音开口和按住触摸都能打断当前回复。
- 立绘部位命中 + 手势（点 / 摸 / 按住 / 揉 / 连拍）；部位支持矩形 / 椭圆 / 多边形、优先级与命中容差，Live2D 角色还能「按模型网格生成」自动贴合身体，并可一键套用 13 个标准部位；部位编辑器可拖移和缩放。设置里可调角色显示大小 50%–200%，上限自动适配当前屏幕。
- 触摸反馈动效（互动模式，只在立绘窗口内）：点 / 拍在触点画一圈涟漪（取该部位主题色），摸 / 揉画细光带轨迹；松手立刻有本地表情 + 微动作 + 骨骼微调（点头、歪头、眯眼、身体轻晃），随即由模型回复接管；光标出窗 1.5 秒后视线缓回，安静 8–25 秒会自己换个待机动作。不做全屏粒子。
- 渲染帧率五档（设置 →「外观 → 渲染帧率」15 / 30 / 45 / 60 / 120，默认 60）：角色不动时自动降到 30 帧省电，触摸、说话或视线移动后 2 秒内跑满所选档位。
- 长期记忆：原文 + 事实 + 时间金字塔（Episode / Day / Week / Month）+ 手动日记 + 关系记忆 + 前瞻记忆 + 知识图谱；加密 SQLite。设置页可查看时间线、写 / 改 / 删日记、编辑关系、查看 / 完成待办、浏览记忆网络，开发者模式可编辑 / 删除事实、摘要和原始消息。旧 L1/L2/L3 保留为回退。
- 语义检索：安装包内置 **bge-small-zh-v1.5** 量化 ONNX 模型（约 24 MB、512 维，随包放在 `models/embedding`，免装 Ollama、离线可用），开箱即用；也可在设置页下载 / 启用本地 Ollama `BGE-M3`（约 1.2 GB）换成更强的向量。可用时 FTS 与向量按 RRF 融合，模型缺失或推理失败时自动只用 FTS。
- 使用统计（开发版）：会话 / 消息 / 时长、prompt / completion / total token、缓存命中率、平均 / 最大上下文、记忆注入 token；可暂停记录或清空。
- 主动陪伴（开发版）：主窗最小化 / 托盘隐藏 / 语音中 / 麦克风被占用 / Windows 全屏或演示时不开口；安静时段、冷却和被忽略退避；会自动记住并追问未完成的事。
- 屏幕识别（开发版）：RapidOCR 离线 OCR + 视觉摘要回退；`Ctrl+Alt+S` 手动截屏；`characters/` 角色包热重载；设置窗可直接拖入 zip 角色包。
- 模型库：ASR / TTS / 识图 / 向量模型可下载、安装、切换；BGE-M3 也可在「记忆与统计」里直接下载 / 启用。
- 语音识别模型可以提前下：设置 →「后台引擎 → 语音识别模型」显示「已就绪 / 还没下载 / 正在下载 / 下载失败」，
  点「下载模型」就在后台下并显示进度；不用等到第一次点麦克风才静默下几百 MB。云端识别时不下载。
- 备份看得见：设置 →「记忆 → 备份与迁移」列出 `data/backups` 里的文件（每日快照、操作前留底、
  恢复时被换下或打不开的残骸），带大小和时间；旁边「立即备份」手动存一份，「打开数据目录」直接跳过去。
- 角色包导入 / 导出：一个 zip 带人格、立绘、部位框和角色资源；同 `char_id` 默认保留两者并自动改名，明确选择才覆盖。
- 设置窗、独立主动陪伴窗、独立角色包编辑器。
- 设置窗可查看麦克风授权状态，并一键打开 Windows 麦克风 / 声音设置；安全软件（如 Kaspersky）拦截 Electron 麦克风时，需要把它加入允许列表。
- 默认只使用 Chromium 麦克风（AEC + AGC + 共享模式）。设置 →「后台引擎」提供兼容模式，只有显式打开后才允许 Chromium 失败时切到 Windows 原生采集。
- 兼容模式的 WDM-KS 会独占麦克风，切到微信等应用时会自动释放，回到 deskpet 恢复；没有回声消除，助手说话时暂停收音，文字仍可打断。
- 语音面板有实时波形 + partial + 状态；互动面板显示 8 秒冷却条和每分钟 4 次额度。

## 记忆与隐私

- 数据库：`%APPDATA%\deskpet\data\memories.db`，SQLCipher 整库加密。
- 便携模式（可选）：在 `deskpet.exe` 同级放一个空的 `portable.txt`，数据（含 `settings.json`）、角色就都落在
  该文件夹的 `data/` 与 `characters/` 下，整个目录拷走即可换机；删掉 `portable.txt` 回到 `%APPDATA%`。
  安装到 Program Files 等不可写目录时不要开；多账户共用同一份安装也不要开。
- 原文默认保留 **30 天**（`DESKPET_MEMORY_RETENTION_DAYS` 可调）；压缩失败、未覆盖的原文不删。
- 时间桶 / 日记 / 关系 / 前瞻记忆不随原文清理；低强度时间桶和事实会进入 dormant / archived，置顶与高重要度记忆保留。
- 重要度 `>= 0.8` 的事实永久保留（`DESKPET_MEMORY_PERMANENT_IMPORTANCE` 可调）。
- 「完全重置该角色记忆」会删除原文、事实、摘要、状态、观察和该角色 usage，并 `VACUUM`；角色包、人设、模型文件不会被删除。
- 屏幕截图只在内存中交给识图模型，默认不落盘；观察记忆只保存摘要。
- 用户对软件的操作只在内存里保留最多 8 条 / 10 分钟，作为下一轮上下文，不写长期记忆。

## 已知限制

- 当前是测试版，exe 默认未签名（可用 `pnpm sign:win` 自签名），可能出现 SmartScreen 提示。
- 没有开机自启和自动更新（只有手动点「检查更新」）。
- TTS 的 Piper 权重已经可以下载，但 **Piper 推理适配器尚未接入**；当前实际发音使用 IndexTTS 外部适配器或 Edge 在线音色。
- 屏幕识图依赖 Ollama / OpenAI 兼容视觉端点；未配置时只能使用普通聊天。
- BGE-M3 依赖本机 Ollama；未安装 Ollama 或未拉取模型时，语义检索自动回退 FTS，不影响记忆与聊天。
- Chromium 的 WASAPI 采集报 `NotReadableError` 时，先检查安全软件（本机已确认是 Kaspersky 拦截 Electron）；把 `electron.exe` / `deskpet.exe` 加入允许列表。默认不会自动切到原生采集；如确实需要，在设置 →「后台引擎」打开兼容模式。原生模式走 WDM-KS、会独占麦克风且没有 AEC，建议戴耳机。
- 应用默认不采集系统级键鼠，只感知 deskpet 自己的界面操作；屏幕内容由视觉模型观察。
- 模型文件较大，首次下载需要网络和磁盘空间。

## 升级与校验

- 升级方式：先退出 deskpet，再解压新 zip 覆盖旧目录。数据默认在 `%APPDATA%\deskpet\data`，覆盖程序目录不影响它；
  开过便携模式（exe 同级有 `portable.txt`）的话，解压时要**保留 `portable.txt`、`data/`、`characters/`**，
  只覆盖程序文件——否则等于换了一个空身份。
- 覆盖前建议先导出一份数据包（设置 →「记忆 → 备份与迁移 → 导出数据包…」），或直接复制
  `data\backups\` 里最近一份 `memories-YYYYMMDD.db`；升级出问题时可用「从数据包恢复…」换回来。
- 应用内检查更新：设置 →「后台引擎 → 版本更新」里有「检查更新」，只有你点按钮时才去问一次 GitHub 的
  最新 release（不自动联网、不在后台轮询）；有新版本时给出「打开下载页」，升级方式仍是上面那套手动覆盖。
- 自己签一个名（可选）：`pnpm sign:win` 会自动找 signtool、没有证书就在本机生成一份自签名证书并导出
  `release/deskpet-selfsigned.cer`。自签名只让「属性 → 数字签名」不再红，**消不掉** SmartScreen 首次提示；
  要彻底没提示得买代码签名证书。
- 校验下载：每个 release 都附 `SHA256SUMS.txt`。PowerShell 里
  `certutil -hashfile deskpet-0.1.0-x64.zip SHA256` 或
  `certutil -hashfile deskpet-0.1.0-x64-setup.exe SHA256` 的结果要与文件里对应行一致。
- 没有自动更新：新版手动下载；便携版确认旧数据不在程序目录后可直接覆盖或删除。

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

## 构建发布包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1
```

产物：

```text
release\deskpet-0.1.0-x64.zip
release\deskpet-0.1.0-x64-setup.exe
release\SHA256SUMS.txt
release\deskpet-0.1.0-release.json
```

便携 zip 根目录应包含 `deskpet.exe`、`使用说明.txt`、`resources/sidecar/sidecar.exe`、`resources/config/model-catalog.json`、`models/embedding/`（内置向量模型）。安装包使用同一份 `win-unpacked` 内容，不包含本机设置、API Key 或记忆数据。

打包后可选「本地自签名」（同机再跑一次即可，需要 Windows SDK 里的 `signtool`）：

```powershell
pnpm sign:win
```

首次运行会新建一张主题为 `CN=deskpet self-signed` 的证书并导出到
`release\deskpet-selfsigned.cer`，之后每个版本用同一张证书签，指纹不变。
自签名**不会**让 SmartScreen 的首次提示消失（那靠证书声誉）；它保证的是「这个 exe 确实是同一个人发的」，
用户把 `.cer` 装进「受信任的根证书颁发机构」后，属性页的数字签名也不再是红色。

国内网络首次构建可能需要镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 文档

- [v0.1.0 Release Notes](docs/RELEASE_v0.1.0.md)
- [人格验收用例](docs/PERSONA_CASES.md)
- [发布模板](docs/RELEASE_TEMPLATE.md) · [第三方许可](docs/THIRD_PARTY_NOTICES.md)
