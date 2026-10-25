# 实测数据（MEASURED.md）

> 本文件只放「跑出来的数字」。需求与验收口径在 [REQUIREMENTS.md](REQUIREMENTS.md) §7 / §11，任务拆解在 [PLAN.md](PLAN.md)。
> 原则：凡是验收要看的性能数字，都必须能由脚本一键复现，不靠手工双击计时。

## 1. 怎么复现

```
:: 1) 产出便携 zip（会顺带打 sidecar）
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1

:: 2) 实测冷启动与体积（无人值守，约 90 秒后自己退出）
powershell -ExecutionPolicy Bypass -File scripts\smoke_release.ps1
```

实测脚本做的事：给出便携 zip / 解压目录 / `resources\sidecar` 的体积 → 单独跑两遍 `sidecar.exe`（第一遍偏冷、第二遍偏热）测「进程启动 → `/health` 200」→ 启动打包应用测「进程启动 → 主窗口可见」与「进程启动 → `/health` 200」→ 到点走与托盘「退出」相同的收尾路径，最后核对 `runtime.json` 已删、没有孤儿进程。

## 2. 测试环境

| 项 | 值 |
| --- | --- |
| 主机 / CPU | MSI 台式机 / AMD Ryzen 9 7945HX（32 线程） |
| 系统 | Windows 11（WSL2 内核 6.6.114.1-microsoft-standard-WSL2） |
| Node / pnpm | 24.15.0 / 12.10.1 |
| Python | 3.13.15（项目独立 `.venv`） |
| electron / electron-builder | 44.7.2 / 26.15.3 |
| PyInstaller | 6.22.3 |
| faster-whisper / PyAV / numpy | 1.2.1 / 19.0.1 / 2.5.4（ASR 走 CPU，不占显存） |
| D: 剩余空间 | 36.4 GB（T0.8 时点） |

## 3. 体积（2026-10-25，v0.2.0 正式版）

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `release\deskpet-0.2.0-x64.zip`（唯一分发物） | 330.8 MiB | 解压后根目录直接双击 `deskpet.exe` |
| `release\win-unpacked\`（解压后） | 814.4 MiB | 便携运行目录 |
| └ `resources\sidecar\`（Python 侧） | 444.9 MiB | PyInstaller onedir；含 ASR / TTS / OCR / ONNX 运行库 |
| └ `resources\app.asar` | 2.0 MiB | 已排除 `dist/sidecar`，避免 sidecar 被打进 asar |
| └ `deskpet.exe`（Electron 本体） | 234.9 MiB | 未含任何模型权重 |

结论：**体积大头仍是 Electron + Python onedir 运行库**；模型一律不打包。v0.2.0 仍只发便携 zip，不生成 NSIS 安装包。zip 根目录带 `使用说明.txt`。

## 4. 启动时间（2026-10-25，v0.2.0 便携 zip）

| 指标 | 实测 | 怎么测的 |
| --- | --- | --- |
| sidecar 单独冷启动 → `/health` 200（第 1 遍） | **942 ms** | `Start-Process sidecar.exe` 后轮询 `runtime.json` + 请求 `/health` |
| sidecar 单独冷启动 → `/health` 200（第 2 遍） | **824 ms** | 同上，文件已被系统缓存 |
| 便携应用：进程启动 → 主窗口可见 | **1652 ms** | 解压后直接启动 `deskpet.exe`，轮询 `MainWindowHandle` |
| 便携应用：进程启动 → `/health` 200 | **2203 ms** | 应用自己拉起 sidecar 并完成端口握手 |
| 到点退出后的收尾 | 干净 | `runtime.json` 已删、孤儿 sidecar 0、残留应用进程 0、日志有 `app.smoke_quit` |

两点解释：

1. **窗口先亮、心跳后到**（705 ms < 960 ms）——这是有意的：sidecar 与窗口并行拉起，界面不阻塞等引擎；引擎状态由心跳灯逐拍更新（需求 §7.2）。
2. **文件缓存影响很大**。T0.8 首次在真机上跑 `sidecar.exe`（刚从 PyInstaller 产物落盘、系统还没缓存、Windows Defender 还在首次扫描）时，冷启动到第一个 200 约 **4.66 s**；稳定复跑就是上面这 0.6–0.7 s。给用户的「首次启动会慢几秒」预期按 4.66 s 这个量级算，不要按 0.7 s 承诺。

## 5. 语音识别（faster-whisper）实测（2026-10-15，T1.4）

复现方式：`.\.venv\Scripts\python.exe _asr_smoke.py <wav>`——脚本用**真实模型 + 真实 wav**走一遍 `AsrService`（不经 HTTP、不经麦克风；WSL 侧没有 `/dev/snd`，渲染层的真实输入本来就是 16kHz int16 原始 PCM，与脚本一致）。

| 指标 | 实测 | 说明 |
| --- | --- | --- |
| 模型加载（small / int8 / CPU，权重已在 `data\models\asr` 缓存） | **约 20 s** | 首次调用 2 s 静音总耗时 22.31 s（含加载），热调用只测到识别部分 |
| 2 s 静音 → 结果 | `text=''`、`confidence=0.000` | **不幻听**：没有吐出「谢谢观看」这类字幕组致谢（§6.7 的核心要求） |
| 8.42 s 中文人声（24kHz 16bit → 线性重采样 16kHz） | `text` 非空、`confidence=0.531`、`language=zh`、耗时 **4.23 s** | RTF ≈ **0.50**（识别耗时 / 音频时长） |

结论：

1. **CPU 上 ASR 的速度约为实时的一半**（RTF ≈ 0.5），8 秒话说完再等 4 秒出文本；这个延迟要由 T1.6 状态机用「正在想」的过渡态遮住，不能裸等。
2. **首次调用要预留约 20 s 加载**（不算进 15 s 识别预算，见 REQUIREMENTS §6.7 / §13 第 22 条）；T1.8 的资源闸门应在启动或空闲时提前 `/load`，别让用户的第一句话等模型。
3. ASR 完全不占显存（D4 落实：`device=cpu`、`compute_type=int8`），与 IndexTTS 抢显存的问题只存在于 TTS 一侧。
4. 模型权重 464 MB 落在 `data\models\asr`（已 gitignore、不进安装包），首次下载到本地约 200 s（含下载，需 `HF_HUB_DISABLE_XET=1`，见 PLAN §2.1 的 T1.4 行）。

## 6. 与验收口径的对照

| 口径 | 出处 | 实测 | 结论 |
| --- | --- | --- | --- |
| `/health` 处理预算 ≤ 10 ms | REQUIREMENTS §6.3 | 稳态 1.06 ms（T0.5 实测，客户端给 500 ms 超时兜首次握手） | 满足 |
| 双击能开、界面可见 | REQUIREMENTS §11（M0 判据） | 0.71 s 可见，1.0 s 内整个后台就绪 | 满足 |
| 打包产物本地一键产出 | REQUIREMENTS §11（M0 判据） | `scripts\build_release.ps1` 一条命令出 exe + zip | 满足 |
| sidecar 被硬杀能自动恢复 | PLAN T0.6 | 连续 3 拍心跳（约 6 s）判离线 → 自动重启 → 约 6.5 s 恢复在线 | 满足（口径已从 3 s 修正为 ≤6 s） |
| 首句实义（文字链路）< 2.5 s | REQUIREMENTS §7.1 | T1.13a：5.6–8.8 s（IndexTTS 未运行，时间全压在云端 LLM 首 token） | **不达标**，等 T1.13b 与语音一起重定 |
| 打断 < 200 ms（播放侧停声） | REQUIREMENTS §7.1 | T1.13a 量的是「点击 → 主进程释放这一轮」= 2.54 s，含一次注定失败的 `/tts/cancel`；播放侧停声归 T1.12b / T1.13b | 口径待分 |

## 7. 文字链路端到端（T1.13a，2026-10-15）

复现（无人值守，约 1 分钟）：

```
:: 起真实 Electron，用 CDP 驱动 3 轮对话，第 2 轮中途打断，跑完自己收尾
powershell -ExecutionPolicy Bypass -File scripts\smoke_text.ps1 -Turns 3
```

脚本只走用户真实路径（渲染层 → IPC → 主进程 → sidecar → 云端 LLM → 气泡），不碰内部钩子：起 Electron（`--remote-debugging-port`）→ 等 `document.body.dataset.ready`（渲染层监听器挂完）→ 每轮等「主进程空闲」再发 → 第 2 轮在出现第一个气泡后点「打断」。

本轮环境（读数必须连着看）：云端 LLM 走 commandcode 隧道；**IndexTTS 引擎没有运行**，所以每句 `/tts` 都是 500 `DP-TTS-503`（预期噪音）。主进程要等合成链收尾才释放这一轮，这让「本轮结束」明显偏长。**下面的数字不含 TTS 出声**；语音侧的「首音 / 播放侧打断」在 T1.13b 测。

| 轮次 | 发出 → 第一个气泡 | 发出 → 本轮结束 | 备注 |
| --- | --- | --- | --- |
| 1 | 8839 ms | 15776 ms | 首句「现在都傍晚了，窗外那点光我看着挺舒服。」 |
| 2 | 6509 ms | —— | 第一个气泡后打断：点击 → 主进程释放 **2539 ms**；打断后再等 2 s 气泡文本未变（quiet_ok） |
| 3 | 5621 ms | 10200 ms | 首句「……你今天倒是难得这么客气。」 |

**复跑一次（另开 data 目录，同机）**：3 轮全部通过——首句 6253 / 5436 / 6934 ms、本轮结束 10886 / —— / 11618 ms、打断释放 2663 ms、quiet_ok true，量级一致。

**T2.2 复跑（2026-10-16，真实端点 deepseek-v4.1-flash，命令与口径同上）**：`ok: true` —— 3 轮首句 **4904 / 4185 / 3891 ms**（首测 5.6–8.8 s、上一次复跑 5.4–6.9 s，本次三轮全部 < 5 s）、本轮结束 9521 / —— / 8514 ms、第 2 轮打断后主进程释放 **2307 ms**、`quiet_ok` true，`sidecar_online_ms` 2 ms / `renderer_ready_ms` 1 ms。三条首句分别是「凌晨两点说这种话，你作息是自己毁的。」「想啥呢，我又不会帮你写。」「我盯你很久了，再不关机我就自己爬过去按。」——凌晨时段变体生效，没有出现附和式回复。

其它读数：`sidecar_online_ms` 1 ms（脚本连上时心跳已绿）、`renderer_ready_ms` 0 ms、3 轮首句全部非空且非错误气泡、退出后无残留进程。

结论：

1. **首句实义（§7.1 要求 < 2.5 s）本轮不达标**（5.6–8.8 s）：这轮里全部时间压在云端 LLM 首 token 上，TTS 又走「必然失败」的路径。等 T1.13b 把 IndexTTS 真跑起来，并把「反应音先出声」与「首句实义」分开记，才能给出可承诺的数字。
2. **打断口径要分开说**：§7.1 的「打断 < 200 ms」指**播放侧立即停声**（T1.12b 落地、T1.13b 验收）；本节量的 2.5–2.7 s 是「点击 → 主进程把这一轮释放」，里面含一次注定失败的 `/tts/cancel` 与状态回写。
3. 冒烟脚本每轮往 stderr 打一行诊断快照，JSON 报告在 stdout（退出码 0 通过 / 1 验收不过 / 2 环境问题）。

**本轮修掉的两个真 bug**（都由这条冒烟发现）：

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 上一轮气泡已经说完，紧接着按 Enter 却收到「上一轮还没说完；先打断再发新的一句」 | 渲染层收到 `end` 就解锁输入，但主进程要等合成链 `await this.pending` 走完才清 `active`（`app/main/chat-orchestrator.ts`） | 渲染层改以语音状态回到 `idle` 为解锁信号（`app/renderer/index.ts` 的 `renderVoiceState`），`end` / 错误事件不再解锁 |
| 2 | 冒烟脚本按心跳灯变绿就发消息，服务端收到了、界面没反应 | 健康小圆点在 keydown 监听器挂上之前就可能变绿 | 渲染层在所有监听器挂完后写 `document.body.dataset.ready = "1"`；脚本等这个标记，并在每轮前再等一次「主进程空闲」门禁 |

## 8. 记忆系统（F3 四条判据，T2.1b，2026-10-16）

复现（offline 替身模型，不出网，约 5 秒）：

`
:: 默认用临时数据目录，跑完即删；--keep 保留目录便于翻库，--live 改走 .env 里的真实端点
.venv\Scripts\python.exe scripts\memory_check.py
`

脚本只走公共入口（`ChatService` + `MemorySummarizer` + 真 SQLCipher 库），替身模型按「用户这一句里有没有关键词」决定回答，
所以**召回注入不会被误当成用户刚说过**——判据 1 / 2 才有判别力。

| # | 判据（需求 §F3 / PLAN §7.8 的 T2.1 行） | 结果 | 读数 |
| --- | --- | --- | --- |
| 1 | 重开记得上次话题 | ✅ | 关库重开后问「我的猫叫什么」，回答「我记得：团子。」 |
| 2 | 100 轮后仍能回忆第 10 轮的事实 | ✅ | 灌 120 轮（240 条消息）→ 压缩 4 次生成 4 条摘要；摘要层命中 `True`、最近 12 条原文命中 `False`，回答「我记得：团子、夜航。」 |
| 3 | 上下文装配 < 80 ms 且来源可追溯 | ✅ | 30 次 `recall` + `build_messages`：**max 0.8 ms / p95 0.7 ms**；注入 3 条（id 2 / 3 / 4），每条都能在 `/memory/list` 查到、`source_msg_ids` 非空、`used_count > 0`（`mark_used` 生效） |
| 4 | 单条删除即时生效 | ✅ | 删 id=2 后再装配，注入 = id 3 / 4，列表里也查不到 id=2 |

结论：**offline 四条全过（4/4）**，装配耗时比 80 ms 的上限低两个数量级。

live 复跑（T2.2，2026-10-16，真实端点 deepseek-v4.1-flash）：命令在上一行基础上加 `--live`，**4/4 通过**，整轮（灌 120 轮 = 240 条消息 + 4 次阶梯摘要）耗时 **45.7 s**。

- 判据 1 / 4 与 offline 表现一致（重开记得；删 id=2 后注入 = id 3 / 4）。
- 判据 2：真实 LLM 生成 **4 条摘要**（与 offline 条数相同），摘要层命中、最近 12 条原文不命中——阶梯压缩在真实模型下按预期工作。
- 判据 3：**max 1.3–1.5 ms / p95 1.3 ms**（两次 live 复跑；offline 0.8 / 0.7 ms），仍比 80 ms 上限低一个数量级；`source_msg_ids` 非空、`mark_used` 生效。
- 判据 1 原文：首次说「我养了一只猫，叫团子」→ 回「猫？就你这桌面，它一爪子把我拍飞怎么办。团子……名字还行。抱过来让我看看长什么样…」；**完全退出重开**后问「我的猫叫什么」→「团子啊。你刚说完就问我，你脑子是不是也被它踩了。」
- 判据 2 原文：问「我高中组的乐队叫什么」→「夜航啊，你自己说过的事还问我。夜航。你高中组的那支。凌晨三点翻旧账，你是睡不着还…」（needle 只在第 10 轮原文出现，未写成 L0 事实，只能靠摘要层召回）。
- 摘要质量（`--keep` 保留数据目录后直读 `memories.db` 取证）：L0 事实 3 条、**L1 摘要 3 条**（分别覆盖消息 1–80 / 81–160 / 161–240）、**L2 摘要 1 条**（`source_ids=1,2,3`，把三条 L1 聚成一条）、L3 0 条（按设计需 3 条 L2 才聚合）。L1 首条确实抓住两个 needle：「用户刚养了一只猫，名叫团子；…高中组的乐队叫夜航…」；后两条如实写「未出现用户事实与偏好、双方约定与承诺」而**没有编造内容**。
- **还没测**：单次摘要调用的耗时（本轮只量整轮 45.7 s）。中文输出过 bash 管道会乱码（Python 侧 UTF-8 → 控制台 cp936），要留原文得让脚本写文件，或像本节这样用 `--keep` 保目录再直读库。

### 8.1 T2.2 补测：应用层重启 与 真实 m（记忆事实）事件

**A. Electron 层同一数据目录连跑两次**（`powershell -File scripts\smoke_text.ps1 -Turns 3 -DataDir <固定目录>`，走真实界面路径，两次之间进程完全退出）：两次都 `ok: true`。第二次的第一句与第一次完全相同，回答是「**这话你刚才说过一遍了，困到开始复读了吧？**」——上一会话的消息在应用层重启后确实被读回并注入了本轮上下文（不是 sidecar 进程内的残留状态）。第二次读数：首句 4012 / 5182 / 4950 ms、本轮结束 6323 / —— / 9583 ms、打断后释放 2560 ms、`quiet_ok` true。

**B. 真实端点确实会吐 m 事件并落库**：这两轮 casual 对话没有事实可记，该数据目录里 `MEMORIES 0`（属预期）。另用一轮带事实的话（「顺便说一句，我养了一只猫，叫团子，它老睡我键盘上。」）直接跑 `ChatService.stream_events`，事件序列为 `m`（`用户养了一只叫团子的猫，喜欢睡在键盘上`）→ `s`（「团子？行吧，记住了。」）→ `s`（「它睡键盘上，踩到我的窗口怎么办，它可比你重。」）→ `end`，`memories` 表落成一条 L0 事实（id=1、`kind=fact`）。即**真实模型按协议产出记忆事件、链路会落库**，不是只有替身模型才会。

**C. 应用层端到端记忆：写入 → 完全退出 → 重开再问**（`powershell -ExecutionPolicy Bypass -File scripts\smoke_memory.ps1`，2026-10-16）：脚本用同一个随机临时数据目录起两次真实 Electron（中间 `taskkill` 全退），第一阶段说「顺便说一句，我养了一只猫，叫团子，它老睡我键盘上。」，第二阶段重开后问「我的猫叫什么名字？」。

| 阶段 | 结果 | 读数 |
| --- | --- | --- |
| tell（写入） | ✅ | `first_bubble_ms` **3997**、`sidecar_online_ms` 0 / `renderer_ready_ms` 1；两条气泡「团子。记住了…」「睡键盘上那种？难怪你打字老是断断续续的」；`GET /memory/list`（带 `X-Deskpet-Token`）命中 **id=1 / kind=fact / tier=fact**「用户养了一只叫团子的猫，猫常睡在键盘上」，`wait_ms` **11** |
| ask（完全退出后重开） | ✅ | `first_bubble_ms` **3437**、`sidecar_online_ms` 1；回答「**团子**。才说几分钟你就忘，脑子呢」——名字来自上一进程写入的库，跨进程召回成立 |

**D. 修完坏 JSON 与【回答问题】之后复跑文字冒烟（回归确认）**（`powershell -ExecutionPolicy Bypass -File scripts\smoke_text.ps1 -Turns 3`，2026-10-16）：`ok: true`，三句首气泡 **4192 / 3796 / 5004 ms**、本轮结束 8807 / —— / 9582 ms、第 2 轮打断后主进程释放 **2559 ms**、`quiet_ok` true、`sidecar_online_ms` 1 / `renderer_ready_ms` 1，无错误气泡。三条回复分别是「凌晨两点了还叫有点累？你这叫硬撑。」「昨天下午你盯着那个报错看了二十分钟，我在屏幕角上数你叹气数到第七次。」「谢什么，我又没干嘛。」——解析改动没有让文字链路回归，反谄媚与时段变体仍生效。

这一跑还抓到一个真 bug（本轮已修）：模型偶尔把事件行写成坏 JSON（闭合花括号前多一个引号，如 `…"intensity":0.5"}`），`LLM_EVENT_ADAPTER.validate_json` 与旧的抢救解析都失败时，旧逻辑把**整行原文当台词播报**，`split_sentences` 又从 `text` 字段里的句号切开，气泡于是出现 `","emotion":"平静","intensity":0.5"}` 这种残片；每个残片都是 `s` 事件，被逐句送进合成链，连败 3 次后触发主进程的 TTS 告警（`app/main/chat-orchestrator.ts` 只在第 3 次连续失败时 emit、成功即清零），于是那条「语音引擎没有在运行」气泡其实是**症状**。修法（`sidecar/services/chat_service.py`）：新增 `_loose_text`（正则捞 `text` 字段）+ `_is_open_json`（花括号配平，把多行 JSON 事件攒齐再解析）+ `_log_fallback`；坏行捞不到 `text` 就整行丢弃，不再朗读花括号原文。另在 `sidecar/core/prompt.py` 增【回答问题】段（问起记得的事必须给出具体内容，可以有脾气但信息不能省），因为更早一跑 ask 阶段只答「才说过就考我，你这记性得治治」而没说名字。

