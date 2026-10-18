# 实测数据（MEASURED.md）

> 本文件只放「跑出来的数字」。需求与验收口径在 [REQUIREMENTS.md](REQUIREMENTS.md) §7 / §11，任务拆解在 [PLAN.md](PLAN.md)。
> 原则：凡是验收要看的性能数字，都必须能由脚本一键复现，不靠手工双击计时。

## 1. 怎么复现

```
:: 1) 产出安装包与免安装包（会顺带打 sidecar）
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1

:: 2) 实测冷启动与体积（无人值守，约 90 秒后自己退出）
powershell -ExecutionPolicy Bypass -File scripts\smoke_release.ps1
```

实测脚本做的事：给出安装包 / zip / 解压目录 / `resources\sidecar` 的体积 → 单独跑两遍 `sidecar.exe`（第一遍偏冷、第二遍偏热）测「进程启动 → `/health` 200」→ 启动打包应用测「进程启动 → 主窗口可见」与「进程启动 → `/health` 200」→ 到点走与托盘「退出」相同的收尾路径，最后核对 `runtime.json` 已删、没有孤儿进程。

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

## 3. 体积（2026-10-14，T0.12 首测）

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `release\deskpet-0.1.0-x64.exe`（NSIS 安装包） | 133.4 MB | 7z 压缩过，日常分发的就是它 |
| `release\deskpet-0.1.0-x64.zip`（免安装） | 177.1 MB | 解压即用 |
| `release\win-unpacked\`（解压后） | 429.5 MB | 安装后磁盘占用与它同量级 |
| └ `resources\sidecar\`（Python 侧） | 30.9 MB | PyInstaller onedir，101 个文件 |
| └ `deskpet.exe`（Electron 本体，改名后的 electron.exe） | 234.9 MB | 占大头；未含任何模型权重 |

结论：**体积瓶颈是 Electron 运行时，不是 Python 侧**（sidecar 只占 30.9 MB / 7%）。模型一律不打包（需求 §9.3），所以这个数字就是 M0 的地板。

## 4. 启动时间（同一次运行）

| 指标 | 实测 | 怎么测的 |
| --- | --- | --- |
| sidecar 单独冷启动 → `/health` 200（第 1 遍） | **716 ms** | `Start-Process sidecar.exe` 后轮询 `runtime.json` + 请求 `/health` |
| sidecar 单独冷启动 → `/health` 200（第 2 遍） | **603 ms** | 同上，文件已被系统缓存 |
| 打包应用：进程启动 → 主窗口可见 | **705 ms** | 轮询进程 `MainWindowHandle`（标题 `deskpet`） |
| 打包应用：进程启动 → `/health` 200 | **960 ms** | 应用自己拉起 sidecar 并完成端口握手 |
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

这一跑抓到两个真问题（已修）：① **`dist/renderer/settings.html` 是过期构建产物**——探针在设置窗里只找到 `module-list` 及以前的节点，`providers-list` / `memory-char` 根本不在 DOM；D 盘源码里有、dist 里没有（2143 字节，`node scripts/build.mjs` 重建后 3138 字节）。设置窗面板空白不是功能坏，是没人重新构建，于是 `smoke_settings.ps1` 阶段 1 先跑构建。② **上一次冒烟残留的 `electron.exe` 占着单实例锁**——新实例立刻自退，表现为读不到 `runtime.json` 且 CDP 端口 `fetch failed`；脚本进出都做一遍 `Stop-RepoProcesses`（`Get-CimInstance Win32_Process` 里 `CommandLine` 含仓库根的 `electron.exe` / `python.exe` 逐个 `taskkill /PID /T /F`）兜底。


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
- 问题 2（拖不动）：`-webkit-app-region: drag` 原先只写在透明的 `#stage` 上。① 该属性**不继承**，立绘 `#character`（`pointer-events: none`）自身算出来仍是 `no-drag`，光标落在立绘上就拖不动；② Windows 上**透明像素不参与命中测试**，`#stage` 的空透明区根本抓不住。两个原因叠起来，能抓的地方一个都没有。
- 修法：`app/main/ui-state.ts` 的 `CHAT_BAR_MIN_WIDTH` 320 → **560**、`CHAT_BAR_HEIGHT` 56 → **64**；`app/renderer/style.css` 输入框 `min-width: 180px`、高 40 px、字号 14，聊天条 padding 10 px；`app/renderer/index.html` 新增画出来的把手条 `#stage-grip`（26 px，含 `⠿` 与角色名），`style.css` 给 `#stage-grip` 与 `#character` 都写 `-webkit-app-region: drag`（把手条内文字 `pointer-events: none`，整条都能抓）；`app/renderer/index.ts` 让把手上的角色名随角色切换更新（`renderGrip()` + `characterNames` 映射）。
- 实测（CDP 量几何 + 截图，临时探针 `scripts/_probe_ui.mjs` 跑完即删）：窗口 **560×484**；输入框 **208×40**（x=54 / y=433，气泡提示「说点什么…」完整可见）；`#stage-grip` **560×26**，`-webkit-app-region: drag`、`background: rgba(20, 22, 28, 0.92)`；`#character` **128×128** 且 `-webkit-app-region: drag`（`pointer-events: none`）；聊天条 560×64 `no-drag`；健康小圆点仍在右下角。按钮宽度依次 mic 38 / 发送 46 / 打断 46 / 角色 46 / 设置 46 / 暂停 34。
- 回归：`tests/ui-state.test.ts`（尺寸公式改为「宽度取立绘包围盒与聊天条最小值的较大者」）、`tests/ui-controller.test.ts`（2× → 640×904、1.5× → 560×694）；vitest **13 文件 108 例全过**，eslint / tsc 干净。
- 教训：**把手写在一个透明的容器上等于没写**——桌面宠物的拖动区必须落在真正画出来的像素上（把手条或立绘本身），否则 Windows 的命中测试不会把鼠标事件交给这个窗口；同理，一行按钮堆满的固定宽度栏，绝不能让输入框带 `min-width: 0`。

