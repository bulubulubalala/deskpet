# deskpet

常驻 Windows 桌面的 AI 伴侣：有形象、有声音、语音可随时打断、记得住你、会主动找你、看得到屏幕、人格稳定不谄媚；**不操作你的电脑**；可打包为 exe 分发。

- 状态：**需求 v1.55 与代码规范 v1.7 均已冻结；M0 已完成（T0.1–T0.13 全部收尾，含复盘），M1 已开工——P6 已定案并收尾（IndexTTS 常驻 HTTP 适配器 `tools/indextts_adapter`，契约见需求 §6.12），T1.1 契约扩展已完成，T1.2 最小可换角色包已完成（示例角色包 `characters/amber/`），T1.3 LLM 客户端已完成（`/chat/stream` 成为第一条真实现的路由：§6.2 新增 `e` 错误事件与解析降级规则；真实端点端到端冒烟通过），T1.4 ASR 接入已完成（faster-whisper `small` + int8 + CPU，`/asr` 成为第二条真实现的路由：15s 超时、空 / 幻觉文本不喂 LLM；真实音频冒烟通过），T1.5 TTS 适配器接入已完成（`/tts` 与 `/tts/cancel` 成为第三、四条真实现的路由：调 `tools/indextts_adapter`，单句 ≤40 字、单句超时 30s、引擎侧 `{code,message,hint}` 原样透传），**T1.6 全双工状态机（sidecar 侧）已完成**（`sidecar/core/voice_state.py` 单一状态入口：活动集合推导五态、取消抬 `generation`、三条路由用 `voice.activity` 包住、`/health` 新增 `voice` 字段），**T1.6b 主进程编排已完成**（`app/main/sidecar-client.ts` 的 HTTP / SSE 客户端 + `chat-orchestrator.ts` + `character-voice.ts` + 六条 IPC + `deskpet:tts:audio` 音频回传；**不注册全局热键**，打断走 `deskpet:chat:cancel`），**T1.9 usage.db 记录层已完成**（`sidecar/core/usage.py` + `sidecar/adapters/usage_sqlite.py` + `sidecar/services/usage_service.py`：只记不注入、先写库后结算增量、暂停记录开关、与 `memories.db` 分离），**T1.10 环境事件契约已完成**（`sidecar/core/env_events.py`：十种事件类型 + `fact` / `user_hint` 分离；ASR → `asr.empty`、TTS → `tts.failed`、网络 → `net.down` 各接一处，恢复即撤销；记忆与屏幕的接点随各自模块），**T1.11 反谄媚人格已完成**（`sidecar/core/prompt.py` 默认反附和模板 + `build_variation()` 注入【此刻的状态】（时段 / 情绪 / 关系温度）；人工用例 `docs/PERSONA_CASES.md` + 探针 `scripts/persona_probe.py`；pre-commit 的 ruff 覆盖面扩到 scripts/），**T1.12a 界面形态 + 聊天条（文字版）已完成**（桌宠主窗：无边框 + 透明 + 不进任务栏、立绘即拖动把手、立绘下方聊天条 + 气泡 + 健康小圆点、透明区穿透、位置与缩放记 `data/ui.json`、设置窗 720×520、§6.10 补登记 6 条界面 channel；CDP 实测无标题栏与菜单、kill sidecar 小圆点变红而形态不变），**T1.13a 文字闭环验收已完成**（`scripts/smoke_text.mjs` + `smoke_text.ps1` 拉起真实 Electron 走 CDP：3 轮对话、第 2 轮中途打断；首句 5.6–8.8 s、打断后主进程释放 2.54 s；修掉两个渲染层真 bug——解锁信号改看语音状态、界面就绪标记 `data-ready`）。**T1.8「推理资源闸门 / GPU 锁」已取消**（项目不做任何 GPU 功能，一切模型只负责调用，见需求 D18）；此后按「**文字优先**」推进（T1.11 ✅ → T1.12a ✅ → T1.13a ✅ → 语音 T1.7 → T1.12b → T1.13b，顺序依据见 [docs/PLAN.md](docs/PLAN.md)）**（任务拆解与复盘见 [docs/PLAN.md](docs/PLAN.md)）** **2026-10-15 新决策**：模型供给层改**本地 / 云端双轨**（本地 provider 后置）、语音输入键定**「按住说话」**、**文本阶段必须包含记忆系统**、**角色包导入 / 导出版优先级下调**、**示例角色包先不配音**；**文本功能验收通过后再打首个正式 tag**（排期见 [docs/PLAN.md](docs/PLAN.md) §7.8）。**2026-10-15 追加 v1.35**：**不假设部署环境**（不再列复用清单与显卡预算）、**情感改走 IndexTTS 自带的文本输入**（`emo_text` + `emo_alpha`，本项目不拼 8 维向量）。**T1.14a 模型供给层（sidecar + 契约 + TS 侧）已完成**：`DESKPET_{LLM,ASR,TTS}_PROVIDER` + 端点回退、`usage.db` 会话行三列 provider（旧库自动补列）、`/health` 新增 `providers`、云端 ASR / TTS 明确报未实现而不静默降级。**T1.14b 设置窗「模型供给」+「测试连接」已完成**：三面各一张卡片（来源云端 / 本地 + 端点 / 模型 / 密钥 + 保存 / 测试），配置只写 `.env`（原地改值、保住注释与键顺序）、**密钥只写不回显**（视图只有「已配 / 未配」两个布尔量），新增鉴权路由 `POST /providers/test`（结论契约里没有 `api_key`）与三条 IPC channel；pytest 326 / vitest 13 文件 104 例 / pre-commit 7 钩子全绿。**T1.14 全部完成**。**T2.1a 记忆系统底座已完成（2026-10-16）**：`sidecar/core/memory.py` + `sidecar/adapters/memory_sqlite.py`（SQLCipher 整库加密 + FTS5）+ `adapters/memory_key.py` / `dpapi.py`（主密钥经 DPAPI 托管，解不开报 `DP-MEM-001`、不退化明文）+ `services/memory_service.py`（对话链路读写失败只降级：读失败=这轮没有记忆、写失败只记日志并上报 `mem.readonly` / `mem.key_invalid`；管理端点抛 `DP-MEM-001` / `002` / `003`）+ 四层读取装配与 prompt 注入（`build_messages(..., recall=...)`，L0 片段与用户原话用 `<untrusted_input>` 包住）+ 五条 `/memory/*` 路由（新增 `GET /memory/list` 与 `POST /memory/clear`，其余摘掉 501 桩）+ 12 个 `DESKPET_MEMORY_*` 配置键；pytest **400** / vitest **13 文件 104 例** / ruff / mypy **60 + 9** / pre-commit **7 钩子**全绿。**T2.1b 已完成（2026-10-16）**：`sidecar/services/memory_summary_service.py` 的 `MemorySummarizer` 生成阶梯摘要（L1 由未覆盖消息按条数 / token 阈值触发、生成后 `mark_covered`；L2 / L3 由下层摘要按 `summaries.source_ids` 聚合、不重复聚合；后台 `schedule()` 跑、失败只记日志不影响本轮）+ 三个新阈值键（`SUMMARY_BATCH_MESSAGES` / `L1_AGGREGATE_SUMMARIES` / `L2_AGGREGATE_SUMMARIES`）+ 设置窗「记忆」面板（按角色列出种类 / 层级 / 重要度 / 记于 / 用过几次、单条删除、清空二次确认）+ 三条记忆 IPC channel（`deskpet:memory:list` / `memory:delete` / `memory:clear`）+ F3 四条验收脚本 `scripts/memory_check.py`（重开记得上次话题 / 100 轮后仍记得第 10 轮 / 装配 <80ms 且来源可追溯 / 单条删除即时生效；offline 替身模型 **4/4 通过**，装配 max **0.8ms**）；pytest **420** / vitest **13 文件 108 例** / ruff / mypy **61 + 9** / pre-commit **7 钩子**全绿。**T2.1 全部完成，下一步 T2.2 文本闭环复验与用户验收。**（2026-10-16 T2.2 自动侧已完成：`scripts/smoke_text.ps1 -Turns 3` 3 轮通过——首句 3.9–4.9 s、打断后主进程释放 2.3 s；`scripts/memory_check.py` offline / `--live` 均 **4/4**，live 整轮 45.7 s、装配 max 1.3–1.5 ms；补测：同一数据目录连跑两次应用后，第二次仍记得上一会话（首句回「这话你刚才说过一遍了」），真实端点会按协议吐 m 事件并落成 L0 事实——原文与摘要样本见 [docs/MEASURED.md](docs/MEASURED.md) §8 / §8.1；三条人工验收步骤见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)，**等验收通过后打首个正式 tag**；同日自动侧补强：新增应用层端到端记忆冒烟 `scripts/smoke_memory.ps1`（写入事实 → 完全退出 → 重开再问，两阶段都通过——tell 首句 3997 ms 且 `/memory/list` 命中 id=1，重开后首句 3437 ms 答出「团子」），并修掉「模型写出坏 JSON 事件行 → 残片被逐句送进合成链、刷出 TTS 告警气泡」的真 bug，同时给提示词加【回答问题】约束（问起记得的事必须给出具体内容）；修完后文字链路回归复跑无回归（首句 4192 / 3796 / 5004 ms、打断后释放 2559 ms，见 [MEASURED.md](docs/MEASURED.md) §8.1D）；同日自动侧再补一层**设置窗端到端冒烟** `scripts/smoke_settings.ps1`（脚本自建 dist、同一数据目录起两次真实 Electron：模型供给面板 3 张卡片 + 真实「测试连接」返回「✓ cloud · HTTP 200（635 ms）」、记忆列出 1 行 → 单条删除 0 行 → 清空需点两次，两阶段 `EXIT=0`），顺带定因并修掉两个真问题——`dist/renderer/settings.html` 是过期构建产物（设置窗面板空白不是功能坏）与残留 `electron.exe` 占单实例锁（后续冒烟静默起不来），详见 [MEASURED.md](docs/MEASURED.md) §8.1E）；同日补测发现验收有效性 bug 并修掉：`sidecar/core/prompt.py` 的输出协议示例句写死「用户养了一只叫团子的猫」，正撞 `scripts/memory_check.py` 判据 1 的探针词「团子」，不看记忆也会答「我记得：团子」（**判据 1 一度是假通过**）——示例句改占位叙述、脚本新增 `find_probe_word_conflicts()` 在跑判据前强制体检（探针词一旦出现在提示词素材或角色卡里即失败）、并加回归测试锁住示例句；体检函数做过反向验证，修完 offline 复跑仍 4/4，详见 [MEASURED.md](docs/MEASURED.md) §8.1F）；同日复测 F8 人格：`scripts/persona_probe.py` 的量具修了两轮（改成多标签、种类统计排除残差桶「其它」、补「追问」类与「不装 / 不演 / 不叫」并扩充吐槽词），同一批台词用例 1 从「2 种」变 **3–5 种**动作（用例 2 = 5 / 用例 5 = 4 / 用例 8 = 4），立场题 **10/10** 仍敢反驳；试调提示词 4 跑无稳定改善、已改回原样——结论是这条指标只能当提示、验收看人眼扫台词（详见 [MEASURED.md](docs/MEASURED.md) §8.1G）；同日按用户**首次真机反馈**修了两个界面可用性问题：聊天条最小宽度 320 → **560 px**、高度 56 → **64 px**、输入框 40 px 高且 `min-width: 180px`（原先 8 个控件把 `flex: 1; min-width: 0` 的输入框挤成 **0 宽**，看不见自己打什么），并新增画出来的拖动把手条 `#stage-grip`（含角色名）且把 `-webkit-app-region: drag` 写到立绘上（原先只写在透明的 `#stage`——该属性**不继承**、Windows 上**透明像素不参与命中测试**，于是窗口一个能抓的地方都没有）；修后实测窗口 **560×484**、输入框 **208×40**、把手 **560×26**（详见 [MEASURED.md](docs/MEASURED.md) §8.1H）；同日按用户**第二轮真机反馈**把主窗改成两行布局：输入框改 `textarea`（高 40–120 px 自动增高，**Enter 发送 / Shift+Enter 换行**）、按钮移到输入框下一行、聊天条最小宽度 560 → **400 px** 且高度不再写死；**窗口尺寸改由渲染层实测的素材包围盒推出**——新增 IPC `deskpet:ui:metrics`，渲染层量 `#character` 的 naturalWidth/Height 与 `#chatbar` 实际高度上报，主进程算 `max(包围盒 × 缩放, 立绘下限 240, 聊天条下限 400) × (max(包围盒高 × 缩放, 240) + 实测聊天条高)` 并把包围盒落 `data/ui.json`，**M3 换成 Live2D 后自动跟随新包围盒**（拖动把手相应改成左上角药丸）；实测默认窗口 **400×336**、输入框撑满时 **400×416**、上报 `{stage_width:512, stage_height:768}` 后 **512×864**，`resizable: false` 不阻止 `setContentSize`（详见 [MEASURED.md](docs/MEASURED.md) §8.1I）；同日完成 **T2.1c 行为记忆**（方案 B 第一阶段，用户 m08166）：把 `usage.db` 已有计数归纳成【你对他的观察】（打断频率 / 使用时段 / 角色偏好共 3 条规则），`kind=action`、提示词单独成段且**不裹 untrusted**、检索时用 `exclude_kinds` 与 L0 事实分开、观察预算 200 token、总开关写 `.env` 后重启生效（**关掉会清掉已派生的观察**），设置窗记忆段新增「行为记忆」复选框（详见 [MEASURED.md](docs/MEASURED.md) §8.1J）；**T2.1c 的界面层取证已补齐**——`scripts/smoke_settings.mjs` 新增第 4 条断言（「行为记忆」开关在场且可用，**只读不改**，免得冒烟动到仓库根 `.env`），整跑 `smoke_settings.ps1` **EXIT=0**（模型供给 3 卡片 + 真实「测试连接」HTTP 200 · 121 ms、记忆 1 → 删除 → 0 行、清空二次确认、开关读到 `{present:true, checked:true, disabled:false}`），同轮 `smoke_text -Turns 3` **ok**（首句 4672 / 5606 / 9464 ms、打断释放 2588 ms）与 `smoke_memory -Clean` **exit 0**（tell 7268 ms 命中 id=1、ask 3137 ms 点名）（详见 [MEASURED.md](docs/MEASURED.md) §8.1J，v0.17）；2026-10-17 按用户 m08851 补 **思考中动态「·」气泡**（需求 v1.45）：发出到首句台词回来之间气泡显示 **1→2→3 个「·」**（400 ms 一跳），**在主进程回话前就亮**——`ChatOrchestrator.send` 要等整轮（含合成收尾）才 resolve，等它返回占位气泡永远不出现（真机冒烟三轮 `thinking_ms=0`）；冒烟新增 `THINKING_BUBBLE` / `REPLY_BUBBLE` / `BUBBLE_FRAME` 判据与 `thinking_ok` 断言，`smoke_text -Turns 3` **ok** + **thinking_ok**（首句 6408 / 5155 / 7144 ms、打断释放 2577 ms、采样帧覆盖三档点）（详见 [MEASURED.md](docs/MEASURED.md) §8.1K，v0.18）；2026-10-17 按用户 m09037 再补 **主窗 JS 拖动 / 托盘位置重置 / png 铺满**（需求 v1.46）：弃用 `-webkit-app-region`（透明像素不参与命中测试、不继承、CDP 也验证不到），改渲染层算位移经新通道 `deskpet:ui:drag` 交主进程 `setPosition`，命中判定排除真控件——**聊天条边框现在也能拖**；托盘右键菜单加「位置重置到屏幕中央」；立绘 `object-fit: cover` 铺满立绘区。CDP 探针：拖立绘 +40/+30、拖聊天条边框 −25/+20、拖输入框 0/0（详见 [MEASURED.md](docs/MEASURED.md) §8.1L，v0.19）；2026-10-17 按用户 m09242「png画个方形的，我好直观看到大小」把默认占位素材换成 **512×512 方形标尺图**（需求 v1.47）：用 Node `zlib` 自绘 RGBA（琥珀渐变 + 深色外框 + 四角 L 标 + 64 px 网格 + 中心十字 + 边缘刻度），因为旧图是 1:1 的圆、而立绘区被聊天条最小宽 400 px 撑成 400×240，`object-fit: cover` 会把上下切掉；探针实测窗口 **512×608**、`#stage` 与 `#character` 都是 **512×512** 且矩形一致（详见 [MEASURED.md](docs/MEASURED.md) §8.1M，v0.20）第六轮真机反馈（用户 m09311）已修：拖动改主进程按系统光标轮询（慢拖 +160/+120、快拖 +200/+151，修前 dx 5 / dy 22）、`always_on_top` 默认 true + `UI_STATE_VERSION = 2` 存档迁移（点桌面不再被最大化窗盖住）、provider 回退按面（llm cloud / asr local / tts local）并加「界面所选 = 心跳 providers」断言；详见 [MEASURED.md](docs/MEASURED.md) §8.1N，v0.21）；2026-10-18 按用户 m09592「去 hermes 根目录 personas 文件夹导入三个人格设定，测试能不能感知到换人」与 m09622「amber、snow、momo」、m09634 批准方案，完成 **T2.3 块 A**：`characters/amber` 重写对齐 `amber-sfw.md`，新建 `characters/snow`（银白狐娘）与 `characters/momo`（黑狼娘）两个示例角色包（纯数据导入、**不写 voice.json**、512×512 三色方形立绘）；新增 `scripts/persona_switch_check.py` 五条判据（人格生效 / 记忆隔离 / 切换留痕 / 观察派生 / 风格可分）**offline 4/4、--live 5/5**（同一句「我今天有点累。」→ amber「几点了心里没数。」/ snow「……几点了几点。别报，我不想听。」/ momo「哦。坐。」）；开发者模式开关定 `data/dev.json`、部位点击次数按整串累计（需求 v1.49、方案 v0.3；详见 [MEASURED.md](docs/MEASURED.md) §8.1O，v0.22）。同日另做一次**模块化与规范审计**（用户 m09634「整体梳理项目确保模块化与规范有效」）：结论见 [docs/AUDIT_MODULARITY.md](docs/AUDIT_MODULARITY.md)——分层与门禁有效、19 处重复窗口全是 import / 测试夹具（无逻辑重复），但 `tests/` 未纳入 ruff 覆盖面、覆盖率门槛（core ≥85% / 整体 ≥70%）没有任何钩子在执行。2026-10-18 完成 **T2.3-C1 窗口晃动记账**（用户 m09592 / 方案 §4.2）：晃动判定放主进程纯逻辑 `app/main/shake-detector.ts`（800 ms 内方向反转 ≥4 次且单步 ≥15 px、1.5 s 冷却），经新路由 `POST /usage/record` 交 sidecar 记入 `session.window_shake_count`（旧库自动补列；纯 UI 会话 `ui:<char_id>` 不计会话数），行为记忆新增第 4 条规则（三档粗档文案）；真机探针甩窗 14 次 → 主进程只记 **1 条** `ui.window_shake`、**0 条**失败；pytest **约 489 例** / vitest **15 文件 133 例** / pre-commit **7 钩子**全绿（需求 v1.50、详见 [MEASURED.md](docs/MEASURED.md) §8.1P，v0.23）。2026-10-18 完成 **T2.3-C2a 立绘真加载与部位点击**（用户 m09592「点击立绘各个部位互动」/ m09848「立绘先用桌面上的琥珀、小雪、莫莫，你自己画一下身体部位」）：先修掉一个真 bug——`app/renderer/index.html` 把 `#character` 的 `src` 写死成内置占位图，角色包的 `appearance.portrait` **从来没被加载过**；立绘改经 `deskpet:char:portrait` 以 **data URL** 回传（CSP 不放 `file://`），角色包新增可选 `hits.json`（0–1 归一化框 + 名称 + 颜色 + 本地兜底台词），三只示例各 8 个部位；`object-fit` 由 `cover` 改 **`contain`**，命中换算在渲染层（`contentBox()` + 归一化点，窗口位移 ≤4 px 且指针抖动 ≤6 px 才算点击）；点击先出本地台词再经 `deskpet:ui:char-hit` → `POST /usage/record`（新 `fact: char_hit`）→ `char_hits` 表按「角色 + 部位」聚合（`SCHEME_VERSION` 4）。真机探针：data URL 加载 512×724 `contain`、**8/8 逐框命中各自台词**、空白点静默、8 条 `ui.char_hit` 无失败；pytest **496 例** / vitest **16 文件 146 例** / pre-commit **7 钩子**全绿（需求 v1.51、详见 [MEASURED.md](docs/MEASURED.md) §8.1Q，v0.24）。**部位点击的 LLM 回应（T2.3-C2b）**：点击先出本地兜底台词，是否再花一次 LLM 由主进程闸门决定（600 ms 去抖聚合 / 8 s 冷却不补发 / 每分钟 4 次 / 一串 ≥10 下连已排上的那次一起吞掉）；请求体新增 `interaction` 契约，sidecar 把互动写成一句人话（条数分档）并作为**真实 user 消息**发（`<untrusted_input>` 包裹）；互动轮不算用户消息，行为记忆新增点击频率规则。真机三次短跑抓到并修掉「去抖定时器早触发 → 静默丢回合」的真 bug；两次复跑每跑 17 次点击只花 1 次 LLM，长跑 58 次点击 → `char_hits` 落库 39 行（需求 v1.52、详见 [MEASURED.md](docs/MEASURED.md) §8.1R，v0.25）。**开发者模式与角色记忆两页（T2.3-B1）**：设置窗「应用版本」连点 **20 次**进入 / 退出（间隔 >1000 ms 归零），开关存 `data/dev.json`；开启后多出「角色记忆」两页——**原文**（`GET /memory/messages`，倒序分页 + `covered_by`，只读）与**注入上下文**（`GET /memory/context`，干跑六段装配 + 最终注入文本，**不 `mark_used`**、不调模型）。真机探针两次复跑 `ok: true`：20 击后 `dev.json` `{enabled:true}`、面板出现、原文 3 行、注入 6 段（59–69 / 2500 token、`injected_ids=[1]`、L0 1 条），关闭后 `{enabled:false}` 且面板收起（需求 v1.53、详见 [MEASURED.md](docs/MEASURED.md) §8.1S，v0.26）。开发者模式里现在还能直接改 L0 事实（T2.3-B2）：「注入上下文」页 facts 行的「编辑」→ 保存走 `PATCH /memory/{id}`，存储层重算去重键并同步 FTS5、撞键就并成一条，行为观察（`kind=action`）拒绝编辑；真机探针一次 `ok: true`（**1651 ms**，无 LLM 调用）：改完自动刷新里旧文本消失、新文本进装配（14 → 16 token），`/memory/list` 只剩新文本（需求 v1.54、详见 [MEASURED.md](docs/MEASURED.md) §8.1T，v0.27）。块 D **角色包编辑器**也做完了（T2.3-D）：设置窗「角色与立绘 → 新建角色包…」开独立窗口（1000×700），四步向导选图 → 裁切 → 画部位框 → 填卡片，产物写 `characters/<char_id>/{assets/portrait.*, card.json, pack.json, appearance.json, hits.json}`，**目录已存在拒绝覆盖**；部位几何与主窗命中测试共用 `char-hit.ts`，保存后广播 `charactersChanged` 让角色菜单立刻刷新（不切走当前角色）。真机探针两次 `ok: true`：编辑器 56 ms 就绪、保存 7 ms、五个文件落盘、主窗出现「探针角色」，且写出的包被 sidecar `load_character_pack` 判为 `ok`（需求 v1.55、详见 [MEASURED.md](docs/MEASURED.md) §8.1U，v0.28）。
- 开发机（**只是这台机器的现状，不代表部署环境**）：Windows 11 + WSL2(mirrored) / Ryzen 9 7945HX
- 开发约定：**WSL 只用来编辑代码，依赖安装与运行一律在 Windows 侧**