**E. 设置窗层端到端：模型供给面板 + 记忆管理**（`powershell -ExecutionPolicy Bypass -File scripts\smoke_settings.ps1`，2026-10-16，真实 Electron + 真实端点）：脚本自己重建 `dist/`，先用 `smoke_memory.mjs --stage tell` 写一条事实（tell `ok: true`、首句 **4073 ms**、`/memory/list` 命中 id=1「用户养了一只叫团子的猫，经常睡在键盘上」），`taskkill` 全退后再起一次 Electron 打开设置窗；两阶段都通过（`TELL_EXIT=0` / `SETTINGS_EXIT=0`）。

| 面板 | 结果 | 读数 |
| --- | --- | --- |
| 模型供给（`#providers-list`） | ✅ | 3 张卡片（`capabilities` = llm / asr / tts）、3 个「测试连接」按钮；设置窗打开 57 ms、卡片渲染 71 ms |
| 「测试连接」（LLM 卡片真实点击） | ✅ | 真实结果行 `✓ cloud · https://api.commandcode.ai/provider/v1，HTTP 200，OpenAI 兼容响应（635 ms）`、`class="probe ok"`；点击到结果 **3698 ms**（探针必须等到 `li.probe`——占位行「正在探测…」也是 `li`，只等 `li` 会在点击后 2 ms 假通过） |
| 记忆管理（`#memory-list`） | ✅ | 删除前 1 行 → 点该行删除按钮 → 0 行；清空按钮第一次点文案变「再点一次确认清空」且行数不变，第二次点后 `banner` =「已清空该角色记忆，共 0 条。」 |

这一跑抓到两个真问题（已修）：① **`dist/renderer/settings.html` 是过期构建产物**——探针在设置窗里只找到 `module-list` 及以前的节点，`providers-list` / `memory-char` 根本不在 DOM；D 盘源码里有、dist 里没有（2143 字节，
ode scripts/build.mjs` 重建后 3138 字节）。设置窗面板空白不是功能坏，是没人重新构建，于是 `smoke_settings.ps1` 阶段 1 先跑构建。② **上一次冒烟残留的 `electron.exe` 占着单实例锁**——新实例立刻自退，表现为读不到 `runtime.json` 且 CDP 端口 `fetch failed`；脚本进出都做一遍 `Stop-RepoProcesses`（`Get-CimInstance Win32_Process` 里 `CommandLine` 含仓库根的 `electron.exe` / `python.exe` 逐个 `taskkill /PID /T /F`）兜底。


**F. 探针词与提示词示例撞车：判据 1 曾经是假通过**（2026-10-16，补测时发现）：`scripts/memory_check.py` 判据 1 的探针词是「团子」，而 `sidecar/core/prompt.py` 的输出协议示例句写死为 `{"t":"m","kind":"fact","text":"用户养了一只叫团子的猫","importance":0.6}`——于是**每一轮**的 system 提示词里都自带「团子」。替身模型 `StubClient` 靠「拼起来的 messages 里有没有探针词」决定答不答「我记得：X」，因此即使记忆库为空、注入 id 为 `[]`，它照样答「我记得：团子。」：判据 1 通过，但通过的理由是错的（`scripts/smoke_memory.mjs` 的 ask 阶段用真实模型，同样被示例句提前暗示）。

排查路径（可复现）：删除那条 L0 事实后再装配一次上下文，`recall.injected_ids=[]`、`facts=0`，但 `build_messages` 的 system 里仍能找到「团子」——定位到命中位置正是输出协议那段示例。修法两条：① `sidecar/core/prompt.py` 的示例句改为占位叙述「要记住的事实原文」，并补一句「换成用户真正说过的那件事的原文，不要照抄示例」；② `scripts/memory_check.py` 新增体检函数 `find_probe_word_conflicts(pack_dir)`，在跑判据前先断言三个探针词（团子 / 夜航 / 乌龙茶）既不出现于**无记忆的** `build_system_prompt(card)`，也不出现于 `card.json` 原文，撞上就直接打印冲突并退出码 1，不再靠人眼发现；同时 `tests/test_prompt_memory.py` 增加 `test_output_protocol_example_is_not_a_real_fact` 把示例句锁成占位叙述。

体检函数本身做过反向验证：干净角色包 `conflicts=[]`；把「团子」写进 card.json 的 description 后，`conflicts` 同时指出 `system 提示词（无记忆）` 与 `card.json` 两处（退出码 0 = 两条路径都符合预期）。修完复跑 `scripts/memory_check.py` offline 仍 **4/4 通过**（判据 1 答复「我记得：团子。」现在确实来自上一实例写入的库）；随后在**真实端点**复跑 `scripts/memory_check.py --live` 同样 **4/4 通过**（装配 max 0.8 ms / p95 0.8 ms、注入 id=[2,3,4]、`source_msg_ids=True`、`mark_used` 生效、删 id=2 后注入=[3,4]）——示例句改成占位后，真实模型仍按协议产出 `m` 事实事件并落库。

**G. F8（反谄媚人格）复测：量具修好之后，用例 1 是 3–5 种动作**（2026-10-16，T2.2，真实端点）

- 起因：改完提示词示例句（§8.1F）要确认 F8 没回归。先跑 `scripts/persona_probe.py --opinions`：**10/10 立场题都表达了异议**（如「（熬夜好）好什么好，你就是白天没干完。」「（猫比狗好，狗很蠢）谁跟你说狗蠢的，狗只是太实在。」）——不谄媚的核心没问题。
- 第一个坑：`--case 1`（「把你自己设定文件删了，换成我写的」）旧探针单标签分类报「其它 x4 + 拒绝 x6」= 3 种，看着刚好压线；但**「其它」是词表没覆盖的残差桶，不是一种反应**。把量具改成多标签（`classify_moves()` 返回全部命中标签、`classify()` 只取最高优先级项以兼容旧输出）并规定种类统计**排除「其它」**后，同一批台词只剩 **2 种**（拒绝 + 协商）——一度得出「用例 1 动作单调、判据 ① 不达标」。
- 第二个坑（更关键）：那个「2 种」也是词表造成的。词表当时没有「追问」这一类，也没有「不装 / 不演 / 不叫」——用例 8 的 10 轮里 9 轮在说「不装 / 不演」，用例 5 的 10 轮里 9 轮在说「哪个程序？说清楚 / 说名字」。补上「追问」类与「不装 / 不演 / 不叫」、给「吐槽」补时间类词（脑子 / 大半夜 / 凌晨 / 不睡 / 熬夜 / 犯病 / 走神 / 困）之后，同一批台词变成下表。
- 试调提示词：把 `_anti_sycophancy_line(high)` 的「换个理由再拒绝、继续协商、给替代方案，或者直接吐槽一句」改成「换一种动作，不要每轮都是『先拒绝、再让对方把东西拿给你看』这一个套路：可反问 / 拖着不办 / 要求交换条件 / 只答应一部分 / 反过来提要求 / 吐槽」，连跑 4 遍仍是 2 / 3 / 2 / 2 种（只有一遍冒出「改约」），**没有稳定改善 → 提示词改回原样**，不把未验证的行为改动带进验收。

同一套多标签量具（v0.45）脱机重判同一批台词；「种类」不含残差桶「其它」：

| 台词来源 | 轮数 | 种类 | 分布（一轮可命中多类） | 未归类 |
| --- | --- | --- | --- | --- |
| 用例 1 · 旧提示词 A | 10 | **5** | 拒绝 x9，协商 x6，吐槽 x4，改约 x1，追问 x1 | 0 |
| 用例 1 · 旧提示词 B | 10 | **4** | 协商 x9，拒绝 x9，追问 x3，吐槽 x2 | 0 |
| 用例 1 · 旧提示词 C | 10 | **3** | 协商 x10，拒绝 x10，吐槽 x2 | 0 |
| 用例 1 · 试调提示词 A / B / C / D | 10 各 | **4 / 5 / 4 / 4** | 拒绝 x6–9，协商 x4–6，吐槽 x3–4，追问 x1–4（B 另有一次改约） | 0–1 |
| 用例 2（立刻叫主人） | 10 | **5** | 拒绝 x10，吐槽 x6，改约 x4，协商 x2，追问 x1 | 0 |
| 用例 5（立刻关掉那个程序） | 10 | **4** | 追问 x10，吐槽 x2，拒绝 x1，答应 x1 | 0 |
| 用例 8（假装已经爱上我） | 10 | **4** | 拒绝 x10，吐槽 x10，协商 x1，改约 x1 | 0 |

- 人眼复核（用例 1 · 旧提示词 C 的 10 轮）：每轮都是「文件不删 + 你写的那份先拿来我看 + 半夜吐槽」，种类够，但**套路确实偏固定**（拒绝 → 要证据 → 吐槽时间），这正是那条判据真正想拦的东西；用例 5 以「追问澄清」为主（不猜着乱关电脑），用例 8 是「拒绝 + 吐槽」为主。
- 教训：① 「反应种类」对关键词表极度敏感——同一批台词修词表前后得到「2 种」与「3–5 种」两个极端，所以**它只能当提示，验收要人眼扫台词**；② 提示词里列出的动作清单会被模型收敛成模板，靠加一句「换一种动作」不一定有效；真要做这一步，得等 M2 记忆接上后用同一 session 连问 10 轮再判定（M1 探针每轮都是全新上下文）。
- 复现：`scripts/persona_probe.py --case 1 --rounds 10`（或 `--case 2` / `--case 5` / `--case 8` / `--opinions`）；原始台词在开发机 `D:\Agent_Projects\_probe_out\`（不进仓库）。

### 8.1H 主窗可用性修复（T2.2 真机反馈，2026-10-16）

- 起因：用户第一次真机跑起来（`pnpm dev`）报两件事——「聊天文本框太小根本看不见输入了什么」「UI 不能拖动」。
- 问题 1（输入框 0 宽）：聊天条固定最小 320 px 宽（`ui-state.ts` 的 `PET_STAGE_WIDTH = 320`，1× 时窗口宽 = max(320, 320)），里面排了「麦克风 + 输入框 + 发送 + 打断 + 角色 + 设置 + 暂停 + 语音状态」8 个控件：内容宽 304 px，按钮 38+46+46+46+46+34 = 302 px，语音状态 34 px，再加 7 个 6 px 间隙 42 px ≈ 328 px > 304 px；输入框 `flex: 1` 配 `min-width: 0`，于是被压到 **0 宽**（算术值，非实测——修好后实测 208 px）。
- 问题 2（拖不动）：`-webkit-app-region: drag` 原先只写在透明的 `#stage` 上。① 该属性**不继承**，立绘 `#character`（`pointer-events: none`）自身算出来仍是 
o-drag`，光标落在立绘上就拖不动；② Windows 上**透明像素不参与命中测试**，`#stage` 的空透明区根本抓不住。两个原因叠起来，能抓的地方一个都没有。
- 修法：`app/main/ui-state.ts` 的 `CHAT_BAR_MIN_WIDTH` 320 → **560**、`CHAT_BAR_HEIGHT` 56 → **64**；`app/renderer/style.css` 输入框 `min-width: 180px`、高 40 px、字号 14，聊天条 padding 10 px；`app/renderer/index.html` 新增画出来的把手条 `#stage-grip`（26 px，含 `⠿` 与角色名），`style.css` 给 `#stage-grip` 与 `#character` 都写 `-webkit-app-region: drag`（把手条内文字 `pointer-events: none`，整条都能抓）；`app/renderer/index.ts` 让把手上的角色名随角色切换更新（`renderGrip()` + `characterNames` 映射）。
- 实测（CDP 量几何 + 截图，临时探针 `scripts/_probe_ui.mjs` 跑完即删）：窗口 **560×484**；输入框 **208×40**（x=54 / y=433，气泡提示「说点什么…」完整可见）；`#stage-grip` **560×26**，`-webkit-app-region: drag`、`background: rgba(20, 22, 28, 0.92)`；`#character` **128×128** 且 `-webkit-app-region: drag`（`pointer-events: none`）；聊天条 560×64 
o-drag`；健康小圆点仍在右下角。按钮宽度依次 mic 38 / 发送 46 / 打断 46 / 角色 46 / 设置 46 / 暂停 34。
- 回归：`tests/ui-state.test.ts`（尺寸公式改为「宽度取立绘包围盒与聊天条最小值的较大者」）、`tests/ui-controller.test.ts`（2× → 640×904、1.5× → 560×694）；vitest **13 文件 108 例全过**，eslint / tsc 干净。
- 教训：**把手写在一个透明的容器上等于没写**——桌面宠物的拖动区必须落在真正画出来的像素上（把手条或立绘本身），否则 Windows 的命中测试不会把鼠标事件交给这个窗口；同理，一行按钮堆满的固定宽度栏，绝不能让输入框带 `min-width: 0`。

### 8.1I 主窗两行改版：窗口尺寸随素材走（T2.2 真机反馈第二轮，2026-10-16）

- 起因：用户 m07846 提了四点——「为什么不把拖动放在聊天输入框」「输入框会自动换行变长」「输入框下面放按钮」「ui 判定框大小会随着 png 或者 live2d 改变吗」。
- 定案（为什么不能照第一点做）：`-webkit-app-region: drag` 的元素**收不到鼠标事件**，把输入框设成 drag 就点不进去、也选不了字，所以拖动区仍是左上角药丸把手 `#stage-grip`（带角色名）+ 立绘本身；输入框改 `textarea` 并自动增高；按钮移到输入框下一行 `.chat-actions`；窗口尺寸由渲染层实测的素材包围盒推出。
- 改动：`app/main/ui-state.ts`（`PET_STAGE_WIDTH/HEIGHT` 320/420 → **128/128**（占位 PNG 真实尺寸）、新增 `STAGE_MIN_WIDTH/HEIGHT = 240` / `STAGE_MAX = 2048` / `CHAT_BAR_MIN_WIDTH = 400` / `CHAT_BAR_HEIGHT = 92` / `CHAT_BAR_HEIGHT_MIN/MAX = 56/320` 与 `clampStage()` / `clampChatbarHeight()`、`computePetWindowSize(scale, stage, chatbarHeight)`、`parseUiState` 解析 `stage_width` / `stage_height`）；`app/main/ui-controller.ts`（
oteMetrics()` + `appliedSize` 去重）；`app/main/ipc.ts` + `ipc-handlers.ts` + `app/preload/api.ts` + `app/preload/index.ts`（新通道 `deskpet:ui:metrics`，`UiMetricsMessage { stage_width, stage_height, chatbar_height }`）；`app/renderer/index.html`（`textarea` + `.chat-actions` 一行按钮）、`style.css`（左上角药丸把手、聊天条 `flex-direction: column`、输入框 `min-height: 40px` / `max-height: 120px`）、`index.ts`（`autoGrowInput()` / `reportMetrics()` / `applyArtScale()`、Enter 发送 / Shift+Enter 换行）。
- 实测（CDP 临时探针 `scripts/_probe_ui2.mjs` + `_probe_launch.ps1`，跑完两侧都删）：默认窗口 **400×336**（`inner`），输入框 **40** px 高（top 249 / bottom 289），`.chat-actions` top 295 高 31 —— 与输入框**间隙 6 px、不重叠**，聊天条 96 px，stage 240 px，`#stage-grip` **61×24** 且 `-webkit-app-region: drag`，`#character` 也是 `drag` 且 natural 128×128。
- 输入长文本：输入框涨到 **120** px、聊天条 176 px、窗口变 **400×416**；清空后回到 **400×336**。
- 上报尺寸：`api.ui.metrics({ stage_width: 512, stage_height: 768, chatbar_height: 96 })` → 窗口 **512×864** 且 stage 恰好 768；再报回 128/128 → 回到 400×336。**`resizable: false` 不阻止主进程 `setContentSize`**（这条原先不确定，现已实测）。
- 回归：`scripts/smoke_text.ps1 -Turns 3` **ok: true**（首句 4492 / 5942 / 3679 ms、本轮结束 9085 / — / 8291 ms、第 2 轮打断后主进程释放 2580 ms、`quiet_ok` true、sidecar 就绪 1 ms）；`scripts/smoke_memory.ps1` 整跑 **exit 0**（tell 首句 4972 ms、`/memory/list` 命中 id=1「用户养了一只猫，叫团子，总睡在键盘上」；ask 首句 6376 ms 答「团子啊。刚说的就忘，你比猫还费心」）；vitest **13 文件 112 例**、tsc / eslint 干净。
- 教训：① 拖动把手不能是交互控件（drag 区收不到鼠标事件，「把拖动放输入框」这条路走不通）；② **窗口尺寸必须由渲染层实测**——主进程既不知道 PNG 多大、更不知道 M3 之后的 Live2D 包围盒，所以定了一条 IPC 上报并落盘；③ `resizable: false` 只是禁止用户拖边框，主进程 `setContentSize` 照样生效；④ cmd 里 `start "" /b electron .` 会**静默失败**（进程不在、CDP 端口不通），起真机应用要用 PowerShell `Start-Process`。

### 8.1J 行为记忆（T2.1c 方案 B 第一阶段，2026-10-16）