### 8.1I 主窗两行改版：窗口尺寸随素材走（T2.2 真机反馈第二轮，2026-10-16）

- 起因：用户 m07846 提了四点——「为什么不把拖动放在聊天输入框」「输入框会自动换行变长」「输入框下面放按钮」「ui 判定框大小会随着 png 或者 live2d 改变吗」。
- 定案（为什么不能照第一点做）：`-webkit-app-region: drag` 的元素**收不到鼠标事件**，把输入框设成 drag 就点不进去、也选不了字，所以拖动区仍是左上角药丸把手 `#stage-grip`（带角色名）+ 立绘本身；输入框改 `textarea` 并自动增高；按钮移到输入框下一行 `.chat-actions`；窗口尺寸由渲染层实测的素材包围盒推出。
- 改动：`app/main/ui-state.ts`（`PET_STAGE_WIDTH/HEIGHT` 320/420 → **128/128**（占位 PNG 真实尺寸）、新增 `STAGE_MIN_WIDTH/HEIGHT = 240` / `STAGE_MAX = 2048` / `CHAT_BAR_MIN_WIDTH = 400` / `CHAT_BAR_HEIGHT = 92` / `CHAT_BAR_HEIGHT_MIN/MAX = 56/320` 与 `clampStage()` / `clampChatbarHeight()`、`computePetWindowSize(scale, stage, chatbarHeight)`、`parseUiState` 解析 `stage_width` / `stage_height`）；`app/main/ui-controller.ts`（`noteMetrics()` + `appliedSize` 去重）；`app/main/ipc.ts` + `ipc-handlers.ts` + `app/preload/api.ts` + `app/preload/index.ts`（新通道 `deskpet:ui:metrics`，`UiMetricsMessage { stage_width, stage_height, chatbar_height }`）；`app/renderer/index.html`（`textarea` + `.chat-actions` 一行按钮）、`style.css`（左上角药丸把手、聊天条 `flex-direction: column`、输入框 `min-height: 40px` / `max-height: 120px`）、`index.ts`（`autoGrowInput()` / `reportMetrics()` / `applyArtScale()`、Enter 发送 / Shift+Enter 换行）。
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

**托盘与 png 铺满**：`app/main/index.ts` 的 `createTray()` 新增菜单项「位置重置到屏幕中央」→ `UiController.resetPosition()`（`screen.getDisplayNearestPoint(窗口位置).workArea` 居中 + `noteMoved` 落盘 + `logger.info("ui.position_reset")`），托盘图标显式 `resize({ width: 16, height: 16 })`；`.character` 改为 `position: absolute; inset: 0; width/height: 100%; object-fit: cover`（窗口高度仍按素材宽高比算，所以真实立绘不会被拉变形）。

**实测（真实 Electron + CDP 合成鼠标事件，临时探针 `scripts/_probe_drag.mjs` + `_probe_drag.ps1`，跑完两侧已删）**：拖立绘 **+40 / +30**、拖聊天条边框 **−25 / +20**、拖输入框 **0 / 0**（不动，证明控件仍归控件）；`#character` 与 `#stage` 矩形完全一致（**400×240**，`object-fit: cover`、`position: absolute`，占位 PNG natural 128×128）；拖动后 `data/ui.json` 落盘 `x=15 / y=50`，与 `window.screenX/screenY` 一致。`vitest` **14 文件 122 例**（新增 `dragBy` 夹取与 `resetPosition` 居中两例）。