## 文档

所有文档都放在 **docs/**，仓库根只留本 README。

| 文档 | 内容 |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 需求说明书 v1.55（**唯一正本**：决策、实测约束、功能需求、数据契约、验收标准、里程碑） |
| [docs/CODE_STYLE.md](docs/CODE_STYLE.md) | **代码规范 v1.7（已冻结）**：模块化分层 + 注释规则 + 工具链 + 日志行 schema 与脱敏 + 错误码域表 + 提交规范 |
| [docs/PLAN.md](docs/PLAN.md) | 实施计划 v0.59（**M0 复盘 + M1 拆解**：M0 的 13 项任务与判据对照、估时 vs 实际、教训清单；M1 的前置 P5–P9、任务 T1.1–T1.13、顺序、风险 R7–R11） |
| [docs/MEASURED.md](docs/MEASURED.md) | **实测数据 v0.28**：体积、冷启动、文字链路端到端、记忆系统 F3 四条判据（offline / live）、应用层端到端记忆与跨重启召回（§8.1）、设置窗层端到端：模型供给 + 记忆管理（§8.1E）、人格导入与换人感知（§8.1O）、立绘真加载与部位点击（§8.1Q）、部位点击的 LLM 回应（§8.1R）、开发者模式与角色记忆两页（§8.1S）、开发者模式里编辑 L0 记忆（T2.3-B2，§8.1T）、角色包编辑器（T2.3-D，§8.1U）、记忆管理（§8.1O）、窗口晃动记账（T2.3-C1，§8.1P）、立绘真加载与部位点击（T2.3-C2a，§8.1Q）、部位点击的 LLM 回应（T2.3-C2b，§8.1R）、行为记忆（T2.1c，§8.1J）、主窗 JS 拖动 / 托盘位置重置 / png 铺满（§8.1L）、提示词示例去撞车与验收有效性修复（§8.1F）、F8 人格复测与量具修正（§8.1G）、主窗两行改版与窗口尺寸随素材（§8.1I）、「双击到主界面可见」等可复跑数字（脚本 `scripts/smoke_release.ps1` / `scripts/smoke_text.ps1` / `scripts/smoke_memory.ps1` / `scripts/memory_check.py`） |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | **文本阶段验收说明（T2.2）**：交付清单、怎么跑起来、三条人工验收步骤（文字对话与打断 / 记忆 / 人格）、自动脚本数字与验收记录表 |
| [docs/AUDIT_MODULARITY.md](docs/AUDIT_MODULARITY.md) | **模块化与规范审计（2026-10-18）**：分层规模、大文件拆分裂判读、跨文件重复窗口、规范盲区（tests 未纳入 ruff / 覆盖率门槛未执行）与建议清单 |
| [docs/PROJECT_DOC.md](docs/PROJECT_DOC.md) | 项目文档（待写） |

## 已锁定的关键决策

| # | 决策 | 选择 |
|---|---|---|
| D1 | 桌面壳 | Electron + Python sidecar |
| D2 | LLM | 云端为主（OpenAI 兼容，base_url / key / model 全可配置） |
| D3 | TTS | IndexTTS-2.5，情感走引擎自带的文本输入（`emo_text` + `emo_alpha`），本项目不拼向量 |
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
| M1 | 语音全双工闭环（ASR → LLM → TTS → 打断 + 反应音库）+ usage.db 记录层（F10）。**执行顺序为「文字优先」**：T1.9 ✅ → T1.10 ✅ → T1.11 ✅ → T1.12a ✅ → T1.13a ✅，语音（T1.7 / T1.12b / T1.13b）在其后；原 T1.8「推理资源闸门 / GPU 锁」已取消（D18） |
| M2 | 记忆系统（SQLite + 四层摘要阶梯 + 角色包导入导出） |
| M3 | 形象与表现（Live2D 接入、口型 / 动作 / 情绪、静态 CG 事件插图） |
| M4 | 屏幕感知与主动性 + 自我状态感知（F9）+ 使用感知的注入与统计页（F10） |
| M5 | 发布与分发（按需）：GitHub 仓库 + Actions CI + Release 附件 |

## 开发环境准备（Windows 侧）

依赖安装与运行一律在 Windows 侧；WSL 只用来编辑代码（D 盘在 WSL 是只读挂载）。

1. Node 24 + pnpm：`npm i -g pnpm@12`（`corepack enable` 要写 `C:\Program Files\nodejs`，实测报 EPERM，需管理员）
2. Python 3.13（项目**独立** venv）：`winget install -e --id Python.Python.3.13`，然后 `py -3.13 -m venv .venv`
3. sidecar 依赖：`.venv\Scripts\python -m pip install -e "sidecar[dev]"`（FastAPI + uvicorn + ruff / mypy / pytest / pre-commit）
4. 前端依赖：`pnpm install`（pnpm 12 默认忽略依赖的构建脚本；本仓库已在 `pnpm-workspace.yaml` 用 `allowBuilds` 批准 esbuild，无需额外参数）
5. 提交前守门（装一次即可）：`.venv\Scripts\python -m pre_commit install`；想手动全量跑一遍用 `.venv\Scripts\python -m pre_commit run --all-files`。钩子见 `.pre-commit-config.yaml`（ruff / mypy / eslint / prettier / tsc + `.ps1` 必须有 UTF-8 BOM），全部走本地 `.venv` 与 `node_modules`，**不联网**
6. 自检（都在仓库根执行）：`.venv\Scripts\python -m pytest`、`pnpm lint`、`pnpm typecheck`、`pnpm test`
7. 单独起 sidecar（可选，Electron 未就绪时排障）：`.venv\Scripts\python sidecar\main.py`，监听端口与 token 见 `data\runtime.json`（`Ctrl+C` 退出时会自动删掉该文件）
8. 冒烟自检（无人值守）：设 `DESKPET_SMOKE_QUIT_MS=8000` 再启动，应用到点会走与托盘「退出」相同的收尾路径（停 sidecar、删 `data\runtime.json`），日志里能看到 `app.smoke_quit`
9. 打包 sidecar（可选）：`powershell -ExecutionPolicy Bypass -File scripts\build_sidecar.ps1 -Clean` → 产物 `dist\sidecar\sidecar.exe`（**onedir：整目录一起分发，不能只拷 exe**）。单独运行它会在 exe 旁生成 `data\`（含 `runtime.json` 与 `logs\deskpet.log`），端口可用 `DESKPET_SIDECAR_PORT` 指定
10. 排障看日志：`data\logs\deskpet.log`（单行 JSON、UTF-8；超过 20 MB 滚动，历史保留 7 天；错误码形如 `DP-TTS-001` 见 CODE_STYLE §6.4）
11. 配置云端模型（**T1.3 起必需**）：把仓库根的 `.env.example` 复制成 `.env`（已被 gitignore），填 `DESKPET_LLM_BASE_URL` / `DESKPET_LLM_API_KEY` / `DESKPET_LLM_MODEL`（可选 `_FALLBACK_BASE_URL` / `_FALLBACK_MODEL`）。开发模式下主进程会解析仓库根的 `.env` 并注入 sidecar 子进程；打包后读 userData 下的 `.env`，也可用 `DESKPET_ENV_FILE` 指到别处。**没配也不崩**：`/chat/stream` 会先回一条 `e` 事件（`DP-LLM-004`「还没有配置模型服务…」）；该端点的模型可能先吐 `reasoning_content`，客户端只取 `content`（见需求 §6.2）
12. ASR 模型（**T1.4 起**，首次自动下载）：默认 `small` + int8 + CPU，权重落 `data\models\asr`（约 464 MB，已 gitignore），**不用预装**——第一次识别会自动下载（约 200 s）；国内网络请设 `DESKPET_ASR_HF_ENDPOINT=https://hf-mirror.com`（适配器会自动加 `HF_HUB_DISABLE_XET=1`，否则镜像下 401）。想先下好可以不启动应用，直接跑 `.venv\Scripts\python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root=r'data\models\asr')"`；ASR 的实测速度见 docs/MEASURED.md §5
13. 起 **IndexTTS 适配器**（语音功能需要；**必须用 IndexTTS 自己的解释器**，不要用项目 `.venv`）：在仓库根运行 `D:\IndexTTS\.venv\Scripts\python.exe -m tools.indextts_adapter --port 8742`，然后 `GET http://127.0.0.1:8742/health` 应返回 `ready`（首次调用才加载模型，要十几秒到上百秒）。契约见需求 §6.12；本项目不安装 / 不修复引擎（D14）。**T1.5 起 sidecar 会调它**：默认 `http://127.0.0.1:8742`，可用 `DESKPET_TTS_URL` / `DESKPET_TTS_TOKEN` / `DESKPET_TTS_TIMEOUT_S` 覆盖；引擎没起时 `/tts` 明确回 `DP-TTS-503` 并转纯文字，不会假装在说话

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
- 实测冷启动与体积（可复跑，约 90 秒）：`powershell -ExecutionPolicy Bypass -File scripts\smoke_release.ps1`；当前数字见 [docs/MEASURED.md](docs/MEASURED.md)（本机：主界面可见 705 ms、后台就绪 960 ms、安装包 133.4 MB、解压 429.5 MB）。

## Git 工作流（本地）

> D 盘在 WSL 是只读挂载，**git 命令一律在 Windows 侧执行**（WSL 只用来编辑代码）。GitHub 仓库与 Actions CI 推迟到 M5（按需），M0 起只做本地 git。

### 分支

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定线，任何时候都能打包 | 只接受 `dev` 或紧急 `fix/*` 的合并；不直接在 main 上开发 |
| `dev` | 集成分支 | 功能先合到这里；小改动可直接提交 |
| `feat/*` `fix/*` `docs/*` `chore/*` | 短生命周期分支 | 一次一件事，合完即删；单次 diff 建议 < 400 行 |

每次 `git commit` 会自动跑 `.pre-commit-config.yaml` 里的 7 个钩子（ruff check / ruff format / mypy / eslint / prettier / tsc / `.ps1` BOM）；只想跳过时用 `git commit --no-verify`，但别把跳过当默认。

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

## 开工前待定项

1. 角色包编辑器的形态（M3 阶段再定）