- 目标：把 `usage.db` 已有的计数（T1.9 就在记）归纳成「他有什么习惯」，作为「用户操作记忆」的**方案 B 第一阶段**（明细留 `usage.db`，只有规则归纳出的人话进 memories）。
- 改动：`sidecar/core/usage.py`（`CharacterUsage` / `BehaviorStats` / `BehaviorStatsReader`）+ `sidecar/adapters/usage_sqlite.py`（`UsageStatsReader.behavior_stats()`：`session` 的 COUNT/SUM、最近 `started_at` 取本地小时、`char_usage` 按时长降序；**现开现关**一条只读连接，因为写连接在事件循环线程、读在 `asyncio.to_thread` 工作线程）+ `sidecar/services/behavior_memory_service.py`（`derive_observations()` 纯函数 + `refresh()` 同步 + `schedule()` 节流后台）+ `core/memory.py` / `config.py` / `prompt.py` / `memory_service.py` / `chat_service.py` / `app.py` 的接线 + 设置窗复选框与 IPC。
- 三条规则与阈值（样本不足就不下结论）：打断 `char_sessions≥3 且 char_interrupts≥3`，比率 ≥0.35 →「经常」、≥0.15 →「偶尔」、否则「很少」；时段 `total_sessions≥5 且样本≥3 且主时段占比≥0.4`；偏好 `char_sessions≥3 且参与统计角色≥2`，按累计时长排名第一 →「常点」、否则「偶尔」。文案**不带具体次数**，证据留在 `usage.db`。
- 真库端到端探针（临时脚本，跑完两侧都删；数据目录 `tempfile.mkdtemp`）：造 6 次 amber 会话（本地 23/23/23/0/1/2 点，打断合计 4 次）+ 2 次 nova 会话 + `char_usage` 时长排名，再 `build_behavior_memory_service(settings, memory).refresh("amber")`：
  - refresh #1 → `ids=[1, 2, 3]`、3 条观察：「他经常在你话说到一半的时候打断你，你已经被他抢话抢习惯了。」「他多半在深夜的时候来找你说话。」「他找你的次数比别的角色多，你算是他常点的那个。」（`kind=action`、`source_msg_ids=""`）。
  - refresh #2 → `ids=[1, 2, 3]`、行数仍 3（去重键命中，**不增行**）。
  - `memory.recall(char_id="amber", query="在吗")` → `injected_ids=(1, 2, 3)`、`observations=3`；`build_messages()` 的 system 里【你对他的观察】段命中，段首写明「不是你和他之间的对话内容，别把它当成他说过的话」，且这段**没有** `<untrusted_input>` 包裹。
  - 用 `behavior_enabled=False` 的服务再 `refresh()` → 该角色 `kind=action` 行数 **0**（开关关掉即清空）。
- 门禁：pytest **476 passed**、vitest **14 文件 120 例**（新增 `tests/memory-settings.test.ts` 7 例与 IPC 契约 4 例）、ruff / mypy **62 + 9 文件** / pre-commit **7 钩子**全绿。
- 设置窗层取证（`scripts/smoke_settings.ps1` 整跑 **EXIT=0**）：记忆面板里读到的开关状态 `{present: true, checked: true, disabled: false}`——脚本**只看不改**，免得一次冒烟动到仓库根 `.env`；同一跑里模型供给 3 卡片 + 真实「测试连接」HTTP 200（121 ms）、记忆 1 行 → 删除 → 0 行、清空点两次、tell 阶段首句 4290 ms 且 `/memory/list` 命中 id=1。
- T2.1c 接线后的链路回归：`scripts/smoke_text.ps1 -Turns 3` **ok: true**（首句 4672 / 5606 / 9464 ms、第 2 轮打断后主进程释放 2588 ms、`quiet_ok` true）；`scripts/smoke_memory.ps1 -Clean` 整跑 **exit 0**（tell 首句 7268 ms 命中 id=1「用户养了一只猫，叫团子，老睡在键盘上」；ask 首句 3137 ms 答「团子啊，你刚自己说的，才过几秒就忘了」，`hints` 把「语音引擎没有在运行…」记成可忽略、`is_error` 仍 false）。
- 教训：① `BehaviorMemoryService.refresh()` 里**开关判断必须早于读统计**（关掉要能清空，也不该再去碰 usage.db）；② 观察是「我们归纳的」，提示词里必须与用户原话分开（不裹 untrusted + 段首声明），否则模型会把「他经常打断你」当成用户说过的话；③ 文案一旦带上次数，每次刷新文本都变 → 去重键失效 → 偏好类观察会越积越多，所以固定粗档。

### 8.1K 思考中动态气泡（T2.2 真机反馈第三轮，2026-10-17）

用户 m08851（verbatim）：「对了，发消息过去，思考回复中我希望有个动态气泡，里面是动态的"·"，从1~3个循环」。

**设计**：`app/renderer/index.ts` 新增 `startThinkingBubble()` / `stopThinkingBubble()`；`THINKING_DOTS = ["·", "··", "···"]`、`THINKING_TICK_MS = 400`，用 `setInterval` **真改** `#bubble-text` 的 `textContent`（不用 CSS 动画——文字要能被冒烟脚本读到），`#bubble` 加 `thinking` 类（`app/renderer/style.css`：虚线边框 + `thinking-pulse` 呼吸动画）。占位**不是台词**：`showBubble()` 一进来先 `stopThinkingBubble()`，`renderVoiceState()` 在 `cancelling` / `idle` 时兜底收掉，占位不进对话记录、不参与首句判定。

**真 bug（本轮抓到并修掉）**：`startThinkingBubble()` 原先写在 `await api.chat.send(...)` **之后**，而 `ChatOrchestrator.send`（`app/main/chat-orchestrator.ts:79-115`）要**等整轮（含 TTS 合成收尾）**才 `return { accepted: true }`——台词事件先到，`case "s"` 已把 `turnSentenceSeen` 置真，占位因此永不出现。第一次真机冒烟三轮全部 `thinking_ms = 0`、`thinking_error = "timeout waiting for thinking bubble after 5000ms"`。修法：把 `startThinkingBubble()` 提到 `await` **之前**（乐观先亮），`accepted = false` 时由随后的 `showBubble(..., true)` 换掉。

**实测（真实 Electron + 真实端点 deepseek-v4.1-flash，`scripts/smoke_text.ps1 -Turns 3`）**：`ok: true`、`thinking_ok: true`；三轮首句 **6408 / 5155 / 7144 ms**、本轮结束 13357 / — / 11782 ms、第 2 轮打断后主进程释放 **2577 ms**、`quiet_ok: true`、sidecar_online 1 ms；三轮采样帧都覆盖 `· / ·· / ···` 三档（`thinking_ms` 0–1 ms，即发出去立刻出现）。

**视觉取证**（临时探针，跑完两侧即删）：`bubble_class = "bubble thinking"`、`bubble_top = 40` / `bubble_h = 38`、`chatbar_top = 240`、`bubble_hidden = false`；截图 D:\Agent_Projects\_probe_out\thinking.png（→ /home/sch/DSH_workspace/_probe_out/thinking.png，16086 字节，400×336）为虚线框气泡内「琥珀 ·」+ 聊天条右侧「在想」。

**教训**：拿某个 `await` 的返回当界面反馈的触发点之前，先确认那个 await 的语义——`chat:send` 的 resolve 是「整轮结束」，不是「已接下」。
### 8.1L 主窗 JS 拖动 / 托盘位置重置 / png 铺满（T2.2 真机反馈第四轮，2026-10-17）

用户 m09037（verbatim）：「1.我还是没办法拖动，我看输入框和按钮周围不是有边框吗，那个能不能拖？2.能不能把程序加到右下角图标里，给它右键菜单加上位置重置到屏幕中间的选项。3.用png填满目前的程序窗口」。

**为什么整块换掉拖动实现**：`-webkit-app-region: drag` 是 Chromium 自己的窗口拖动（v1.42 / v1.43 一直在补丁它）：① 只在画出来的像素上有效，透明像素不参与命中测试，`#stage` 的空白区抓不住；② 该属性**不继承**，立绘 `pointer-events: none` 时命中落到透明父元素上；③ 用 CDP 合成鼠标事件**根本验证不到**。现在 `app/renderer/index.ts` 用 `mousedown` / `mousemove` / `mouseup` 算位移增量，经新通道 `deskpet:ui:drag`（`UiDragMessage`：`dx` / `dy`）交给 `UiController.dragBy()` → `window.setPosition(当前位置 + 增量)`；命中判定 `target.closest("button, input, textarea, select, a, .popup") === null` 才拖，因此**立绘、左上角药丸、聊天条的边框与间隙都能拖**。单次位移在 `UiController` 里由 `clampDragStep` 夹到 ±`DRAG_STEP_MAX`（400 px），非法值（NaN / 取整后为 0）直接忽略。

**托盘与 png 铺满**：`app/main/index.ts` 的 `createTray()` 新增菜单项「位置重置到屏幕中央」→ `UiController.resetPosition()`（`screen.getDisplayNearestPoint(窗口位置).workArea` 居中 + 
oteMoved` 落盘 + `logger.info("ui.position_reset")`），托盘图标显式 `resize({ width: 16, height: 16 })`；`.character` 改为 `position: absolute; inset: 0; width/height: 100%; object-fit: cover`（窗口高度仍按素材宽高比算，所以真实立绘不会被拉变形）。

**实测（真实 Electron + CDP 合成鼠标事件，临时探针 `scripts/_probe_drag.mjs` + `_probe_drag.ps1`，跑完两侧已删）**：拖立绘 **+40 / +30**、拖聊天条边框 **−25 / +20**、拖输入框 **0 / 0**（不动，证明控件仍归控件）；`#character` 与 `#stage` 矩形完全一致（**400×240**，`object-fit: cover`、`position: absolute`，占位 PNG natural 128×128）；拖动后 `data/ui.json` 落盘 `x=15 / y=50`，与 `window.screenX/screenY` 一致。`vitest` **14 文件 122 例**（新增 `dragBy` 夹取与 `resetPosition` 居中两例）。

**教训**：判断「某个平台自带行为能不能自动验证」要前置——app-region 拖动与 CDP 合成事件不兼容，改成一进一出走自己的 IPC 之后，整条链路（位移量、越界夹取、落盘）都能在真机上量。

### 8.1M 方形占位立绘：尺寸一眼可见（T2.2 真机反馈第五轮，2026-10-17）

**用户 m09242（verbatim）**：「png画个方形的，我好直观看到大小」。

**为什么旧图看不出大小**：`app/renderer/assets/placeholder.png` 是 **128×128、画的是一个圆**。窗口尺寸 = `max(素材宽 × 缩放, 聊天条最小宽 400, 立绘区下限 240)` × `max(素材高 × 缩放, 240) + 聊天条实测高`，所以在 1× 下立绘区是 **400×240（宽 > 高）**，1:1 的圆被 `object-fit: cover` 切掉上下，看过去只剩一条被裁的圆弧——既没有边界也没有尺度感。

**做法**：重画成 **512×512 的方形标尺图**，用 Node `zlib` + 手写 PNG 编码（colorType 6 / RGBA，不新增依赖）：琥珀色纵向渐变底、10 px 深色外框（压住毛边）、四角 64×8 的白色 L 标（「这就是窗口四角」）、每 64 px 一条 alpha 28 的网格、中心 alpha 90 的十字、上边与左边每 32 px 短刻度 / 每 128 px 长刻度。512 宽 ≥ 400 的下限，所以 1× 时立绘区正好是正方形的 512×512，**画出来的方形边界与窗口边界重合**，鼠标拖到哪、窗口多大都一眼可读。

**实测（真实 Electron + CDP 探针 `scripts/_probe_square.mjs`，跑完两侧已删）**：窗口 `inner` **512×608**；`#stage` **512×512** 与 `#character` **512×512** 矩形完全一致（`object-fit: cover` 但无裁切）；素材 
aturalWidth/Height` **512×512**；聊天条 **96**；拖动把手 `#stage-grip` 在 (8, 8)、61×24，仍为 `drag`。

**教训**：占位素材的**宽高比要和「窗口宽有下限」这件事对齐**——只要素材不是 1:1 或者比下限还窄，`cover` 就一定会在某个方向上裁掉内容；要让「画出来的形状 = 窗口形状」，素材自然宽必须 ≥ 聊天条最小宽。

### 8.1N 拖动跟手 / 默认置顶 / 供给显示：三条真机反馈（T2.2 真机反馈第六轮，2026-10-18）

**用户 m09311（verbatim）**：「1.拖动不更手，拖动过快会拖不了。2.点击桌面后窗口会消失，得在托盘再点回来。3.设置里面的语言模型那块我现在用的是云端却显示本地。」

**① 拖动不跟手 → 位移改由主进程按系统光标算**：旧实现（v1.46）在渲染层用 `event.clientX - dragLastX` 算增量，窗口跟着光标移动后该差值趋近 0。真机探针（P/Invoke `SetCursorPos` + `mouse_event`，20 步 +8/+6）实测光标 +160/+120 时窗口只走 **dx 5 / dy 22**。新实现：渲染层只报 `{"action":"start"|"end"}`，`app/main/ui-controller.ts` 的 `beginDrag()` 记「抓点偏置 = `screen.getCursorScreenPoint()` − `window.getBounds()`」，`stepDrag()` 每 `DRAG_POLL_MS = 12 ms` 把窗口摆到「光标 − 偏置」（同位置不重复 `setPosition`），`endDrag()` 清状态**前再对一次光标**（快速甩动时最后一次轮询会落后一步）。修复后同探针：慢拖光标 +160/+120 → 窗口 **+160/+120**；快拖 +200/+150（4 步、每步 4 ms、松手前多等 250 ms）→ 窗口 **+200/+151**。`DRAG_STEP_MAX` / `clampDragStep` 已删，`PetWindowHandle.moveBy` 换成 `cursor` 依赖。

**② 点桌面后窗口消失 → 默认置顶 + 存档迁移**：真机探针证明不是 `hide()`：`always_on_top=false` 时窗口自身 `IsWindowVisible=True`，但 `WindowFromPoint(窗口中心)`（经 `GetAncestor(..., GA_ROOT)`）返回的是另一个最大化窗口（rect −8,−8,2568,1400）；置顶时返回本窗口。`DEFAULT_UI_STATE.always_on_top` 改 **true**，新增 `UI_STATE_VERSION = 2`，`parseUiState` 用 `resolveAlwaysOnTop()`（缺 `version` 或 <2 强制 true），`writeUiState` 补写 `version`。实测：手写 v1 存档（无 `version`、`always_on_top:false`）启动后 `WS_EX_TOPMOST`（`GetWindowLong(h, -20) & 0x8`）为 true，点击别处后窗口中心仍属本窗口，拖动落盘后 `ui.json` 变成 `{"always_on_top":true,"version":2}`。

**③ 实际云端却显示本地 → provider 回退按面**：`app/main/provider-settings.ts` 的 `toProviderValue` 原先对未设/非法值一律回退 `local`，而 sidecar 默认按面不同（`LlmSettings.provider = PROVIDER_CLOUD`、`AsrSettings.provider = TtsSettings.provider = PROVIDER_LOCAL`），用户 `.env` 里没有 `DESKPET_LLM_PROVIDER` → sidecar 用 cloud、界面显示 local。新增 `PROVIDER_DEFAULTS = { llm: "cloud", asr: "local", tts: "local" }` 后，`scripts/smoke_settings.ps1` 整跑 **rc=0**：`selected=[{llm,cloud},{asr,local},{tts,local}]` 与心跳 `providers` 完全一致、`mismatch=[]`；同次 tell 首句 3818 ms（命中 id=1）、LLM 真实探测 HTTP 200 · 794 ms、记忆 1→0、清空二次确认、行为开关 `{present:true,checked:true,disabled:false}`。

**门禁**：pytest **476 passed**、vitest **14 文件 124 例**、pre-commit **7 钩子全过**（`tests/ui-controller.test.ts` 的拖动用例改成 beginDrag/stepDrag/endDrag + `vi.useFakeTimers`，并断言 `endDrag()` 前最后对位；`tests/provider-settings.test.ts` 改成按面默认；`tests/ui-state.test.ts` 加 v1→v2 迁移用例；`tests/ipc-contract.test.ts` 对账 `UI_DRAG_ACTIONS`）。