**教训**：判断「某个平台自带行为能不能自动验证」要前置——app-region 拖动与 CDP 合成事件不兼容，改成一进一出走自己的 IPC 之后，整条链路（位移量、越界夹取、落盘）都能在真机上量。

### 8.1M 方形占位立绘：尺寸一眼可见（T2.2 真机反馈第五轮，2026-10-17）

**用户 m09242（verbatim）**：「png画个方形的，我好直观看到大小」。

**为什么旧图看不出大小**：`app/renderer/assets/placeholder.png` 是 **128×128、画的是一个圆**。窗口尺寸 = `max(素材宽 × 缩放, 聊天条最小宽 400, 立绘区下限 240)` × `max(素材高 × 缩放, 240) + 聊天条实测高`，所以在 1× 下立绘区是 **400×240（宽 > 高）**，1:1 的圆被 `object-fit: cover` 切掉上下，看过去只剩一条被裁的圆弧——既没有边界也没有尺度感。

**做法**：重画成 **512×512 的方形标尺图**，用 Node `zlib` + 手写 PNG 编码（colorType 6 / RGBA，不新增依赖）：琥珀色纵向渐变底、10 px 深色外框（压住毛边）、四角 64×8 的白色 L 标（「这就是窗口四角」）、每 64 px 一条 alpha 28 的网格、中心 alpha 90 的十字、上边与左边每 32 px 短刻度 / 每 128 px 长刻度。512 宽 ≥ 400 的下限，所以 1× 时立绘区正好是正方形的 512×512，**画出来的方形边界与窗口边界重合**，鼠标拖到哪、窗口多大都一眼可读。

**实测（真实 Electron + CDP 探针 `scripts/_probe_square.mjs`，跑完两侧已删）**：窗口 `inner` **512×608**；`#stage` **512×512** 与 `#character` **512×512** 矩形完全一致（`object-fit: cover` 但无裁切）；素材 `naturalWidth/Height` **512×512**；聊天条 **96**；拖动把手 `#stage-grip` 在 (8, 8)、61×24，仍为 `drag`。

**教训**：占位素材的**宽高比要和「窗口宽有下限」这件事对齐**——只要素材不是 1:1 或者比下限还窄，`cover` 就一定会在某个方向上裁掉内容；要让「画出来的形状 = 窗口形状」，素材自然宽必须 ≥ 聊天条最小宽。

### 8.1N 拖动跟手 / 默认置顶 / 供给显示：三条真机反馈（T2.2 真机反馈第六轮，2026-10-18）

**用户 m09311（verbatim）**：「1.拖动不更手，拖动过快会拖不了。2.点击桌面后窗口会消失，得在托盘再点回来。3.设置里面的语言模型那块我现在用的是云端却显示本地。」

**① 拖动不跟手 → 位移改由主进程按系统光标算**：旧实现（v1.46）在渲染层用 `event.clientX - dragLastX` 算增量，窗口跟着光标移动后该差值趋近 0。真机探针（P/Invoke `SetCursorPos` + `mouse_event`，20 步 +8/+6）实测光标 +160/+120 时窗口只走 **dx 5 / dy 22**。新实现：渲染层只报 `{"action":"start"|"end"}`，`app/main/ui-controller.ts` 的 `beginDrag()` 记「抓点偏置 = `screen.getCursorScreenPoint()` − `window.getBounds()`」，`stepDrag()` 每 `DRAG_POLL_MS = 12 ms` 把窗口摆到「光标 − 偏置」（同位置不重复 `setPosition`），`endDrag()` 清状态**前再对一次光标**（快速甩动时最后一次轮询会落后一步）。修复后同探针：慢拖光标 +160/+120 → 窗口 **+160/+120**；快拖 +200/+150（4 步、每步 4 ms、松手前多等 250 ms）→ 窗口 **+200/+151**。`DRAG_STEP_MAX` / `clampDragStep` 已删，`PetWindowHandle.moveBy` 换成 `cursor` 依赖。