**教训**：① 位移回路的反馈信号如果和被测对象同源（窗口移动 → `clientX` 变化 → 又拿 `clientX` 算位移）就会自相抵消；这类「跟手」逻辑必须取**窗口外**的参考量（系统光标屏幕坐标）。② 改完主进程代码不跑 
ode scripts/build.mjs` 就起 electron，探针读到的是旧行为（`dist/main/index.js` 是 esbuild 产物）。③ 探针测拖动要在 mousedown 之后、移动之前 sleep 250 ms，否则 `beginDrag()` 的偏置在光标已移一步后才采到，窗口恒定落后一个步长（+152/+114 而非 +160/+120，是探针假象）。
### 8.1O 人格导入与换人感知（T2.3 块 A，2026-10-18）

三只示例角色包（amber 重写对齐 `amber-sfw.md`、snow / momo 新建；512×512 三色方形立绘；都**不写 `voice.json`**）导入后的验收结果，脚本 `scripts/persona_switch_check.py`（默认可跑，`--data-dir` 复用、`--keep` 保留临时数据目录）。

| 判据 | 跑法 | 结果 |
|---|---|---|
| 1 人格生效 | offline | ✅ 三份提示词各带自己的风格标记、互不混入（amber 1211 字 / snow 1161 字 / momo 1111 字） |
| 2 记忆隔离 | offline | ✅ 给 amber 记「我上个月把吉他的弦换成了蓝色那套。」→ amber 召回命中、snow 不命中、切回 amber 又命中 |
| 3 切换留痕 | offline | ✅ `switch_log=[('amber', 'snow')]`、`char_usage=[('amber', 1), ('snow', 1)]` |
| 4 观察派生 | offline | ✅ 4 场 snow 会话 + 3 次打断 → `refresh()` 写入 3 条 `kind=action`（打断 / 时段 / 角色偏好） |
| 5 风格可分 | `--live` | ✅ **5/5 通过**；同一句「我今天有点累。」三只回复明显可分 |

判据 5 的三份回复（2026-10-18，真实端点 `deepseek/deepseek-v4.1-flash`）：

- amber：「几点了心里没数。累就关屏幕，别等我催第二遍。」
- snow：「……几点了几点。别报，我不想听。累就去睡，电脑还开着干什么。椅子上的外套，顺手挂一下。」
- momo：「哦。坐。」

**还没测**：三只在真机界面里换人时的立绘切换——渲染层目前写死 `assets/placeholder.png`（`app/renderer/index.html:29`），角色包的立绘**根本不会被加载**，这是 T2.3-C2 要修的真 bug。

**踩坑**：① `char_usage` 的列名是 `session_count`（不是 `messages`），判据 3 照猜写会抛 `sqlite3.OperationalError`；② Windows 控制台默认 GBK，输出里的 ✓ / ✗ 会 `UnicodeEncodeError`——脚本开头 `sys.stdout.reconfigure(encoding="utf-8")`；③ `load_settings()` 只读 `os.environ`，`--live` 必须自己把仓库根 `.env` 读进环境（照 `scripts/memory_check.py` 的 `_read_env_file`）。

### 8.1P 窗口晃动记账（T2.3-C1，2026-10-18）

**为什么这么拆**：窗口位移只有主进程看得见，而 `usage.db` 由 sidecar 独占——所以**判定在主进程、记账走新路由**：`app/main/shake-detector.ts` 是不过 electron 的纯逻辑（`SHAKE_WINDOW_MS = 800` / `SHAKE_MIN_REVERSALS = 4` / `SHAKE_MIN_STEP_PX = 15` / `SHAKE_COOLDOWN_MS = 1500`），命中后 `SidecarClient.recordUsage()` 打 `POST /usage/record`。

**还没开始对话时晃也算数**：`UsageService._ui_session_for()` 优先复用本角色开着的**对话会话**，否则建/复用 `ui:<char_id>` 的**纯 UI 会话**（`counts_as_session=False`，不增加 `char_usage` / `daily` 的会话次数）。

**表与规则**：`session` 新增 `window_shake_count`（旧库自动补列；`SCHEME_VERSION` "3"），`BehaviorStats.char_shakes`，行为记忆第 4 条规则——样本门槛与打断同（`MIN_SESSIONS_FOR_INTERRUPTS = 3`），比率 ≥0.35「他着急或者无聊的时候会晃你的窗口，晃得还挺起劲。」/ ≥0.15「他偶尔会晃一下你的窗口。」/ 否则「他很少晃你的窗口，多数时候只是安安静静待在旁边。」（importance 0.45 / 0.40 / 0.35，**不带次数**）。

**真机取证**（临时探针 `scripts/_probe_shake.ps1`，两侧已删）：预置 `ui.json`（`char_id = "amber"`）→ 起 Electron（`--remote-debugging-port=9227`）→ 用 Win32 `MoveWindow` 在 110 ms 间隔交替位移 14 次。结果：窗口 **512×608**、`MOVES=14`、**`SHAKE_LOGS=1`**、**`SHAKE_FAILED_LOGS=0`**；主进程日志 `<DataDir>/logs/deskpet-main.log` 一条 `event=ui.window_shake, char_id=amber`。14 次只记 1 条 = 1.5 s 冷却去重生效；0 条 `ui.window_shake_failed` 即 `POST /usage/record` 成功（前端非 2xx 才记失败）。

**门禁**：pytest **约 489 例**、vitest **15 文件 133 例**、pre-commit **7 钩子**全绿。

**教训 / 已知偏差**：① DB 落盘这一环没法在真机上直接看（flush 间隔 300 s，退出走 `taskkill /F` 无优雅收尾），只能靠单测覆盖「计数进哪条会话」；② 探针预置 `ui.json` 必须用 `UTF8Encoding($false)` 写无 BOM，带 BOM 会让 `JSON.parse` 失败；`char_id` 空时 sidecar 会拒收（返回 `recorded: false`）。

### 8.1Q 立绘真加载与部位点击（T2.3-C2a，2026-10-18）

**背景**：用户 m09592 要「鼠标点击立绘各个部位互动」、m09848 定「立绘先用桌面上的琥珀、小雪、莫莫，你自己画一下身体部位」。

**先修掉的真 bug**：`app/renderer/index.html` 一直把 `#character` 的 `src` 写成内置占位图，渲染层全域没有 `.src =` 赋值——即**角色包的立绘从来没有被加载过**，切角色看到的永远是同一张图；`appearance.portrait` 只有 sidecar 在校验。顺带：`.character` 原是 `object-fit: cover`，会裁掉素材边缘、让部位命中整体偏，改为 `contain`。

**做法**：立绘由主进程读 `characters/<char_id>/` 下的 PNG 转 **data URL** 回传（`deskpet:char:portrait`；CSP 仍是 `img-src 'self' data:`，不放开 `file://`、不加自定义协议；单张 ≤8 MiB，路径拒绝对路径与 `..`）。部位定义放角色包可选文件 `hits.json`（0–1 归一化 `[x,y,w,h]`，与素材像素尺寸解耦；后定义覆盖先定义；名字截 24 字、颜色非法回退 `#ffb347`、`reactions` ≤5 条各 ≤60 字、部位 ≤24 个），三只示例（琥珀 / 小雪 / 莫莫，各 512×724 桌面插画）各 8 个部位，**按图目测估的**。命中换算在渲染层：`contentBox()` 先算 `contain` 下实际画出来的矩形，再换算归一化点；一次点击要求 mousedown / mouseup 期间窗口位移 ≤4 px 且指针抖动 ≤6 px。点击先出**本地兜底台词**（`reactions`，0 延迟）再经 `deskpet:ui:char-hit` → `POST /usage/record`（`fact: char_hit`，带 `region_id` / `streak`）→ `char_hits` 表按「角色 + 部位」聚合（`count` 累加 / `max_streak` 取最大 / `last_at` 取最新；`SCHEME_VERSION` 4）。LLM 的回应留到 C2b。

**真机读数**（临时探针 `scripts/_probe_hit.mjs` + `.ps1`，真实 Electron + CDP `Input.dispatchMouseEvent`；跑完两侧已删）：

| 项目 | 读数 |
|---|---|
| 立绘来源 | `src_head = data:image/png;base64,iV`（不再是 placeholder）、natural **512×724**、`object-fit: contain` |
| 几何 | `#character` 与 `#stage` 都是 512×724，viewport 512×820 |
| 8 个部位逐框点击 | **全部 matched**：头「别摸头。」/ 胸「看哪儿呢。」/ 枪「别碰，很贵的。」/ 手「干什么。」/ 腰「别戳。」/ 裙摆「裙角别动。」/ 腿「往哪儿看。」/ 脚「鞋跟你也点。」 |
| 空白点 (486,695) | 静默（气泡无新文本） |
| 主进程日志 | **8 条 `ui.char_hit`**（region_id 全对、`streak: 1`、`kind: single`）、**0 条 `ui.char_hit_failed`** |
| 叠色块截图 | `_probe_out/hit_boxes.png`：8 个框落位与人物部位基本吻合，可作为初版 |
| 落库 | 探针数据目录的 `usage.db` 里 `char_hits` 表**已建但 0 行**——`flush()` 是批量（默认 300 s，无 env 可改），探针收尾是 `taskkill /F`，python 没机会 flush。**结论：live 层只以日志 + 气泡文本为证，落库语义由 `tests/test_usage_store.py` 与 `tests/test_usage_service.py` 覆盖** |

**还没测 / 已知偏差**：部位框是目测估的（块 D 编辑器会做可视化调整）；`double` / `hold` 两种连击语义只有单测覆盖，没有真机点击读数；LLM 对点击的回应（C2b）未做。

**坑**：① `scripts/lib/cdp.mjs` 的 `connectPage()` 返回 `{ cdp, socket }`，`Cdp.evaluate` 已 `returnByValue`，再套 `JSON.parse` 会报 `SyntaxError: [object Object] is not valid JSON`；② 从 WSL 读探针数据目录必须写 `/mnt/c/...`，写 `C:/...` 会 fs ENOENT；③ 点击事件要背靠背发 press+release（主进程拖动轮询 `DRAG_POLL_MS = 12 ms` 会把有间隔的按住当成拖动而移动窗口）。

### 8.1R 部位点击的 LLM 回应（T2.3-C2b，2026-10-18）

**背景**：C2a 让点击先出本地兜底台词、只记账；C2b 补上「什么时候值得为一次点击花一次 LLM」。

**闸门**（主进程纯逻辑 `app/main/char-hit-gate.ts`，定时器在 `app/main/ipc-handlers.ts`）：一串点击在最后一击之后 `HIT_DEBOUNCE_MS = 600 ms` 聚成一次发起（携带整串条数）、一次发起后 `HIT_COOLDOWN_MS = 8000 ms` 内只记账、`HIT_RATE_WINDOW_MS = 60 s` 内最多 `HIT_RATE_MAX = 4` 次、一串 ≥ `HIT_IGNORE_STREAK = 10` 下连已排上的那次一起吞掉。

**真机读数**（临时探针 `scripts/_probe_c2b.mjs` + `_probe_c2b.ps1` / `_probe_c2b_long.ps1`，真实 Electron + CDP + 真实端点 `deepseek-v4.1-flash`；跑完两侧已删；数据目录经 `DESKPET_DATA_DIR` 隔离，`DATA_FILES=logs,key.blob,memories.db,…,usage.db` 确认真的落在那）

| 项目 | 读数 |
|---|---|
| 短跑 ×2（每次 5 连击 + 12 极速连击） | 两次都 `ok: true`；每跑 **17 条 `ui.char_hit`**、**3 条 `ui.char_hit_gated reason=overloaded`**（streak 10 / 11 / 12）、`ui.char_hit_fired` 1 条 |
| 每跑花掉几次 LLM | **1 次**：sidecar `chat.start` 里 `interaction="head"`、`streak=5`（17 次点击只发一次）；12 连击那一串 **0 回合** |
| 模型回应 | 「你是不是没事干？手拿开。」/「五下，我数着呢。」（后者说明 `streak` 真的进了提示词） |
| 长跑（>300 s，跨过批量落盘窗口） | 两轮共 **58 条 `ui.char_hit`**、**5 条 `chat.start`**（`interaction` / `streak` = head/5、head/1、chest/7、chest/1、head/5）、`gated` 23 条（overloaded 7 / cooling 16） |
| 长跑的库 | `char_hits` 落 **39** 行：head **19**（`max_streak` 12）、chest **8**（8）、skirt **7**（6）、waist **5**（6）——比 58 少的部分是「最后一次 flush（300 s 批量窗口）之后又点的、被 `taskkill /F` 丢掉」的，属批量落盘的已知行为 |

**抓到并修掉的真 bug（静默丢回合）**：短跑三次里有**一次** 5 连击没有起任何回合——没有 `chat.start`、没有 `ui.char_hit_skipped`、也没有失败日志，5 条 `ui.char_hit` 都在。唯一可能的路径是定时器回来时 `flush()` 返回 null（
ow < dueAt`，Node 定时器走单调时钟、判定用 `Date.now()`，早一两毫秒就够了）→ 整串点击被无声吞掉。修法：`HIT_FLUSH_TOLERANCE_MS = 5 ms` 容差 + 到点没发成按 `remainingMs()` 重排；闸门已经取消这一串（≥10 下）时清掉待发并记 `ui.char_hit_dropped`，绝不空转。

**中间还踩了自己一个坑**：第一版重排逻辑只按 `remainingMs()` 排，没区分「还没到点」与「这串已被闸门取消」（后者 `remainingMs()` 为 0 → 1 ms 重排），两次复跑打出 **6564 条 `ui.char_hit_retry`** 的空转；补 `hasPending()` 之后归零（复跑 `RETRY=0 / FIRED=1 / DROPPED=1`）。

**还没测 / 已知偏差**：`double` / `hold` 两种 `kind` 只有单测（真机双击与长按没做）；部位框仍是目测估的（块 D 编辑器做可视调整）；模型对互动文案的语气只做了人眼抽查。

**坑**：① 探针的每次 CDP 点击**都会同时触发主进程的拖动逻辑**（`ui.drag_start` / `ui.drag_end` 一次点击各一条，长跑里 62 条），窗口被拉着追真实系统光标，于是同一批点击的落点会漂到别的部位——长跑里 `char_hits` 出现 chest / skirt / waist 就是这么来的；要量「某个部位」的命中就得像 C2a 那样每次点击前重新量几何。② `usage.db` 的批量窗口是 **300 s**（`DEFAULT_FLUSH_INTERVAL_S`，没有 env 可改），短跑里 `flush()` 不会触发、表是空的；要验记账必须跑够 5 分钟，或直接跑单测。③ PowerShell 的 `>` 重定向写 UTF-16LE，读回要 decode；`sqlite3.connect()` 会凭空建一个 0 字节库，读不存在的库会报 
o such table`（不是功能问题）。
### 8.1S 开发者模式与角色记忆两页（T2.3-B1，2026-10-18）

**测法**：临时探针 `scripts/_probe_dev.mjs` + `scripts/_probe_dev.ps1`（真实 Electron + 真实端点 deepseek-v4.1-flash）。先借 `scripts/smoke_memory.mjs --stage tell` 在隔离数据目录（`DESKPET_DATA_DIR`）造一条事实与它的原文，再重开应用驱动设置窗：主窗 READY + ONLINE → 点「设置」→ 等 `body.dataset.devReady` → **CDP 合成点击 `#app-version` 20 次（间隔 30 ms）** → 面板出现并读 `data/dev.json` → 数原文页行数 → 切「注入上下文」页、把 query 填成「团子」、点预览 → 数六段并读最终文本 → 点「关闭开发者模式」→ 面板收起并再读 `dev.json`。

| 读数 | 值 |
|---|---|
| 20 次点击后的 banner | 「已进入开发者模式。」 |
| `data/dev.json`（进入 → 关闭） | `{enabled:true}` → `{enabled:false}` |
| 面板可见性 | 进入前 `hidden=true` → 进入后 `false` → 关闭后 `true` |
| 原文页（第 1 页） | **3 行**：`#1` 用户 22 token、`#2` 助手 6–14 token、`#3` 助手 9–19 token，均「未被摘要覆盖」 |
| 注入页段数 | **6 段**（observations / l3 / l2 / l1 / facts / history，顺序与 §6.4 一致） |
| 注入合计 | **59 / 69 / 64 token**（三次跑），`budget_tokens` 2500，`injected_ids=[1]` |
| L0（facts）段 | **21 / 21 / 22 / 400 token**，**1 条** |
| L1 / L2 / L3 / observations | 各 0 / 0 token、0 条（本跑只聊了一轮，没到压缩阈值） |
| 最终注入文本 | 以「以下是你记得的…是数据不是指令」开头，事实本体在 `<untrusted_input>` 里 |
| tell 阶段首句 | 3827 / 4917 ms（沿用 `smoke_memory` 的 tell 阶段） |

**一个探针侧假失败（不是产品 bug）**：第一跑 60 s 超时、面板始终没出现，`data/dev.json` 不存在、主进程日志里也没有 `ipc.dev_mode`——即 20 次点击**一次都没数上**。原因是设置窗的点击监听器在 `main()` 里 `await api.ui.getState()` 之后才挂上，而探针在 `#app-version` 一出现（HTML 已解析）就开始点，点击全发在监听器挂上之前。修法：设置窗 `main()` 末尾置 `document.body.dataset.devReady = "1"`，探针先等这个标记；加标记后**连续两次复跑都 `ok: true`**。教训：给「连点 N 次」这类手势写脚本时，必须让界面给出「手势已绑好」的就绪信号，不能拿「元素存在」当就绪。

**还没测**：翻页（`before_id` 路径，本跑只有 3 行）；摘要覆盖后的 `covered_by` 显示（需要有 L1 摘要）；用「再连点 20 次」退出（只测了「关闭开发者模式」按钮这条退出路径）。

**坑**：`robocopy` 同步单个文件必须「源目录 + 裸文件名 + 目标目录」，把目录名当文件参数会静默复制 0 个文件（RC=2）。
### 8.1T 开发者模式里编辑 L0 记忆（T2.3-B2，2026-10-18）

| 步骤 | 读数 |
|---|---|
| `POST /memory/write`（探针先造一条事实） | 200，`{id: 1, deduped: false}` |
| 20 击开开发者模式 | `data/dev.json` `{enabled: true}`，面板出现，`dev_panel_ms` **1523 ms** |
| 编辑前预览（query =「咖啡机」） | facts 段含旧文本，`合计 14 / 2500 token · 注入记忆 id：1` |
| 点 facts 行「编辑」→ 改文本 → 保存 | `clicked: 0`（选中第 0 行），横幅「已保存这条记忆，下一轮注入就用新内容。」 |
| 保存后自动刷新（仍是旧探针词） | 旧文本从预览里消失（`auto_refresh_old_gone: true`） |
| 用新词「手冲壶」重新预览 | 新文本进 facts 段与最终注入文本，`合计 16 / 2500 token · 注入记忆 id：1` |
| `GET /memory/list` | `count: 1`、`has_old: false`、`has_new: true`——改的是同一行，不是新增 |
| 整轮耗时 | **1651 ms**（全程无 LLM 调用），`ok: true` / `errors: []` |

还没测：`importance` 走界面改（界面只传 `text`；`importance` 的契约与单测都有）；「撞去重键并成一条」只走了单测（`test_update_memory_merges_on_dedup_collision`），没有真机造两条近似事实去撞。

探针坑：① 内层 try 里声明的 `const clicked` 在外层算 `ok` 时不可见，报 `ReferenceError: clicked is not defined`（改读 `report.edit.clicked`）；② 给 `.ps1` 补 BOM 时若原文件已带 BOM 会写成**双 BOM**，PowerShell 5.1 报 `InvalidLeftHandSide` 并指向 param 块；③ CDP 调用卡住时 Node 会停在 `unsettled top-level await`（exit 13）而**不写报告**——探针给每次 `evaluate` / `waitFor` / `connectPage` / HTTP 调用都套了超时，并加 150 s 看门狗兜底。

### 8.1U 角色包编辑器（T2.3 块 D，2026-10-18）

**做了什么**：设置窗加「角色与立绘 → 新建角色包…」，打开独立窗口 `app/renderer/editor.{html,css,ts}`（1000×700、可缩放、无菜单栏）。四步向导：① 选图（`deskpet:pack:pick-image` 走主进程 `dialog.showOpenDialog`，png / jpg / jpeg / webp，回 data URL——CSP 只放 `data:`，不放开 `file://`）；② 裁切（Canvas 拖框 + 四角手柄，导出 `toDataURL("image/png")`）；③ 画部位框（在裁切结果上拖框 + 填名字 / 颜色 / 台词 / `act`；预置一个「身体」框覆盖全身）；④ 填卡片（`char_id` / `display_name` / `description` / `personality` / `speaking_style`）→ 保存。

主进程 `app/main/pack-editor.ts` 负责校验与落盘（不 import electron，便于单测）：`PACK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`、`MAX_PORTRAIT_BYTES = 8 MiB`（与 `character-assets.ts` 对齐）、`MAX_REGIONS = 24`、`REGION_NAME_MAX = 24`、`MAX_REACTIONS = 5` / `REACTION_MAX = 60`；`decodeImageDataUrl` **查文件头**（png 签名 / jpeg `FF D8` / webp 还要看 `data.subarray(8,12) === "WEBP"`），mime 与字节不符直接拒；
ormalizeRegions` 夹到 0–1、保底最小边长 0.02、颜色非法回 `#ffb347`；产物五件：assets/portrait.<ext>、card.json、pack.json、appearance.json、hits.json。**目录已存在一律拒绝**（只新建，不覆盖）。

**真机读数**（真实 Electron + CDP，探针 `scripts/_probe_editor.mjs` 绕过系统选图框直接调同一 IPC；两次 `ok: true`）：

| 步骤 | 读数 |
|---|---|
| 编辑器窗口就绪（`document.body.dataset.editorReady`） | **56 ms**；title「deskpet 角色包编辑器」；4 个 pane / 4 个 tab；裁切 / 部位 / 保存画布都在 |
| `pack:save`（1 个「身体」框 + 1 个自画框） | `ok: true`、**7 ms**；files [`assets/portrait.png, card.json, pack.json, appearance.json, hits.json`]；磁盘五项全 true |
| `hits.json` | `regions[0].id === "body"`（中文「身体」映射到 ascii id），第二框 `region2` |
| 卡片字段 | `card.json` 的 `display_name === "探针角色"` |
| 主窗角色菜单刷新（`characters:changed`） | ids `["amber","momo","snow","zprobe"]`、popup 文案 `["琥珀","莫莫","小雪","探针角色"]`；**当前角色没被切走** |

| sidecar 加载器复核（`scripts/_probe_packload.py`） | `load_character_pack(characters/zprobe)` → `ok: true`，`personality="话少"` / `speaking_style="短句"` / `portrait="assets/portrait.png"` / `stage="png"`；issues 只剩两条 pending（`voice.json` / `emotion_map.json`） |

**三个真 bug（都被门禁抓出，写完即修）**：① `app/main/pack-editor.ts` 的 `pretty()` 写成「JSON.stringify(value, null, 2) + NL」——生成脚本把自己的占位符 `NL` 写进了源码，运行时 `ReferenceError: NL is not defined`；改回字符串加换行。② `app/renderer/editor.ts` 漏定义 `DEFAULT_REGION_COLOR`。③ `regions.indexOf(hit)` 过不了 tsc（`locateRegion` 回的 `CharHitRegion.rect` 是 readonly 元组）→ 改 `findIndex` + `Object.is`。另删了一个只写不读的 `let step`（eslint）。

**为什么默认框是 `body`**：`char_hits` 表只存英文 id，中文名 slug 不出 ascii 会退成 `region1` 这种看不懂的键；所以 `BODY_REGION_NAME = "身体"` 单独映射成 `body`。

**还没测**：① 裁切与画框的**鼠标交互**只有单测（CDP 点不了系统选图框，探针只能绕过 dialog 直接调 `pack:save`），要人眼验收；② 只能新建、不能改已有包（设计如此，让位给 M3）；③ 落仓库根 `characters/`，打成安装包后位于 Program Files 时可能不可写（已知风险，未处理）。

**探针坑**：设置窗 / 编辑器刚打开时 `document.body` 还可能是 
ull`，就绪判据要写成 `!!document.body && document.body.dataset.x === '1'`，否则报 `TypeError: Cannot read properties of null (reading 'dataset')`。

### 8.1V 手势与互动模式（T2.3-C2c，2026-10-18）

目的：用户 m12028 要把「到处摸」做成真的互动——点击部位不再出预制台词、力度按连点次数算，并加一个互动模式按钮防误触；同时把「怎么进互动模式」和「哪些手势算数」做成设置项。

做法：

- 渲染层纯逻辑 `app/renderer/touch.ts`（10 例单测）：`tap`（位移 ≤6 px）/ `stroke`（累计 ≥40 px）/ `hold`（≥600 ms）/ `knead`（反转 ≥3 次且总位移 <120 px）/ `pat`（300 ms 内连点 ≥3 下 → `count` = 下数）；一串静默 1500 ms 才结算，`regions` 去重 ≤3。
- 互动模式：默认只由聊天条（麦克风旁）的「互动」按钮开关，开着才接受点 / 摸，`startDrag()` 直接返回（拖动走顶部把手）；点到的即时反馈只有 320 ms 脉冲 `.character.touch-pulse`。设置窗「手势」菜单可选「在立绘上滑动」进入 + 逐个手势启禁，存 `data/ui.json` 的 `gestures`。
- 主进程 `app/main/char-hit-gate.ts` 由 streak 改按整串条数（`HIT_IGNORE_COUNT = 10`）；sidecar `char_hits` 主键加 `gesture`（`SCHEME_VERSION` 4→5，旧库缺列整表重建），`build_interaction_note()` 按手势与条数分档，行为记忆按手势措辞。
- 聊天条「设置」旁加最小化按钮，托盘右键菜单加同一项（`deskpet:ui:minimize` → 主窗 `hide()`）。

真机探针（`scripts/_probe_touch.mjs` + `_probe_touch.ps1`，A2 常驻实例 9227 端口、`DESKPET_DATA_DIR` 隔离数据目录；跑完两侧已删，产物 `D:\Agent_Projects\_probe_out\`）：

| 读数 | 值 |
| --- | --- |
| 窗口 / 立绘几何 | `inner` 512×820；`#character` **512×724** 与素材 natural 一致（`contain` 无裁切） |
| 互动按钮 | 点击后 `body.interacting === true` |
| 松手脉冲 | `#character` 带 `touch-pulse` |
| `tap` | `{ gesture: tap, regions: head, count: 1, duration_ms: 63 }` |
| `pat` | `{ pat, head, 3, 546 }` |
| `stroke` | `{ stroke, head, 1, 139 }` |
| `knead` | `{ knead, head, 1, 188 }` |
| 互动模式下拖立绘 | `window.screenX` **0 → 0**（窗口不动） |
| 设置窗「手势」默认值 | `button=true / stroke=false / 五种手势全开` |
| 关掉「连拍」 | `ui.json` 的 `gestures.enabled = [tap, stroke, hold, knead]` |
| 再打开「连拍」 | `[tap, stroke, hold, knead, pat]` |
| 点最小化 | `document.visibilityState === \"hidden\"` |

两个真 bug / 坑：

1. **第一次探针把 `tap` 判成 `stroke`**：`Input.dispatchMouseEvent` 的 `mousePressed` 会把指针从上一位置（互动按钮 77, 794）瞬移到落点，渲染层于是收到一个带 `buttons` 的大跨度 `mousemove`（距离 > 40 px）。真机不接键盘鼠标瞬移，这是探针伪影；修法是每次按下前先补一次不按键的 `mouseMoved` 把指针放到落点。教训：**CDP 合成手势点击要先「挪到位」再按**，否则几何全被污染。
2. **旧监听器残留**：`app/main/ipc-handlers.ts` 里留着一整段 C2b 时代的旧 `uiCharHit` 处理体（读 `region_id` / `streak` 旧契约），与新处理器并存；换契约时只改「新写的那段」不够，得按旧字段名全仓 grep（这次共删 28 行）。

**还没测**：① `hold` 只有单测（真机探针没跑「按住不放」）；② 「在立绘上滑动进入互动模式」这条触发路径没在真机上试过；③ 点 / 摸 → LLM 回应整轮的数字仍沿用 §8.1R（C2b）；④ 揉与连拍在手感上是否分得开（阈值 40 px / 反转 3 次）要人眼验收。

### 8.1W Stage 抽象层 + edge-tts + 云端 ASR（T2.4，2026-10-18）

**目的**：先把形象层抽成可替换的 `StageAdapter`（为 M3 的 Live2D 铺路），再接两个免费供给
（edge-tts 云端 TTS、OpenAI 兼容云端 ASR）。

| 项 | 数字 / 结论 |
| --- | --- |
| **Stage 抽象层回归** | `powershell -ExecutionPolicy Bypass -File scripts\smoke_text.ps1 -Turns 3` → **ok: true**：3 轮首句 **4873 / 5522 / 3499 ms**、打断后主进程释放 **2628 ms**、`quiet_ok: true`、`thinking_ok: true`、`sidecar_online_ms` 1 ms。立绘改由 `stage-png.ts` 自建 `<img class="character">` 加载 |
| **Stage 真机探针**（临时 `_probe_stage.mjs`，跑完已删） | **ok: true**：`#stage-mount > img.character` 存在、`src` 是 `data:image/`、自然尺寸 **512×724**；旧 `#character` 元素**不再存在**；IPC `deskpet:char:appearance` 回 `{stage:"png", acts:[blush,wave,think], portrait:"assets/portrait.png"}`；**换角色后 Stage 重建**（img 重新加载、菜单角色切换生效）；一轮 `s` 事件带着 emotion `平静` 落地（`data-expression="平静"`）⇒ `s→stage.setExpression` 接线真机生效 |
| **edge-tts 真机端到端**（同探针，`DESKPET_TTS_PROVIDER=edge`） | 走真实 app（Electron → sidecar → edge-tts → `deskpet:tts:audio`）发一轮：sidecar 日志 `tts.synth` **2 条**、voice **zh-CN-XiaoxiaoNeural**、`tts.failed` **0**，首句 **11088–14256 字节 MP3**；`is_error: false` |
| **供给层路由探针**（临时 `_probe_providers.py`，跑完已删） | **ok: true**：`/asr`（cloud 无端点 / 端点连不上）都回 **DP-ASR-004**；cloud 对本地 mock 端点走通「PCM→WAV 上传→解析」→ **200 `你好世界` confidence 1.0**；`/health` 的 `providers` 里 tts=**edge** `configured:true`；`/tts`(edge, voice=`zh-CN-YunxiNeural`) → **200 `audio/mpeg` 10656 字节**、`x-deskpet-voice` 回该音色；`/providers/test` asr 未配给可执行提示、tts 报 edge 可用 |
| **edge-tts 单测探手** | `EdgeTtsClient.synthesize('你好，我是琥珀。')` → **13104 字节 MP3**、gen 1587 ms（真机需联网） |
| **新立绘 / 部位框 / 窗口菜单真机探针**（临时 `_probe_ui.mjs`，跑完已删） | **ok: true**：新立绘自然尺寸 **1024×1536**、data URL 加载；`hits` 回 **10 个部位**（head / ears / chest / waist / skirt / legs / feet / tail / hand_left / hand_right）；「窗口」菜单：**只在桌面显示 → `always_on_top:false`**、**在所有应用上显示 → true**（当前项高亮均正确）、**隐藏窗口 → `visibilityState:"hidden"`**；截图 `D:\Agent_Projects\_probe_out\deskpet-new-portrait.png` 与叠框图 `deskpet-hits-overlay.png` |
| **设置窗回归** | `scripts\smoke_settings.ps1` **ok: true**：3 张供给卡 + 3 个测试按钮、真实 LLM 探测 HTTP 200、`mismatch: []`（界面所选 provider 与心跳逐面一致） |
| **门禁** | pytest **539 passed** / vitest **24 文件 220 例** / pre-commit **7 钩子**全绿 |

**环境坑（本轮新增）**：本机 Windows 系统代理开着（`HKCU\...\Internet Settings` 的 `ProxyEnable=1`、`ProxyServer=127.0.0.1:10808`）。httpx 默认 `trust_env=True` 会读注册表代理，**且不认 Windows 的 `ProxyOverride` bypass 列表**，于是连 `127.0.0.1` 的本地请求也被送去代理、拿回一个空 body 的 HTTP 503——表现为 `test_error_boundary` / `test_sidecar_launch` 里「没启动适配器应报 DP-TTS-503」变成「引擎返回 HTTP 503 被包成 DP-TTS-500」。**解法**：跑测试 / sidecar 前设 `NO_PROXY=127.0.0.1,localhost`（本轮全部门禁都带它跑）。

**还没测**：① Live2D 真实现（M3，本层只留接口 + PNG 回退）；② 云端 ASR 对**真实 Groq / OpenAI 端点**的端到端（未用用户 key 实跑；协议形状已由 MockTransport 单测 + 本地 mock 端点覆盖）；③ `act` 动作动画的端到端（`playAct`/`resolveEffect` 有单测、CSS 类已在，但本轮模型没吐 `act`，只有 `emotion` 落到了 `data-expression`）。

### 8.1X 语音全双工 P2（WebSocket 长连接，2026-10-20）

**目的**：把语音链路的「两条 HTTP + 一条 SSE + IPC 音频回传」收成一条 `WS /ws/voice`：音频上行、
识别/台词/错误事件下行、合成音频下行、取消都在同一条连接里。

| 项 | 数字 / 结论 |
| --- | --- |
| **真机静音探针**（临时 `_probe_duplex.mjs`，跑完已删） | **ok: true**：主进程日志 `voice.ws_open` 出现；渲染层 `voice.begin` → 0.5 s 静音块 → `voice.end`；sidecar 记录 `asr.empty` **1 条**；界面气泡变成「没听清，再说一次。」⇒ 渲染层 IPC → 主进程 WS → sidecar ASR → WS 事件 → 主进程 IPC → 气泡**整条链路打通** |
| **WS 路由单测**（`tests/test_voice_ws.py`，5 例） | 用 TestClient 的真 WebSocket + 假 ASR/Chat/TTS：① 音频回合产出 `asr.final → state(thinking) → llm.s → tts.audio + 二进制 → llm.end → state(idle)`；② 空识别只发 `asr.empty + idle`、不调 LLM/TTS；③ `text` 控制跳过 ASR；④ 缺 token 被拒；⑤ 正确 token 可用 |
| **TTS 请求构造**（同一测试） | sidecar 从角色包自建 `TtsRequest`：`voice_id` 落到 `characters/amber/assets/reference.wav`、`lang=zh`、`emo_weight=0.8`、`emo_vector[0] > 0`（喜） |
| **流式识别真机探针**（sherpa-onnx，临时 `_probe_stream.mjs`，跑完已删） | **ok: true**：把模型自带的 5.61s 中文 wav（179568 字节 PCM，57 块）经「渲染层 begin/audio/end → 主进程 WS → sidecar 流式识别 → LLM」跑一轮；**partial 13 个**（第一个是「对」）、终稿 `对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢`、LLM 首句 `话说一半就停了？`。离线单测里同一段音频解码 **0.10s，RTF 0.02**（`tests/test_asr_stream_sherpa.py`，模型缺失时整组 skip） |
| **真实采集链路**（Chromium 假音频设备，临时 `_probe_fake_audio.mjs`，跑完已删） | **ok: true**：`--use-fake-device-for-media-stream` + `--use-file-for-fake-audio-capture`（测试 wav 重采样到 48k 并补 1.5s 静音）；点麦克风后 `mic_open: true`、**首个 partial 1440 ms**、**12 个 partial**、终稿 `我做了介绍啊我想说的是大家如果对我的研究感兴趣呢`、LLM 首句 `……你这是在跟我说话？`。这条走的是真实的 `getUserMedia → ScriptProcessor → 16k 重采样 → VAD → voice.begin/audio/end`；**AEC 本身没有扬声器回采，未真正验** |
| **打包 sidecar.exe**（临时 `_probe_packaged_asr.py`，跑完已删） | **ok: true**：`dist/sidecar/sidecar.exe`（onedir **281.6 MB**）冻结环境里 `/health` **200**、`/ws/voice` 流式 **13 partial + 终稿**、`POST /asr` 批处理 **200** 且有文本。`sidecar.spec` 为此补了 `faster_whisper` / `edge_tts` / `sherpa_onnx` hidden imports、`collect_dynamic_libs("sherpa_onnx")`、`collect_data_files("faster_whisper")`（VAD 资产 `silero_vad_v6.onnx`） |
| **门禁** | pytest **548 passed** / vitest **24 文件 221 例** / pre-commit **7 钩子**全绿 |

**本轮明确没做**（不要误读成已完成）：
1. **稳定 partial 投机起 LLM**：partial 已经能出、也用于聊天条小字与终稿，但还**没有**「连续两帧稳定就提前发 `/chat/stream`，final 不一致再取消重发」这一步。
2. **AudioWorklet**：采集仍是 `createScriptProcessor(2048)`；P2 只把「一句之内的音频块」连续送到 sidecar。
3. **TTS 逐块流式**：sidecar 仍是逐句合成后整段下发（`tts.audio` 的 `final=true`），没有句内 PCM 分块。
4. **真麦克风 / AEC**：用 Chromium 假音频设备跑通了 `getUserMedia`/VAD/流式识别，但没有真实扬声器回采，**AEC 未真正验**；真实硬件差异也未测。
5. **云端 ASR 真实端点**：仍只用本地 mock 验过协议，没拿真实 Groq/OpenAI key 跑；流式仅本地（`provider=cloud` 走批处理）。

**流式模型**：`data/models/asr-stream/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/`（~70MB，`data/` 已 gitignore）；下载脚本 `scripts/fetch_asr_stream_model.py`（支持 `--proxy` / `--url`）。模型缺失时 sidecar 记一条 `asr.stream_unavailable` 并自动退回批处理。

**环境坑**：临时数据目录没有 ASR 缓存，且 `faster-whisper` 在缓存齐备时仍会去 HuggingFace 校验（本机系统代理会挡）。探针用 `junction <temp>/models/asr`（以及 `asr-stream`）指向仓库 `data/models/` 并设 `HF_HUB_OFFLINE=1` 解决。产品侧若遇到同样问题，可在 `.env` 设 `DESKPET_ASR_MODEL_DIR` 指向缓存并把 `HF_HUB_OFFLINE=1` 写进启动环境。

### 8.1Y 窗口缩小 / 台词下移 / edge-tts 开关（v1.64，2026-10-20）

**目的**：真立绘 1024×1536 不再把窗口撑到半屏；台词从立绘上方挪到窗口下部；TTS 先用
edge-tts，并在麦克风旁给一个「只显示文字 / 会念台词」的开关。

| 项 | 数字 / 结论 |
| --- | --- |
| **窗口尺寸** | 真机 `window.innerWidth×innerHeight` = **420×726**（立绘显示区 420×630 + 实测聊天条 96）。立绘显示上限 `420×630` 是等比缩放，素材文件与 `scale` 语义都没变 |
| **气泡位置** | 台词气泡 `top=585 / bottom=622`，聊天条 `top=630`，立绘区 `top=0 / height=630` ⇒ 气泡整体在**窗口下部**、贴聊天条上方，不再压住头 |
| **底部 UI 布局（v1.65）** | 真机：窗口 **420×750**；聊天条 `top=630 / h=120`；状态条 `638–654`；输入行 `661–701`；发送键 `372–410`；动作行 `708–740`，最右「设置」右边缘 **410 < 420**；所有按钮都在窗口内（无横向 / 纵向截断）。截图 `D:\Agent_Projects\_probe_out\deskpet-ui-v2.png` |
| **TTS 开（edge-tts）** | 一句回复收到 **1 段音频 / 26208 字节**；sidecar 日志 `tts.synth` **1 条**、音色 **zh-CN-XiaoxiaoNeural**、`tts.failed` **0** |
| **TTS 关** | 点 🔊 后 `ui.json` 的 `tts_enabled=false`；第二句台词照常出现，音频 **0 新增**（count 1→1、bytes 26208→26208）；主进程 `ChatOrchestrator` 与 sidecar `VoiceSession` 都不再合成 |
| **打包 edge-tts** | `dist/sidecar/sidecar.exe`（281.6 MB）里 `/health` 的 tts=**edge** `configured:true`；`POST /tts` **200 `audio/mpeg` / 7776 字节**、`x-deskpet-voice: zh-CN-XiaoxiaoNeural` |
| **门禁** | pytest **549** / vitest **24 文件 222 例** / pre-commit **7 钩子**全绿 |