**② 点桌面后窗口消失 → 默认置顶 + 存档迁移**：真机探针证明不是 `hide()`：`always_on_top=false` 时窗口自身 `IsWindowVisible=True`，但 `WindowFromPoint(窗口中心)`（经 `GetAncestor(..., GA_ROOT)`）返回的是另一个最大化窗口（rect −8,−8,2568,1400）；置顶时返回本窗口。`DEFAULT_UI_STATE.always_on_top` 改 **true**，新增 `UI_STATE_VERSION = 2`，`parseUiState` 用 `resolveAlwaysOnTop()`（缺 `version` 或 <2 强制 true），`writeUiState` 补写 `version`。实测：手写 v1 存档（无 `version`、`always_on_top:false`）启动后 `WS_EX_TOPMOST`（`GetWindowLong(h, -20) & 0x8`）为 true，点击别处后窗口中心仍属本窗口，拖动落盘后 `ui.json` 变成 `{"always_on_top":true,"version":2}`。

**③ 实际云端却显示本地 → provider 回退按面**：`app/main/provider-settings.ts` 的 `toProviderValue` 原先对未设/非法值一律回退 `local`，而 sidecar 默认按面不同（`LlmSettings.provider = PROVIDER_CLOUD`、`AsrSettings.provider = TtsSettings.provider = PROVIDER_LOCAL`），用户 `.env` 里没有 `DESKPET_LLM_PROVIDER` → sidecar 用 cloud、界面显示 local。新增 `PROVIDER_DEFAULTS = { llm: "cloud", asr: "local", tts: "local" }` 后，`scripts/smoke_settings.ps1` 整跑 **rc=0**：`selected=[{llm,cloud},{asr,local},{tts,local}]` 与心跳 `providers` 完全一致、`mismatch=[]`；同次 tell 首句 3818 ms（命中 id=1）、LLM 真实探测 HTTP 200 · 794 ms、记忆 1→0、清空二次确认、行为开关 `{present:true,checked:true,disabled:false}`。

**门禁**：pytest **476 passed**、vitest **14 文件 124 例**、pre-commit **7 钩子全过**（`tests/ui-controller.test.ts` 的拖动用例改成 beginDrag/stepDrag/endDrag + `vi.useFakeTimers`，并断言 `endDrag()` 前最后对位；`tests/provider-settings.test.ts` 改成按面默认；`tests/ui-state.test.ts` 加 v1→v2 迁移用例；`tests/ipc-contract.test.ts` 对账 `UI_DRAG_ACTIONS`）。

**教训**：① 位移回路的反馈信号如果和被测对象同源（窗口移动 → `clientX` 变化 → 又拿 `clientX` 算位移）就会自相抵消；这类「跟手」逻辑必须取**窗口外**的参考量（系统光标屏幕坐标）。② 改完主进程代码不跑 `node scripts/build.mjs` 就起 electron，探针读到的是旧行为（`dist/main/index.js` 是 esbuild 产物）。③ 探针测拖动要在 mousedown 之后、移动之前 sleep 250 ms，否则 `beginDrag()` 的偏置在光标已移一步后才采到，窗口恒定落后一个步长（+152/+114 而非 +160/+120，是探针假象）。
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

**抓到并修掉的真 bug（静默丢回合）**：短跑三次里有**一次** 5 连击没有起任何回合——没有 `chat.start`、没有 `ui.char_hit_skipped`、也没有失败日志，5 条 `ui.char_hit` 都在。唯一可能的路径是定时器回来时 `flush()` 返回 null（`now < dueAt`，Node 定时器走单调时钟、判定用 `Date.now()`，早一两毫秒就够了）→ 整串点击被无声吞掉。修法：`HIT_FLUSH_TOLERANCE_MS = 5 ms` 容差 + 到点没发成按 `remainingMs()` 重排；闸门已经取消这一串（≥10 下）时清掉待发并记 `ui.char_hit_dropped`，绝不空转。

**中间还踩了自己一个坑**：第一版重排逻辑只按 `remainingMs()` 排，没区分「还没到点」与「这串已被闸门取消」（后者 `remainingMs()` 为 0 → 1 ms 重排），两次复跑打出 **6564 条 `ui.char_hit_retry`** 的空转；补 `hasPending()` 之后归零（复跑 `RETRY=0 / FIRED=1 / DROPPED=1`）。

**还没测 / 已知偏差**：`double` / `hold` 两种 `kind` 只有单测（真机双击与长按没做）；部位框仍是目测估的（块 D 编辑器做可视调整）；模型对互动文案的语气只做了人眼抽查。

**坑**：① 探针的每次 CDP 点击**都会同时触发主进程的拖动逻辑**（`ui.drag_start` / `ui.drag_end` 一次点击各一条，长跑里 62 条），窗口被拉着追真实系统光标，于是同一批点击的落点会漂到别的部位——长跑里 `char_hits` 出现 chest / skirt / waist 就是这么来的；要量「某个部位」的命中就得像 C2a 那样每次点击前重新量几何。② `usage.db` 的批量窗口是 **300 s**（`DEFAULT_FLUSH_INTERVAL_S`，没有 env 可改），短跑里 `flush()` 不会触发、表是空的；要验记账必须跑够 5 分钟，或直接跑单测。③ PowerShell 的 `>` 重定向写 UTF-16LE，读回要 decode；`sqlite3.connect()` 会凭空建一个 0 字节库，读不存在的库会报 `no such table`（不是功能问题）。
## 9. 已知偏差 / 还没测的