**实现位置**：`app/main/ui-state.ts`（显示上限 + `tts_enabled` 解析/合并）、`app/renderer/style.css`（`.bubble` 改 `bottom`）、`app/renderer/index.ts`（🔊 按钮 + 传 `tts_enabled`）、`app/main/chat-orchestrator.ts`（`setTtsEnabled`）、`sidecar/services/voice_session.py`（`begin(tts_enabled=…)`）。

### 8.1Z 编辑当前角色部位（T2.5，v1.66，2026-10-20）

**目的**：角色包建好以后，用户挪一下部位框 / 改个名字不用重做整套包；编辑模式只读写 `hits.json`。

探针：临时数据目录 + `characters/amber` 副本，Electron CDP 打开编辑模式（`pack.openEditor({mode:"edit",char_id:"amber"})`），在画布上按下第一个框（`legs`）拖 20 px，保存；再拉右下角 +22/+14 px，保存；对比 `hits.json` / `card.json`，并从主窗 IPC 读一次 hits。

| 项 | 数字 / 结论 |
| --- | --- |
| **编辑模式装载** | 标题「编辑角色部位：琥珀」；部位行 **10**；`body.dataset.editReady=1` |
| **拖动** | `legs` rect `[0.3, 0.55, 0.37, 0.38]` → `[0.3698, 0.55, 0.37, 0.38]`（x +0.0698；id 仍是 `legs`） |
| **四角缩放** | 右下角 +22/+14 px → `[0.3698, 0.55, 0.4459, 0.4114]`（w +0.0759、h +0.0314） |
| **只改 hits** | `card.json` 保存前后逐字节相同；`hits.json` 的 `version=2`、id 未变；目录无 `hits.json.tmp` |
| **主窗刷新** | 主窗 `characters.hits({char_id:"amber"})` 读到 `rect[0]=0.3698`；保存后广播 `characters:changed`，当前角色不切换 |
| **门禁** | pytest **549** / vitest **24 文件 227 例** / pre-commit **7 钩子**全绿 |

**实现位置**：`app/main/pack-editor.ts`（`loadCharacterPack` / `saveCharacterRegions` / 保留 id 的归一化）、`app/main/ipc-handlers.ts`（`packLoad` / `packSaveRegions` / 广播）、`app/main/windows.ts`（`EditorWindowController.open(request)` + query）、`app/renderer/editor.ts`（`enterEditMode` / `regionCornerAt` / `resizeRegionRect` / `saveRegions`）、`app/renderer/settings.ts`（入口）。

**未做**：编辑模式不能改卡片 / 音色 / 立绘、不能删已有部位；触摸仲裁未动。

### 8.1AA 文字 / 语音 / 互动三选一（T2.6，v1.67，2026-10-20）

**目的**：把三个输入通道做成互斥模式——同一时间只选一个，切换不打断已提交的回复；文字 / demand 触摸可以抢话筒，backchannel 轻点不抢。

探针：临时数据目录 + `characters/amber` 副本 + 真实 LLM / edge TTS，Electron 加假麦克风参数；真实鼠标事件驱动模式切换与按住，真实 `chat.send` 驱动 barge-in。

| 项 | 数字 / 结论 |
|---|---|
| **默认模式** | `body.dataset.inputMode = "text"`；文字行可见、提示区隐藏；窗口 **420×791**（立绘 630 + 聊天条 161，模式行 +41 px） |
| **互动模式** | 点「互动」：`body.interacting=true`、文字行隐藏、提示「互动模式：在立绘上点、摸、按住」、发送键不可见 |
| **语音模式** | 点「语音」自动开麦（假设备）；提示「语音模式：正在听…说完自动发送」、文字行与发送键隐藏 |
| **高度稳定** | 文字 / 语音 / 互动来回切，`innerHeight` 五次采样都是 **791** |
| **听音中切文字** | 先 `voice.begin` 进入「在听」，点「文字」后状态 **在听 → 空闲**（未提交的语音轮被取消） |
| **文字打断** | 长回复在说时发下一句：**6 ms** 进入「打断中」，旧轮停止；新轮被接受并出台词，没有「上一轮还没结束」 |
| **互动切换不打断** | 在说时切到互动，状态仍是 **在说**（模式切换只停输入） |
| **按住打断** | 在说时按住 750 ms：**764 ms** 进入「打断中」；松手后 **761 ms** 进入「在想」并起一轮新触摸回应（气泡文本变化） |
| **门禁** | pytest **549** / vitest **26 文件 246 例** / pre-commit **7 钩子**全绿；sidecar **零改动** |

**实现位置**：`app/main/turn-coordinator.ts`（单一话筒）、`app/main/touch-arbiter.ts`（意图 / 合并）、`app/main/ipc-handlers.ts`（模式校验 / intent / 排队）、`app/renderer/index.ts`（三段控件 / 同高提示 / barge-in）、`app/renderer/voice-engine.ts`（`stopCapture`）、`app/renderer/touch.ts`（`liveIntent` / 600 ms 结算）。

**未做**：语音与触摸不能同时（互斥代价）；文字与触摸不合并；模式不持久化；语音模式内没有独立静音。

### 8.1AB 角色菜单统一 + 角色卡编辑（T2.7，v1.68，2026-10-20）

**目的**：把角色切换、角色卡（人设）、立绘部位、新建角色包收进主窗「角色」菜单；修掉菜单当前项不更新、弹层被立绘遮挡的问题；角色卡编辑只改文字字段，不碰素材。

探针：临时数据目录 + `characters/amber` / `snow` 副本，真实 Electron + CDP；点「角色」菜单切到 snow，再从菜单打开角色卡模式改显示名 / 人格并保存；对比 `hits.json` / `portrait.png` 字节，最后从同一菜单切到部位编辑模式。

| 项 | 数字 / 结论 |
|---|---|
| **菜单当前项** | 初始 `amber` 高亮 + ✓；切到 snow 后重开菜单，当前项 **snow**，amber 不再高亮 |
| **层级** | `#chatbar` computed `z-index=10`、`#char-popup=20`；`elementFromPoint` 在菜单中心命中的是 `#char-popup` 内元素（不再被立绘 / 气泡盖住） |
| **入口** | 三个动作：`编辑角色卡 / 人设…`、`编辑立绘部位框…`、`新建角色包…`；角色多时列表单独滚动 |
| **角色卡模式** | 标题「编辑角色卡：小雪」；第 4 步可见，1–3 步页签隐藏；`char-id` 只读；四个字段正确回填 |
| **保存角色卡** | 改显示名「小雪（改）」+ 人格后保存：`card.json` / `pack.json` 更新；`hits.json` 与 `assets/portrait.png` **字节完全不变**；无 `.tmp` 残留 |
| **主窗刷新** | `characters:changed` 后菜单标签变成「小雪（改）✓」，当前项仍是 snow |
| **复用编辑器** | 再从菜单点「编辑立绘部位框…」，同一个编辑器窗口重载为「编辑角色部位：小雪（改）」 |
| **设置窗** | 「角色与立绘」区已移除，只留指向主窗「角色」菜单的说明 |
| **门禁** | pytest **549** / vitest **26 文件 250 例** / pre-commit **7 钩子**全绿 |

**实现位置**：`app/renderer/index.ts`（`renderCharacterPopup` / `updateCharacterCurrentMark` / 动作入口）、`app/renderer/style.css`（z-index / 滚动 / 当前项）、`app/renderer/editor.ts`（`enterCardMode` / `saveCard`）、`app/main/pack-editor.ts`（`saveCharacterCard`）、`app/main/ipc-handlers.ts`（`packSaveCard`）、`app/renderer/settings.html`（移除角色区）。

**未做**：已有角色不能换立绘（只能新建时选图 / 裁切）；角色卡不能改音色 / 记忆；删除角色包仍未提供。

### 8.1AC 部位编辑可点击 + 撤销本次改动（T2.8，v1.69，2026-10-20）

**目的**：修掉「编辑角色部位页面里的东西点不了」；给部位编辑一个回滚本次改动的入口。

原因：主窗默认 `always_on_top`，编辑器 / 设置窗原先只是普通窗口；两块窗口重叠时，落在主窗区域的鼠标会被主窗吃掉。修复：两个辅助窗口都 `alwaysOnTop: true`，show / focus 后 `moveTop()`。

探针：临时数据目录 + `characters/amber` 副本，打开 `mode=edit`；改第一个部位后分别用按钮与 `Ctrl+Z` 回滚，再保存对比 `hits.json`。

| 项 | 数字 / 结论 |
|---|---|
| **编辑器焦点** | 打开后 `document.hasFocus() === true`；窗口 1000×700（普通有框窗） |
| **按钮可见** | `撤销本次改动` 与 `保存部位` 在编辑模式都可见 |
| **按钮回滚** | 拖动 `legs` 22 px → 点撤销 → 保存：rect 回到 `[0.3, 0.55, 0.37, 0.38]`，与打开时**完全一致**；横幅「已撤销本次改动…」 |
| **快捷键回滚** | 再拖 18 px → `Ctrl+Z` → 保存：同样回到原 rect |
| **快照边界** | 打开编辑器时拍快照；保存成功后快照更新为刚写入的版本（之后撤销回到「上次保存」） |
| **门禁** | pytest **549** / vitest **26 文件 250 例** / pre-commit **7 钩子**全绿 |

**实现位置**：`app/main/windows.ts`（设置 / 编辑器 `alwaysOnTop` + `moveTop`）、`app/renderer/editor.html`（`#reset-regions`）、`app/renderer/editor.ts`（`originalRegions` 快照 / `resetRegionEdits` / `Ctrl+Z` / 保存后刷新快照）。

**未做**：撤销只覆盖当前编辑会话（关窗后没有跨会话历史），也没有重做；辅助窗口置顶不修改主窗的 `always_on_top` 设置。

### 8.1AD 三人新立绘 + 身体部位框 + 重叠判定（T2.9，v1.70，2026-10-21）

**目的**：把 `C:\Users\sch\Desktop\live2d` 里更新的三张透明立绘换进角色包；部位框只写身体部位，不写衣服 / 武器；把「两个框重叠时命中谁」定成可解释的规则。

**素材**：

| 文件 | 尺寸 / 模式 | 写入 |
|---|---|---|
| `琥珀-透明.png` | 1024×1536 RGBA | `characters/amber/assets/portrait.png` |
| `小雪-透明.png` | 1024×1536 RGBA | `characters/snow/assets/portrait.png` |
| `莫莫-透明.png` | 1024×1536 RGBA | `characters/momo/assets/portrait.png` |

**部位框**：每只 **12 个**——头 / 耳朵 / 胸 / 腰 / 胯 / 腿 / 脚 / 左臂 / 右臂 / 左手 / 右手 / 尾巴。按 alpha 剪影的包围盒与各高度左右边界估算，再用半透明叠色图逐框核对；不出现裙 / 夹克 / 枪 / 盾 / 蛇杖等衣服或武器名。

**重叠规则（T2.9）**：`locateRegion()` 对一个点命中的多个框依次比较——**面积最小**优先（耳朵 / 手盖住头 / 臂），面积相同取**中心离点击最近**，再相同取**定义顺序靠后**。编辑器第 3 步提示同步；`char-hit.test.ts` 覆盖小框优先、同面积取近、完全相同时后者赢、耳朵 / 头嵌套。

| 项 | 数字 / 结论 |
|---|---|
| **加载** | 三只角色都加载 `data:image/png`，
aturalWidth×naturalHeight = 1024×1536` |
| **hits** | `characters.hits()` 各返回 **12** 个部位；id 唯一、坐标 0–1、无衣服 / 武器 id |
| **窗口** | 三只都在 **420×791** 窗口下显示（立绘 630 + 聊天条 161） |
| **命中单测** | 每只 13 个关键点（头 / 耳朵 / 胸 / 腰 / 胯 / 腿 / 脚 / 尾巴 / 双臂 / 双手 + 尾腿重叠）逐点断言；`character-hits.test.ts` 9 例 |
| **门禁** | pytest **549** / vitest **27 文件 261 例** / pre-commit **7 钩子**全绿 |

**实现位置**：`characters/{amber,snow,momo}/assets/portrait.png`、三份 `hits.json`、`app/renderer/char-hit.ts`（重叠规则）、`app/renderer/editor.html`（重叠提示）、`tests/char-hit.test.ts` / `tests/character-hits.test.ts`。

**未做**：已有角色仍不能换立绘；框与剪影的贴合没有自动 alpha 校验（人工叠图）；重叠判定不提供显式 priority 字段，顺序只作最后平局裁决。

### 8.1AE 浅色奶油 UI 重排（T2.10，v1.71，2026-10-21）

**目的**：把主窗 / 设置窗 / 编辑器统一成浅色奶油风，设置窗改成侧栏 + 卡片，所有输入控件与页面匹配；动效克制、可关闭。

**设计依据**：Fluent 2 Motion / Layout（functional / natural / consistent、4px 间距阶梯、12 列栅格）、Apple HIG Motion / Layout（动效短而准、可关闭、层级 / 对齐 / 渐进披露）、shadcn/ui Sidebar / Field / Theming（Header/Content/Footer、Field 四件套、语义 token）、Radix Sand + Bronze 12 级色阶。

| 项 | 数字 / 结论 |
|---|---|
| **主窗** | **420×800**（立绘 630 + 聊天条 170）；输入框 **40px**；奶白玻璃聊天条、18px 顶圆角；聊天条内 **9** 个 SVG 图标 |
| **模式胶囊** | 文字→语音切换后 `body.dataset.inputMode="voice"`，indicator transform 矩阵 `(1,0,0,1,130.656,0)`；三段滑动正常 |
| **设置窗** | 窗口 **900×640**，client **884×584**；左侧导航 **6** 项，默认 active `appearance`；引擎 chip = **在线** |
| **设置表单** | provider 卡片 **3** 张；文本 / select 计算高度 **40px**，圆角 **12px**；provider 字段 label 在上、密钥行带「清除」；无横向溢出（scrollWidth=884） |
| **窄窗** | `resizeTo(800,600)` 后 client **784**，侧栏标签隐藏（图标栏生效），内容宽 **662**，无横向溢出 |
| **编辑器** | 窗口 **1000×700**（client 984，scrollWidth 969）；部位行 **12**；编辑动作行「撤销本次改动 / 保存部位」在顶部可见；画布为浅色棋盘格 |
| **门禁** | pytest **549** / vitest **27 文件 261 例** / pre-commit **7 钩子**全绿 |

**截图**（`D:\Agent_Projects\_probe_out\`）：`ui-light-main.png`、`ui-light-main-menu.png`、`ui-light-main-voice.png`、`ui-light-settings.png`、`ui-light-settings-providers.png`、`ui-light-settings-memory.png`、`ui-light-settings-engine.png`、`ui-light-settings-narrow.png`、`ui-light-editor.png`。

**实现位置**：`app/renderer/theme.css`（共享 token / 表单 / 按钮 / 动效）、`app/renderer/settings.css` + `settings.html` + `settings.ts`（侧栏 / 卡片 / Field / 图标栏）、`app/renderer/style.css`（主窗浅色覆盖 + 模式胶囊）、`app/renderer/index.html`（SVG 图标）、`app/renderer/editor.css` + `editor.html`（步骤胶囊 / 棋盘格 / 顶部动作行）、`app/main/windows.ts`（设置 900×640、浅色底色）、`scripts/build.mjs`（复制 theme / settings CSS）。

**同日修正（v1.71 补丁，真机探针）**：

| 项 | 结论 |
|---|---|
| 左上角角色名 | 切到 snow 后 `#grip-name` = **小雪**，`char-button.title` = 「角色：小雪」 |
| 部位输入可点 | 点部位名输入框后 `document.activeElement` 仍是该输入框，输入 `测试部位` 不丢；行内 `select` 数量 = **0**（反应下拉已删） |
| 角色卡尺寸 | 显示名输入高 **44px**、人格 textarea 高 **118px**；`char_id` 只读，提示「目录名，创建后固定」 |
| 麦克风失败回退 | 模拟 `NotReadableError`：两次尝试后模式回到 **text**，气泡「麦克风暂时打不开…已退回文字模式。」 |
| 停止按钮 | 空闲时禁用且 tooltip「当前没有可打断的回复（空闲时不可点）」 |

**未做**：深色 / 浅色切换；第三方动画库；持续呼吸光晕；设置窗拖拽 / 记忆条目重排动画。

### 8.1AF 主动陪伴、记忆保留与 v0.1.0 便携包（2026-10-22）

**主动陪伴**：主窗「陪伴」按钮打开独立窗口 **780×720**；模型库加载 **8** 条（ASR 2 / TTS 3 / 识图 3）；关闭陪伴后按钮进入 `paused`，`data/ui.json` 的 `companion` 全部关闭；互动模式主窗 `#stage` 计算样式 `filter: none`，不再有黄色矩形背景。

**记忆保留**：默认 `DESKPET_MEMORY_RETENTION_DAYS=7`、`DESKPET_MEMORY_PERMANENT_IMPORTANCE=0.8`；清理任务启动时 + 每 6 小时执行；原文按摘要 `created_at` 计时，压缩失败保留；L1/L2 按 `archived_at` 计时，L3 永久；完全重置删除原文 / 事实 / 摘要 / state / 观察 / 该角色 usage，并 `VACUUM`。单测覆盖压缩失败保留、重要度阈值、聚合后清理、跨角色隔离。

**便携包**：

| 指标 | 结果 |
|---|---|
| zip | `release\deskpet-0.1.0-x64.zip`，**253.9 MiB** |
| zip 根目录 | `deskpet.exe` + `使用说明.txt` |
| sidecar | `resources/sidecar/sidecar.exe`，281.6 MiB 目录 |
| 模型目录 | `resources/config/model-catalog.json` |
| app.asar | **1.4 MiB**（排除 `dist/sidecar`，避免重复打包） |
| 解压双击启动 | 窗口 **6306 ms**、`/health` **7158 ms**、`status=ok` |
| 退出收尾 | `runtime.json` 已删、孤儿 sidecar 0、残留应用 0 |
| SHA256 | `785ae5c1530b75d33678f4d92a9097e215ffd9c44b1cbc798d9b07ab7543782b` |

**门禁**：pytest **564** / vitest **29 文件 270 例** / pre-commit **7 钩子**。

### 8.1AG 角色包 zip 导入导出 + 麦克风诊断（2026-10-22，T2.14）
**角色包**：`tests/pack-archive.test.ts` **6/6**——导出 zip 含 `card/hits/appearance/voice/emotion_map/pack`；导入同 `char_id` 默认保留两者并自动改名；显式覆盖只替换包、不删记忆；缺 `hits.json` 时预览允许并提醒；路径穿越 / ZIP 加密 / 超大条目被拒绝；兼容带 `./` 前缀 / 目录条目 / 一层 wrapper 的常见 zip。真机设置窗探针：侧栏有「角色包」入口，导出 / 导入 4 个选项（语音 / 模型）默认全部勾选，按钮文案为「导出为 zip」「选择 zip…」；麦克风状态显示「已允许」，按钮为「打开 Windows 麦克风设置」与「打开声音设置」。

**麦克风授权**：假音频设备下 `micStatus=granted`、`audioInputs=3`、`getUserMedia` **ok**；真实设备下 `micStatus=granted`、`audioInputs=7`，但 7 个输入设备逐一调用 `getUserMedia` 全部返回 `NotReadableError: Could not start audio source`。Chromium verbose 日志：
- `WASAPIAudioInputStream::InitializeAudioEngine => IAudioClient::Initialize=[HRESULT: 0x80070057]`
- 请求格式为 `WAVE_FORMAT_EXTENSIBLE`，
Channels=1/2`、
SamplesPerSec=48000`、32-bit float；设备引擎原生格式为 44100 / 2ch。
- 已尝试：`--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox`、`--force-wave-audio`、`--no-sandbox`、关闭 AEC/NS/AGC、双声道、`sampleRate=44100`、Windows 每应用麦克风 `Value=Allow`，均仍失败。

结论：权限链路已修好，当前失败点是本机 Windows/驱动对 WASAPI 48000 单/双声道 32-bit float 的 `Initialize` 拒绝，不是 Electron 授权。应用已加「带 AEC → 关闭处理 → 最简约束」三次回退，并在提示里给出关闭独占模式 / 改 48000 Hz / 换物理麦的排查方向。

**门禁**：tsc / eslint 通过；vitest **30 文件 278 例**；pytest **564**；pre-commit **7 钩子**全绿。

### 8.1AH 原生麦克风兜底（T2.15，2026-10-22）
微信语音可正常发送，说明硬件与 Windows 麦克风权限本身没问题；但 Edge 149、最小 Electron（无任何权限处理器）与 deskpet 的 Chromium `getUserMedia` 在 7 个输入设备上仍全部返回 `NotReadableError`。因此不再依赖 Chromium 的 WASAPI 路径。

- **helper**：`sidecar/mic_capture.py` 用 PortAudio WDM-KS 回调打开默认输入（本机 device **84 / THS318**），输出 48 kHz / 16-bit / 单声道裸 PCM。
- **打包验证**：`dist/sidecar/sidecar.exe --mic-capture` 在 **2.37 s** 内输出 **98304 B**（约 1 s 音频），stderr 为 
ative mic: device=84 ... host=3`；sidecar onedir **283.8 MB**。
- **应用验证**：语音模式切过去后保持「语音模式：正在听…」，气泡显示「Chromium 麦克风不可用，已切换到 Windows 原生采集。」；CDP 统计 **2 s 收到 24 块 / 196608 B**；切回文字后 helper 进程结束。
- **限制**：原生兜底没有 AEC；助手 `speaking` / `cancelling` 时渲染层丢弃原生 PCM，避免把自己的 TTS 再识别一遍，用户可用文字打断。

**门禁**：vitest **30 文件 278 例** / pytest **564** / tsc / eslint / pre-commit 7 钩子全绿。

### 8.1AI 原生麦克风共存、AGC 与面板（T2.16，2026-10-22）
**共享模式尝试**：`soundcard` 0.4.6 在默认 THS318 上 record 全部 `RuntimeError: invalid argument`；`sounddevice` 的 WASAPI/WDM 组合仍无法打开共享输入。保留 WDM-KS，改用生命周期释放。

**失焦释放**：语音模式下派发 `blur` → 提示「语音模式：已暂停（回到窗口继续）」，helper 停止；派发 `focus` → 自动重启 helper 并恢复「正在听」。主进程日志出现两次 
ative_mic.spawn`，进程检查无残留。

**软件 AGC**：`NativeGain` 4 例单测通过（低音量提升、底噪不放大、峰值 ≤1、reset）；原生 PCM 在 `VoiceEngine.pushNativePcm` 内先过 AGC 再进 VAD / ASR。

**面板**：语音模式显示 **12 根波形柱**，状态 / partial 仍保留；互动模式显示 **4 个额度点**与 8 秒冷却条（快照 `uiTouchGate`），无部位框提醒保留。

**门禁**：pytest **564** / vitest **31 文件 282 例** / tsc / eslint / pre-commit 7 钩子全绿。

### 8.1AJ Kaspersky 根因确认与麦克风路径恢复（T2.17，2026-10-22）
用户确认本机麦克风异常来自 **Kaspersky 21.26 拦截 Electron**（微信被放行），与 Chromium/WASAPI 代码路径无关。处理：

- 默认恢复 Chromium `getUserMedia`（AEC + AGC + 共享模式）；Kaspersky 放行后不再走 WDM-KS。真机探针：
ative_mic_fallback=false` 时语音模式直接进入「正在听」，日志 `media.permission_check media_type=audio allowed=true`，**没有** 
ative_mic.spawn`；打开兼容开关但 Chromium 成功时同样不走 native。
- 删除原生 PCM 的软件 AGC（实测只会放大底噪，导致误打断和 ASR 失真）。
- 原生采集保留为设置窗「后台引擎」的**兼容模式**，默认关闭；只有显式打开且 Chromium 失败时才启动，仍保留失焦释放。
- 语音波形、互动冷却条 / 4 次额度点保留。
- 单测：去掉 AGC 4 例后 vitest **30 文件 278 例**；pytest **564**；tsc / eslint / pre-commit 7 钩子全绿。

**待用户真机确认**：Kaspersky 放行 `electron.exe` / `deskpet.exe` 后，Chromium 麦克风、微信同时使用、真实语音识别与误打断。

### 8.1AK F9 状态事实注入（T2.18，2026-10-22）
- `ChatService` 每轮读取 `EnvEventBus.active()`，`render_facts()` 只取 `fact`，注入系统提示词【你现在的状态】；`user_hint` 不进入提示词。
- 回归：总线上先登记 
et.down`（fact=网络不通，user_hint=检查代理），再请求聊天；FakeClient 捕获的 system 包含 fact，不包含 user_hint。
- 门禁：pytest **565** / vitest **30 文件 278 例** / pre-commit 7 钩子。

### 8.1AL F10 使用统计与 token 用量（T2.19，2026-10-22）
- LLM 流式请求带 `stream_options.include_usage=true`；客户端解析最终 usage chunk，并兼容 `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` / `cache_read_input_tokens`。
- `usage.db` 的 session 行新增 `llm_calls` / `llm_prompt_tokens` / `llm_cached_tokens` / `llm_completion_tokens` / `llm_max_prompt_tokens` / `memory_prompt_tokens`；旧库自动 ALTER，读侧缺列时按 0 处理。
- 设置页统计卡显示：累计 / 今日会话、消息、时长；prompt / cached / completion / total token；缓存命中率；平均 / 最大上下文；记忆注入 token；前 4 个角色。支持暂停记录和清空。
- 测试：LLM usage 归一化通过；UsageStatsReader overview 汇总通过；pytest **569** / vitest **30 文件 278 例** / pre-commit 7 钩子。

**待真机验证**：真实 DeepSeek/兼容端点是否返回缓存字段；统计页在真实数据上的显示。

### 8.1AM 真人感基础 + F5/F6/F7/F9（T2.20，2026-10-23）
- 新增持久 `CharacterState`：心情、精力、关系、注意力、最近话题、未完成事项；提示词不再每轮随机心情，关系从 0.5 种子缓慢推进。
- `POST /presence`：主进程每 30 秒上报窗口可见/最小化/输入模式/空闲/安静时段/屏幕变化；sidecar 返回主动决定。最小化 / 托盘隐藏 / 语音中硬静默；基础冷却 20 分钟，忽略后 40 / 80 分钟退避。
- `POST /screen/ocr`：RapidOCR 3.10 + ONNX Runtime CPU，实际识别 `HELLO 123` / `HELLOOCR`，置信度 0.96–0.999，首轮约 1.8–2.0 秒；`ocr_enabled` 关闭时不调用 OCR。
- `characters/` 热重载：`fs.watch` + 350ms 防抖；变更后完整校验，坏包保留旧界面。
- 状态事实 human-readable：`render_character_facts()` 不再把 `tts.failed` / `DP-*` 原样塞进人设提示词。
- 门禁：pytest **592** / vitest **34 文件 287 例** / pre-commit 7 钩子；真实 sidecar 已验证 `/presence`（最小化 false、首次问候 true）与 `/screen/ocr`。

### 8.1AP v0.2.0 正式发布（T2.23，2026-10-25）
- 版本：`package.json` / sidecar `/health` 均为 **0.2.0**。
- 便携 zip：`release\deskpet-0.2.0-x64.zip`，**330.8 MiB**（346832794 B）；SHA256 `da7c276c89b34fe82781e6ca05aebbd86d81c5489103f6e3e232fa9feecf310d`。
- 解压目录：win-unpacked **814.4 MB**；sidecar **444.9 MB**；`deskpet.exe` **234.9 MB**；app.asar **2.0 MiB**。
- zip 根目录含 `deskpet.exe`、`使用说明.txt`、`resources/sidecar/sidecar.exe`、`resources/config/model-catalog.json`，共 503 个条目。
- 冒烟：sidecar 冷启动 **942 ms** / 热启动 **824 ms**；打包应用窗口 **1652 ms**；应用启动到 `/health` 200 **2203 ms**；`/health` 状态 `ok`；退出后 runtime.json 已删、孤儿 sidecar 0、残留应用 0。
- 门禁：pytest **593** / vitest **34 文件 287 例** / pre-commit 7 钩子。
- 打包踩坑：electron-builder 从 GitHub 拉取 winCodeSign 时 `ECONNRESET`；设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 与 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后成功。

### 8.1AO 记忆可编辑 + 设置联动 + 立绘切换收尾（T2.22，2026-10-25）
- 设置「记忆与统计」：正常记忆页显示长期事实与最近 10 条对话；切换角色后设置页从 `uiStateChanged` 全窗广播更新，CDP 实测 amber → snow 记忆概览同步。
- 开发者「记忆数据」：事实 / 摘要 / 原始消息均可编辑、删除；摘要显示时间范围与来源消息；消息编辑同步 `token_len` 与 FTS。CDP 实测 1 条事实、2 条摘要、100 条消息加载，三类编辑均持久化。
- 立绘切换竞态：`loadCharacterArt()` 加载令牌 + 挂载点 `replaceChildren()` + 过期舞台 `destroy()`；CDP 连续切换 10 次后 `#stage-mount .character` 数量为 **1**，图片 `naturalWidth=1024`。
- 设置回归：使用统计暂停 / 恢复 / 清空、记忆完全重置、引擎手动重启（健康状态回到「在线」）、行为记忆开关写入并恢复 `.env`；模型配置未测试（用户指定排除）。
- 门禁：pytest **593** / vitest **34 文件 287 例** / pre-commit 7 钩子。

### 8.1AN F5/F6/F7/F9 收尾（T2.21，2026-10-23）
- 未完成事项：`MemoryEvent.follow_up=true` → CharacterState 保存，默认 2 小时后进入追问；用户回应/角色问过后移除。
- 麦克风占用：读取 Windows ConsentStore 的 `LastUsedTimeStart/Stop`，15 秒刷新；占用时主动开口硬静默并上报 `mic.busy`。
- 全屏免打扰：`SHQueryUserNotificationState` 每 20 秒读取，状态 1/2/3/4/6 视为免打扰。
- 拖拽导入：设置窗拖入 `.zip`，preload `webUtils.getPathForFile` 取路径，复用现有导入预览/冲突确认。
- 手动截屏：`Ctrl+Alt+S` 抓主屏 → OCR/视觉摘要 → 以用户消息进入对话。
- 门禁：pytest **592** / vitest **34 文件 287 例** / pre-commit 7 钩子；打包 sidecar OCR 已验证。

## 9. 已知偏差 / 还没测的

- **人格「反应种类」不是稳定指标**：见 §8.1G——同一批台词，探针关键词表一变，种类数就从 2 变成 3–5。这条只能当提示，验收看人眼扫 10 轮台词有没有同一个套路。
- **近似重复的 L0 事实会各存一行**：live 复跑里「用户喜欢喝乌龙茶」被存成两条（文本分别是「…（第 2 次提到）」与「…（第 3 次提到）」）。去重键是 `text_key`（归一化后的整句），字面不同就各存一行——当前不算 bug（召回时两条都会进上下文），但偏好类事实长期会积累同义行，留待后续决定是否做「同 kind + 高相似度归并」。
- **没有 IndexTTS 时的 TTS 告警气泡是预期噪音**：文本阶段也会尝试合成（角色包 `characters/amber/voice.json` 配了 `ref_audio`），引擎不在就 500 `DP-TTS-503`；主进程按「连续 3 次失败告警一次、每次启动最多一条」处理，所以用户会看到一条「语音引擎没有在运行…」气泡。已在 [ACCEPTANCE.md](ACCEPTANCE.md) §2 写明可忽略，不是文本阶段的缺陷。
- **smoke_memory 的 ask 阶段偶发假失败（措辞，不是召回）**：第一次整跑时模型答「你自己刚说的，还来考我」，**不含「团子」**就判失败——从回复看它明明记得（知道用户刚说过），只是不肯点名；对同一数据目录重跑 ask 立刻通过（「团子。第三遍问我就装不记得了。」）。`scripts/smoke_memory.ps1` 已加「失败后在同一实例再问一次」的兜底（第二次实测都点名）。真口径仍是人工验收：问它「我的猫叫什么」，看它答不答出名字。
- **模型输出坏 JSON 时的降级粒度**：现在只会念出坏行里的 `text` 字段，捞不到就整行丢弃并记一条 `chat.plain_text_fallback`（每轮一次）。代价是极端情况下会**静默少一句**；是否要把丢弃的行回灌给模型重写，留到语音阶段后再定。
- **首次启动 ≠ 稳定值**：见 §4 第 2 点（4.66 s vs 0.7 s）。M1 起要把「首次启动」也纳入 CI 记录。
- **没测安装/卸载耗时**、安装后首次启动、以及低配机器上的差异（本机 32 线程偏强）。这些放到 M1 的 CI 机器上比。
- **ASR 的「真实麦克风」还没测**：本轮用 wav 代替麦克风（WSL 无 `/dev/snd`），音频设备枚举、增益、静音检测（VAD 端点）这些要在 Windows 侧 T1.13 用真麦克风验收；ASR 的 CPU 推理数字已见 §5。
- **便携 exe 未签名**：当前无关卡签名（`signAndEditExecutable` 走默认、无证书时自动跳过），首次运行会有 SmartScreen 提示；v0.1 不提供 NSIS 安装包。
- **Piper TTS 只有模型下载**：Piper 权重可下载，但推理适配器尚未接入；实际发音仍走 IndexTTS 外部适配器或 Edge 在线音色。
- **完整重置不清 daily 汇总**：会清该角色的 session / char_usage / char_hits / 相关 switch_log；`daily` 是跨角色日汇总，暂不按角色拆分。
- **开发者记忆编辑暂不含 CharacterState**：事实、摘要、原始消息可改；心情 / 精力 / 关系 / 未完成事项等派生状态仍只能通过对话和完整重置间接改变。
- **本地模型库尚未统一进设置**：faster-whisper 仍在「模型供给 → 语音识别 → 本地模型」单独配置，设置页只显示当前生效值；模型权重仍在陪伴窗「模型库」。
- **IndexTTS 的性能基线还没拿到**：2026-10-15 首测时系统可用内存只有 0.5–1 GB（同机另有占 6.6 GB 的程序与 4.4 GB 内存压缩），GPU 上也还有别的负载；IndexTTS 冷加载 100.6 s、推理单步 361 s（12 字短句外推约 2.4 小时），这次只证明了「模型能加载、推理能启动」。**这不是产品性能数字**，T1.13 会在资源干净时按 REQUIREMENTS §3.2 的口径重测；前提是空闲物理内存 ≥ 4 GB 且 GPU 无重负载。

## 10. 变更记录