- **人格「反应种类」不是稳定指标**：见 §8.1G——同一批台词，探针关键词表一变，种类数就从 2 变成 3–5。这条只能当提示，验收看人眼扫 10 轮台词有没有同一个套路。
- **近似重复的 L0 事实会各存一行**：live 复跑里「用户喜欢喝乌龙茶」被存成两条（文本分别是「…（第 2 次提到）」与「…（第 3 次提到）」）。去重键是 `text_key`（归一化后的整句），字面不同就各存一行——当前不算 bug（召回时两条都会进上下文），但偏好类事实长期会积累同义行，留待后续决定是否做「同 kind + 高相似度归并」。
- **没有 IndexTTS 时的 TTS 告警气泡是预期噪音**：文本阶段也会尝试合成（角色包 `characters/amber/voice.json` 配了 `ref_audio`），引擎不在就 500 `DP-TTS-503`；主进程按「连续 3 次失败告警一次、每次启动最多一条」处理，所以用户会看到一条「语音引擎没有在运行…」气泡。已在 [ACCEPTANCE.md](ACCEPTANCE.md) §2 写明可忽略，不是文本阶段的缺陷。
- **smoke_memory 的 ask 阶段偶发假失败（措辞，不是召回）**：第一次整跑时模型答「你自己刚说的，还来考我」，**不含「团子」**就判失败——从回复看它明明记得（知道用户刚说过），只是不肯点名；对同一数据目录重跑 ask 立刻通过（「团子。第三遍问我就装不记得了。」）。`scripts/smoke_memory.ps1` 已加「失败后在同一实例再问一次」的兜底（第二次实测都点名）。真口径仍是人工验收：问它「我的猫叫什么」，看它答不答出名字。
- **模型输出坏 JSON 时的降级粒度**：现在只会念出坏行里的 `text` 字段，捞不到就整行丢弃并记一条 `chat.plain_text_fallback`（每轮一次）。代价是极端情况下会**静默少一句**；是否要把丢弃的行回灌给模型重写，留到语音阶段后再定。
- **首次启动 ≠ 稳定值**：见 §4 第 2 点（4.66 s vs 0.7 s）。M1 起要把「首次启动」也纳入 CI 记录。
- **没测安装/卸载耗时**、安装后首次启动、以及低配机器上的差异（本机 32 线程偏强）。这些放到 M1 的 CI 机器上比。
- **ASR 的「真实麦克风」还没测**：本轮用 wav 代替麦克风（WSL 无 `/dev/snd`），音频设备枚举、增益、静音检测（VAD 端点）这些要在 Windows 侧 T1.13 用真麦克风验收；ASR 的 CPU 推理数字已见 §5。
- **NSIS 未签名**：当前是无关卡签名（`signAndEditExecutable` 走默认、无证书时自动跳过），首次运行会有 SmartScreen 提示；签名方案等 M5 发布阶段再定。
- **IndexTTS 的性能基线还没拿到**：2026-10-15 首测时系统可用内存只有 0.5–1 GB（同机另有占 6.6 GB 的程序与 4.4 GB 内存压缩），GPU 上也还有别的负载；IndexTTS 冷加载 100.6 s、推理单步 361 s（12 字短句外推约 2.4 小时），这次只证明了「模型能加载、推理能启动」。**这不是产品性能数字**，T1.13 会在资源干净时按 REQUIREMENTS §3.2 的口径重测；前提是空闲物理内存 ≥ 4 GB 且 GPU 无重负载。

## 10. 变更记录

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
- **v0.15（2026-10-16）**：新增 §8.1I **主窗两行改版**——按用户 m07846 的意见把输入框改 `textarea`（40–120 px 自动增高、Enter 发送 / Shift+Enter 换行）、按钮移到输入框下一行、聊天条最小宽 560 → **400 px** 且高度不再写死；窗口尺寸改由渲染层实测的素材包围盒决定（新 IPC `deskpet:ui:metrics` → `noteMetrics()` → 落 `data/ui.json`）。实测默认 400×336、输入框撑满时 400×416、上报 `{512,768,96}` 后 512×864，且 `resizable: false` 不阻止 `setContentSize`。§9 补「ask 阶段偶发假失败」一条。
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