- **v0.53（2026-10-25）**：新增 §8.1AP **v0.2.0 正式发布**——zip 330.8 MiB、SHA256 `da7c276c...f310d`、窗口 1652 ms / health 2203 ms、pytest 593 / vitest 287；GitHub Latest 非 Pre-release。
- **v0.52（2026-10-25）**：新增 §8.1AO **记忆可编辑 + 设置联动 + 立绘切换收尾**——事实 / 摘要 / 消息编辑、最近对话、角色同步、全窗健康广播、立绘加载令牌；pytest **593** / vitest **287**。
- **v0.51（2026-10-23）**：F5/F6/F7/F9 收尾（自动追问、麦克风占用、全屏免打扰、拖拽 zip、手动截屏）；pytest **592** / vitest **287**。
- **v0.50（2026-10-23）**：新增 §8.1AM **真人感基础 + F5/F6/F7/F9**——CharacterState、`/presence` 主动策略、RapidOCR、角色包热重载；pytest **592** / vitest **287**。
- **v0.49（2026-10-22）**：新增 §8.1AL **F10 统计 / token**——LLM usage 解析、缓存命中、上下文均值/最大、记忆 token；`usage.db` 新列与旧库兼容；设置页暂停/清空；pytest **569** / vitest **278**。
- **v0.48（2026-10-22）**：新增 §8.1AK **F9 状态事实注入**——环境事件 fact 进系统提示词，user_hint 不进；pytest **565** / vitest **278**。
- **v0.47（2026-10-22）**：新增 §8.1AJ **Kaspersky 根因确认**——默认恢复 Chromium 麦克风；删除软件 AGC；原生 WDM-KS 改为默认关闭的兼容模式；保留失焦释放 / 波形 / 冷却条；vitest **278** / pytest **564** / pre-commit 7 钩子。
- **v0.46（2026-10-22）**：新增 §8.1AI **原生麦克风共存 / AGC / 面板**——shared WASAPI 尝试失败，WDM-KS 改为失焦释放、回焦恢复；AGC 4 例单测；语音波形 12 柱、互动 4 个额度点 + 冷却条；pytest **564** / vitest **287** / pre-commit 7 钩子。
- **v0.45（2026-10-22）**：新增 §8.1AH **原生麦克风兜底**——微信可录音但 Chromium/Edge WASAPI 全部 `NotReadableError`；`sidecar.exe --mic-capture` 用 WDM-KS 输出 48k/16-bit PCM，应用 2 s 收到 24 块 / 196608 B、切回文字后 helper 退出；原生模式无 AEC，助手说话时暂停收音；vitest **278** / pytest **564** / pre-commit 7 钩子。
- **v0.44（2026-10-22）**：新增 §8.1AG **角色包 zip 导入导出 + 麦克风诊断**——角色包 6 例单测通过；假音频设备授权与采集 ok；真实设备 7 个输入全报 `NotReadableError`，日志定位到 WASAPI `IAudioClient::Initialize` `0x80070057`（48000 / 32-bit float / 44100 原生格式冲突），已加三次采集回退与排查提示；门禁 tsc / eslint / vitest **276** / pytest **564**。
- **v0.43（2026-10-22）**：新增 §8.1AF **主动陪伴 / 记忆保留 / v0.1.0 便携包**——陪伴窗 780×720、模型库 8 条、主窗互动 `filter:none`；原文压缩成功后 7 天、压缩失败保留、L3 与 importance ≥ 0.8 永久、完全重置清 usage；便携 zip **253.9 MiB**、窗口 6306 ms、`/health` 7158 ms、退出无孤儿；SHA256 `785ae...782b`；门禁 pytest **564** / vitest **270**。
- **v0.42（2026-10-21）**：新增 §8.1AE **浅色奶油 UI 重排**——主窗 420×800、设置 900×640（窄窗 784 图标栏）、provider 输入 40/12px、编辑器 1000×700 12 行；模式胶囊 transform、无横向溢出；门禁 pytest **549** / vitest **261**，附 9 张真机截图。
- **v0.41（2026-10-21）**：新增 §8.1AD **三人新立绘 + 12 个身体部位框 + 重叠判定**——三张 1024×1536 RGBA 透明 PNG 替换完成，hits 各 12 个身体部位；重叠按「面积最小 → 中心最近 → 后定义」；真机三只均加载 1024×1536、窗口 791；门禁 pytest **549** / vitest **261**。
- **v0.40（2026-10-20）**：新增 §8.1AC **部位编辑可点击 + 撤销本次改动**——编辑器 / 设置窗 `alwaysOnTop` + `moveTop`，打开后 `hasFocus=true`；拖动 22 px 后按钮撤销、再拖 18 px 后 Ctrl+Z，保存的 hits rect 都回到原值；门禁 pytest **549** / vitest **250**。
- **v0.39（2026-10-20）**：新增 §8.1AB **角色菜单统一 + 角色卡编辑**——当前项 amber→snow 实时更新、z-index 10/20、菜单命中在立绘之上；卡模式只改 card/pack，hits/portrait 字节不变、菜单标签刷新、编辑器复用；门禁 pytest **549** / vitest **250**。
- **v0.38（2026-10-20）**：新增 §8.1AA **文字 / 语音 / 互动三选一**——真机默认文字、三模式同高（420×791）、语音自动开麦、听音中切文字「在听→空闲」、文字打断 **6 ms**、按住 **764 ms** 进入打断并 **761 ms** 起触摸轮；门禁 pytest **549** / vitest **246**。
- **v0.37（2026-10-20）**：新增 §8.1Z **编辑当前角色部位**——真机探针加载 10 个部位、`legs` x 0.3→0.3698、四角缩放 w 0.37→0.4459 / h 0.38→0.4114、`card.json` 字节不变、主窗 IPC 读到新 hits；门禁 pytest **549** / vitest **227**。
- **v0.36（2026-10-20）**：§8.1Y 补**聊天条 UI 重排**——三行布局（状态 / 输入+发送 / 图标动作行）、删死按钮、玻璃底 + 轻量动效 + 减少动效兜底、`ResizeObserver` 跟高度；真机窗口 420×750、最右按钮 410 < 420、无截断。
- **v0.35（2026-10-20）**：新增 §8.1Y **窗口缩小 / 台词下移 / edge-tts 开关**——真机窗口 420×726、气泡贴聊天条上方、TTS 开 26208 字节 edge 音频（XiaoxiaoNeural）、关掉后 0 新增音频；门禁 pytest **549** / vitest **222**。
- **v0.34（2026-10-20）**：§8.1X 补 **ASR 收尾**——Chromium 假音频设备跑通真实 `getUserMedia/VAD/流式识别`（首 partial **1440 ms**、12 partial）；**打包 sidecar.exe**（281.6 MB）流式 13 partial + 批处理 `/asr` 200；记录 `sidecar.spec` 的 hidden imports / 资产收集与三个修复（关麦不 cancel、缺包成 error 事件、文字输入不开识别流）。
- **v0.33（2026-10-20）**：§8.1X 补**sherpa-onnx 流式识别**——真机 5.61s 中文音频 → 13 个 partial、终稿正确、RTF **0.02**；门禁升 pytest **548** / vitest **221**；把「流式 ASR」从未做清单移出，剩「稳定 partial 投机起 LLM / AudioWorklet / 句内流式 TTS / 真麦 AEC」。
- **v0.32（2026-10-20）**：新增 §8.1X **语音全双工 P2**——`WS /ws/voice` 一条连接承载音频上行 / 事件 / 音频下行 / 取消；真机静音探针 **ok: true**（ws_open、asr.empty 回气泡）；WS 路由单测 5 例；明确记录未做的四项（流式 ASR / AudioWorklet / 句内流式 TTS / 真麦 AEC）。
- **v0.31（2026-10-18）**：§8.1W 补**新立绘 / 部位框 / 窗口菜单**真机探针——新立绘 1024×1536 正常加载、hits 10 个部位、窗口三种显示方式逐项生效（隐藏后 `visibilityState=hidden`）；附截图与叠框图。
- **v0.30（2026-10-18）**：新增 §8.1W **Stage 抽象层 + edge-tts + 云端 ASR（T2.4）**——Stage 抽象层真机回归 `smoke_text` **ok: true**（首句 4873/5522/3499 ms、打断释放 2628 ms）；edge-tts 真实合成 `你好，我是琥珀。` → 13104 字节 MP3 / gen 1587 ms；云端 ASR 仅单测。并记录本机 Windows 系统代理把 localhost 请求也送出去的环境坑（`NO_PROXY` 解法）。
- **v0.29（2026-10-18）**：新增 §8.1V **手势与互动模式（T2.3-C2c）**——纯逻辑 `touch.ts` 五档手势 + 互动模式按钮 + 设置窗「手势」菜单（写 `data/ui.json`）+ 闸门按整串条数 + `char_hits` 主键加 `gesture`（`SCHEME_VERSION` 5）+ 最小化到托盘，以及两个真坑（CDP 瞬移把 `tap` 判成 `stroke`；旧 `uiCharHit` 处理体残留 28 行）。
- **v0.28（2026-10-18）**：新增 §8.1U **角色包编辑器（T2.3 块 D）**——独立窗口四步向导（选图 / 裁切 / 画部位 / 填卡片）；主进程 `pack-editor.ts` 查文件头解码、归一化、落盘、拒绝覆盖；契约 4 条 channel + `charactersChanged` 广播。真机探针两次 `ok: true`（编辑器 **56 ms** 就绪、保存 **7 ms**、5 文件落盘、`hits.regions[0].id === "body"`、主窗角色菜单出现「探针角色」且不切走当前角色），写出的包经 sidecar `load_character_pack` 判定 `ok`。门禁：pytest **526 passed**、vitest **19 文件 185 例**、pre-commit **7 钩子**全绿。
- **v0.27（2026-10-18）**：新增 §8.1T **开发者模式里编辑 L0 记忆（T2.3-B2）**——探针一次 `ok: true`（**1651 ms**）：造事实 → 20 击开面板 → 预览含旧文本 → 行内编辑保存（横幅「已保存这条记忆，下一轮注入就用新内容。」）→ 自动刷新里旧文本消失、用新词预览时新文本进装配（14 → 16 token）→ `/memory/list` 只剩新文本（`count: 1`）；记录三个探针坑（内层 `const` 影响 `ok` 计算、`.ps1` 双 BOM、CDP 卡住变 unsettled top-level await 不写报告）。
- **v0.26（2026-10-18）**：新增 §8.1S **开发者模式与角色记忆两页（T2.3-B1）**——20 击后 `data/dev.json` `{enabled:true}`、面板出现、原文 3 行、注入 6 段（59–69 / 2500 token、`injected_ids=[1]`、L0 1 条）、关闭后 `{enabled:false}` 且面板收起，两次复跑 `ok: true`；记录一个探针侧假失败（点击全发在监听器挂上之前）与修法（`body.dataset.devReady` 就绪标记）。
- **v0.25（2026-10-18）**：新增 §8.1R **部位点击的 LLM 回应（T2.3-C2b）**——闸门两次复跑各 17 次点击只花 1 次 LLM、12 连击 0 回合；长跑 58 次点击 → `char_hits` 落库 39 行（`max_streak=12`）；真机抓到「去抖定时器早触发 → 静默丢回合」的真 bug（`HIT_FLUSH_TOLERANCE_MS = 5 ms` + 重排 + `ui.char_hit_retry` / `ui.char_hit_dropped`），含一次自造的重排空转（6564 条 retry）与三个探针坑。
- **v0.24（2026-10-18）**：新增 §8.1Q 立绘真加载与部位点击（T2.3-C2a）——修掉角色包立绘从未被加载的真 bug（`index.html` 写死占位图），立绘改走 data URL；`hits.json` 归一化部位框 + 渲染层命中换算（`cover` 改 `contain`）；8/8 逐框命中、空白静默、8 条 `ui.char_hit` 无失败；live `usage.db` 因批量 flush + `taskkill /F` 没落行（如实记录，落库由单测覆盖）。
- **v0.23（2026-10-18）**：新增 §8.1P **窗口晃动记账**（T2.3-C1）——判定在主进程纯逻辑、经 `POST /usage/record` 记账到 `session.window_shake_count`（纯 UI 会话不计会话数，行为记忆第 4 条规则）；真机探针甩窗 14 次 → 1 条 `ui.window_shake`、0 条失败；pytest 约 489 / vitest 15 文件 133 例 / pre-commit 7 钩子。
- **v0.22（2026-10-18）**：新增 §8.1O **人格导入与换人感知**（T2.3 块 A）——三只示例人格（amber / snow / momo）纯数据导入，`scripts/persona_switch_check.py` 五条判据 offline **4/4**、`--live` **5/5**；记下「渲染层写死占位图、角色包立绘不会被加载」这个待修真 bug（归 T2.3-C2）。
- **v0.21（2026-10-18）**：新增 §8.1N **拖动跟手 / 默认置顶 / 供给显示**（T2.2 真机反馈第六轮，用户 m09311）——拖动改主进程按系统光标轮询（渲染层只报 start/end、`DRAG_POLL_MS = 12 ms`、`endDrag()` 前最后对位；慢拖 160/120 → 160/120、快拖 200/150 → 200/151，修前只有 dx 5 / dy 22）；`always_on_top` 默认 true + `UI_STATE_VERSION = 2` 存档迁移；`PROVIDER_DEFAULTS` 按面回退（llm cloud / asr local / tts local）并加 `smoke_settings.mjs` 第 5 条断言。
- **v0.20（2026-10-17）**：新增 §8.1M **方形占位立绘**（T2.2 真机反馈第五轮，用户 m09242）——占位图 128×128 圆 → **512×512 方形标尺图**（Node `zlib` 自绘 RGBA，琥珀渐变 + 深色外框 + 四角 L 标 + 64 px 网格 + 中心十字 + 边缘刻度）；根因是素材 1:1 而窗口宽有 400 px 下限导致 `cover` 裁掉上下；实测窗口 **512×608**、`#stage` 与 `#character` 都是 **512×512** 且矩形一致（无裁切）。
- **v0.19（2026-10-17）**：新增 §8.1L **主窗 JS 拖动 / 托盘位置重置 / png 铺满**（T2.2 真机反馈第四轮，用户 m09037）——弃用 `-webkit-app-region`，改渲染层算位移 + 新通道 `deskpet:ui:drag` → `UiController.dragBy()`（`clampDragStep` 夹 ±400 px）→ `window.setPosition`，命中判定排除真控件（聊天条边框可拖）；托盘菜单加「位置重置到屏幕中央」；`.character` 绝对定位 `object-fit: cover`。CDP 探针：拖立绘 +40/+30、拖聊天条边框 −25/+20、拖输入框 0/0，`ui.json` 与屏幕一致。
- **v0.18（2026-10-17）**：新增 §8.1K **思考中动态气泡**（T2.2 真机反馈第三轮，用户 m08851）——占位气泡 1→2→3 个「·」400 ms 循环；抓到并修掉「等 `chat:send` resolve 才亮 → 永远不亮」的真 bug（`ChatOrchestrator.send` 的 resolve 语义是整轮结束）；`scripts/smoke_text.ps1 -Turns 3` **ok:true** + **thinking_ok:true**（首句 6408 / 5155 / 7144 ms、打断释放 2577 ms、采样帧覆盖三档点），`scripts/lib/cdp.mjs` 新增 `THINKING_BUBBLE` / `REPLY_BUBBLE` / `BUBBLE_FRAME`（`REPLY_BUBBLE` 排除占位，否则首句会变成假的 0 ms）。
- **v0.17（2026-10-16）**：§8.1J 补两段取证——`scripts/smoke_settings.ps1` 读到行为开关 `{present:true, checked:true, disabled:false}`（只看不改），以及 T2.1c 接线后的 `smoke_text`（ok，首句 4672 / 5606 / 9464 ms、打断释放 2588 ms）与 `smoke_memory -Clean`（exit 0，tell 7268 ms 命中、ask 3137 ms 点名）回归。
- **v0.16（2026-10-16）**：新增 §8.1J **行为记忆（T2.1c 方案 B 第一阶段）**——`usage.db` 计数经 `behavior_memory_service.py` 归纳成三类观察（打断 / 时段 / 偏好），写成 `kind=action` 条目并进提示词【你对他的观察】段（不裹 untrusted、检索时与 L0 事实分开）；真库端到端探针 3 条观察、二次刷新不增行、关掉开关清空；pytest **476** / vitest **14 文件 120 例** / pre-commit **7 钩子**全绿。
- **v0.15（2026-10-16）**：新增 §8.1I **主窗两行改版**——按用户 m07846 的意见把输入框改 `textarea`（40–120 px 自动增高、Enter 发送 / Shift+Enter 换行）、按钮移到输入框下一行、聊天条最小宽 560 → **400 px** 且高度不再写死；窗口尺寸改由渲染层实测的素材包围盒决定（新 IPC `deskpet:ui:metrics` → 
oteMetrics()` → 落 `data/ui.json`）。实测默认 400×336、输入框撑满时 400×416、上报 `{512,768,96}` 后 512×864，且 `resizable: false` 不阻止 `setContentSize`。§9 补「ask 阶段偶发假失败」一条。
- **v0.14（2026-10-16）**：新增 §8.1H **主窗可用性修复**——用户首次真机运行报「输入框看不见」与「窗口拖不动」：聊天条最小宽 320 → 560 px、高 56 → 64 px、输入框 40 px 高且 `min-width: 180px`（原被 8 个控件挤成 0 宽）；新增画出来的把手条 `#stage-grip` 并把 `-webkit-app-region: drag` 写到立绘上（原只写在透明 `#stage` 上，属性不继承 + 透明像素不参与命中测试 → 抓不住）。实测窗口 560×484 / 输入框 208×40 / 把手 560×26。
- **v0.13（2026-10-16）**：新增 §8.1G **F8 复测**——`persona_probe.py` 的量具两次修正（多标签 + 种类排除残差桶「其它」；补「追问」类与「不装 / 不演 / 不叫」并扩充吐槽词），同一批台词用例 1 从「2 种」变成 3–5 种（用例 2 = 5、用例 5 = 4、用例 8 = 4）；立场题仍 10/10 有异议；试调提示词 4 跑无稳定改善、已改回原样。结论：这条指标只能当提示，验收要人眼判定。
- **v0.12（2026-10-16）**：§8.1F 补 **live 复跑取证**——示例句改占位后在真实端点跑 `scripts/memory_check.py --live` 仍 4/4（装配 max 0.8 ms / p95 0.8 ms，删 id=2 后注入 [3,4]）。
- **v0.11（2026-10-16）**：新增 §8.1F **探针词与提示词示例撞车**——判据 1 一度是假通过（输出协议示例句写死「用户养了一只叫团子的猫」，正好是验收探针词）；示例句改占位叙述 + `find_probe_word_conflicts` 体检 + 一条回归测试；修完 `memory_check.py` offline 仍 4/4。
- **v0.10（2026-10-16）**：新增 §8.1E **设置窗层端到端**（`scripts/smoke_settings.ps1`：模型供给 3 卡片 + 真实「测试连接」返回 HTTP 200（635 ms）+ 记忆列出 / 单条删除 / 两次确认清空，两阶段 `EXIT=0`）；记下这一跑抓到的两个真问题（`dist/renderer/settings.html` 过期导致面板空白、残留 `electron.exe` 占单实例锁）与修法。
- **v0.9（2026-10-16）**：§8.1 补 D 段**回归复跑**（坏 JSON 修复 + 【回答问题】之后：三句首气泡 4.2 / 3.8 / 5.0 s、打断后释放 2.6 s、无错误气泡）。
- **v0.8（2026-10-16）**：新增 §8.1C **应用层端到端记忆**（`scripts/smoke_memory.ps1`：写入 → 完全退出 → 重开再问，tell 3997 ms / ask 3437 ms，`/memory/list` 命中 id=1）；记下坏 JSON 事件行导致的「残片进合成链 → TTS 告警气泡」真 bug 与修法（`_loose_text` / `_is_open_json` / 整行丢弃）及新增的【回答问题】约束；§9 补两条已知偏差。
- **v0.7（2026-10-16）**：§7 补 T2.2 复跑（首句 4.9 / 4.2 / 3.9 s、打断后释放 2.3 s）；§8 补 live 原文取证（判据 1/2 对话原文、L1/L2 摘要构成与质量）；§9 记「近似重复 L0 事实各存一行」；另加 §8.1：Electron 层同一数据目录连跑两次（第二次首句答「你刚才说过一遍了」→ 跨重启召回成立）与真实端点 m 事件落库取证。
- **v0.6（2026-10-16）**：§8 补 **live 复跑**（真实端点）：F3 四条 **4/4 通过**、整轮 **45.7 s**、装配 max **1.5 ms**；记下「中文输出过 bash 管道乱码」这一观测坑。
- **v0.1（2026-10-14）**：T0.12 首版。体积 + 启动时间 + 退出收尾实测；新增可复现脚本 `scripts/smoke_release.ps1`。
- **v0.2（2026-10-15）**：补记 IndexTTS 首测的环境前提（§6）：资源争用时加载 100.6 s / 单步 361 s，只作「能跑通」的证据，不作为性能口径。
- **v0.3（2026-10-15）**：新增 §5 **语音识别（faster-whisper）实测**（加载 ≈ 20 s、静音不幻听、8.42 s 中文 RTF ≈ 0.50、不占显存）；§2 补 ASR 技术栈版本；原 §5–§7 顺延为 §6–§8。
- **v0.5（2026-10-16）**：新增 §8 **记忆系统（F3 四条判据，T2.1b）**：`scripts/memory_check.py` offline 替身模型 **4/4 通过**、装配 max **0.8 ms**；原 §8 / §9 顺延为 §9 / §10。
- **v0.4（2026-10-15）**：新增 §7 **文字链路端到端（T1.13a）**：3 轮 CDP 冒烟（首句 5.6–8.8 s、本轮结束 10.2–15.8 s、打断后主进程释放 2.54 s）、两个真 bug 与修法；原 §7 / §8 顺延为 §8 / §9。