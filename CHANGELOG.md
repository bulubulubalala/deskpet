# 更新日志

## [0.1.0] - 2026-11-12

首个公开测试版：内置小玉人格、立绘与 Live2D 模型；文字 / 语音 / 互动三种模式，长期记忆与主动陪伴，角色包编辑器，以及完整的模型/语音/备份设置。

### Added

- 恢复数据包后可以一键重启：选完 zip 解包成功，旁边会多出「立即重启引擎」按钮
  （以前只写一句「去托盘点重启」，很容易被当成恢复失败）。重启完顺手刷新备份列表，
  被换下的旧库就在列表里，名字是 `memories-replaced-…`。
- 备份看得见了：设置窗「记忆 → 备份与迁移」现在会列出 `data/backups` 里的文件
  （每日快照、操作前留底、恢复时被换下或打不开的残骸），带大小与时间，按新到旧排；
  旁边有「立即备份」（等价于手动存一份操作前留底）与「打开数据目录」。
  以前这些文件一直在磁盘上，但界面上看不到有多少、多大、是不是今天的。
- 应用内「检查更新」：设置窗「后台引擎」页多了一张「版本更新」卡片，点「检查更新」才去问一次
  GitHub 的最新发布（不自动联网、不在后台轮询），显示「已是最新 / 有新版本 x.y.z / 检查失败（原因）」；
  有新版本时多出一个「打开下载页」按钮，用系统浏览器打开这次查到的发布页。
  地址只认 https 的 github.com，界面传不了 URL；8 秒超时，失败只提示一句人话、不弹窗。
  便携版的升级方式不变：下载新包覆盖 app/ 目录，data/ 与 characters/ 保留。
- 语音识别模型可以提前下载：设置窗「后台引擎」页多了一张「语音识别模型」卡片，
  显示「已就绪 / 还没下载 / 正在下载 / 下载失败」与已下载体积，点「下载模型」就在后台下，
  每 1.5 秒刷一次进度。以前是第一次点麦克风才静默下几百 MB，现在可以先把这一步做完。
  云端识别时卡片直接显示「已就绪」，不会下载。
- 界面传进来的参数现在会在入口按形状检查（`app/shared/contracts/validate.ts` + `ipc-schemas.ts`）：
  71 个请求通道每个都登记了形状，拼错字段名、把 id 传成字符串、把数组传成对象这类错误
  在入口就被拒掉，日志里带通道名与字段路径（`ipc.invalid_argument`），不再一路穿到查库/写盘的地方才炸。
  校验器是自带的（零依赖，不引 zod）：主进程运行时依赖仍只有 Electron，离线构建与 `pnpm-lock` 都不受影响。
  形状表与 handler 的「一对一」由 `pnpm ipc:check` 对账，少一条或多一条死条目都会让门禁变红。

### Changed

- 文字聊天也走语音那条管线：主进程不再自己「读一句 → 合成一句 → 推音频」，而是把整句话
  塞进同一条 `/ws/voice`（`app/main/chat-turns.ts`），由后台引擎统一做「生成 → 逐句合成 → 推音频」。
  因此 `app/main/chat-orchestrator.ts`、`app/main/character-voice.ts` 与客户端里
  `streamChat` / `synthesize` / `cancelTts` / `transcribe` 四个方法整条删除，
  `app/main/turn-coordinator.ts` 只剩「起新轮前先取消旧轮 + 原样转发状态」。
  连续三句合成失败时只提示一次（不再每句弹一遍），提示走错误事件、不打断后续句子。
  后台的 `/chat/stream`、`/tts`、`/asr` 路由保留给脚本与回归测试，主线不再经过。
- 设置窗开发者面板（`app/renderer/settings/dev.ts` 638 行）拆进 `app/renderer/settings/dev/`：
  共享状态与切页回调（`state.ts`）、原文回看（`raw.ts`）、注入预览与就地纠错（`context.ts`）、
  可编辑事实（`data.ts`），入口 `index.ts` 只管连点手势、三页签切换与角色列表。
  三页之间不再互相 import，「谁会写记忆」看 `data.ts` / `context.ts` 就够。
- 记忆用例层（`sidecar/services/memory_service.py` 934 行）按域拆进 `sidecar/services/memory/`：
  依赖与降级/错误翻译（`base.py`）、注入与召回预算（`recall.py`）、语义索引（`embeddings.py`）、
  记忆条目读写（`memories.py`）、原文与摘要纠错（`messages.py`）、时间金字塔与日记（`timeline.py`）、
  关系与待办（`relations.py`），`service.py` 只剩继承汇合与组合根。方法体原样搬迁，
  对外入口 `services.memory_service` 仍是 `MemoryService` / `build_memory_service` 两个名字，
  调用方一行不用改；日志里的模块名保持 `services.memory_service`，按名字搜日志不会断。
- 记忆相关的 HTTP 接口（`sidecar/api/memory.py` 771 行、其中装配函数 520 行）按域拆成
  `sidecar/api/memory/`：记忆条目读写、原文与摘要纠错、时间金字塔与日记、关系与待办、
  语义索引、注入预览各一个文件，「数据库行 → 接口模型」的映射与失败信封各自成模块。
  对外入口 `api.memory.build_memory_router` 不变；拆完重新导出的 OpenAPI 快照与拆之前
  逐字节一致，所以前端、契约测试与任何调用方都感觉不到这次改动。
- 会话主流程（`sidecar/services/chat_service.py` 948 行）拆进 `sidecar/services/chat/`：
  模型输出的每一行怎么降级成台词（`line_parser.py`，把「不可信数据」的处理收在一处）、
  多端点降级与退避重试/两段超时/断流收尾（`stream_runner.py`）、记忆读写与角色状态
  （`memory_bridge.py`），`service.py` 只剩「这一轮拿什么提示词、哪些事实要记、失败怎么收敛成事件」。
  原来「压缩 / 时间线 / 图谱 / 行为观察」四段几乎一模一样的 try-schedule-记日志收成一张表，
  以后加一类后台整理不用再复制一遍；四处各写一份的 `ClientFactory` 类型收进
  `services/llm_ports.py`，「主动开口」的四句人话模板挪进 `core/prompt.proactive_user_text`。
  对外入口 `services.chat_service` 仍是那四个名字，调用方一行不用改。
- 记忆库实现（`sidecar/adapters/memory_sqlite.py` 2033 行单类）按「表/域」拆成
  `sidecar/adapters/memory_store/`：原文与覆盖标记（`messages.py`）、记忆条目（`memories.py`）、
  时间线（`periods.py`）、日记（`diary.py`）、关系图谱与待办（`graph.py`）、语义索引（`embeddings.py`）、
  摘要与原文编辑（`summaries.py`）、过期清理（`maintenance.py`）、角色状态（`character_state.py`）。
  SQL 文本原样搬迁，没有重写任何一条语句；行映射与向量编解码是纯函数（`rows.py` / `vectors.py`），
  连接生命周期与开库入口留在 `store.py`。对外入口仍是 `adapters.memory_sqlite` 的三个名字
  （`SCHEMA_VERSION` / `MemorySqliteStore` / `open_memory_store`）——调用方一行都不用改。
  以后改「日记怎么存」不必再翻整个库；查「谁会删向量」搜 `_drop_embeddings` 也只有一处。
- 角色包的各种上限只留一份（`app/shared/pack-limits.ts`）：id 规则、立绘大小、
  部位数量、名字长度、卡片字数、颜色格式、优先级与容差上限，原来在「写盘校验」「读回来兜底」
  「编辑器提前挡」三处各抄了一遍，漏改一处就会出现「界面能存、重启后被截断」。现在三处引用同一份常量。
- Live2D 舞台（`stage-live2d.ts` 726 → 约 586 行）拆出三块只用输入输出说话的部件：
  网格顶点 → 归一化包围盒（`stage-live2d/mesh.ts`，原来两段各 25 行、一模一样的顶点扫描合成一份）、
  「网格框夹到作者画的范围」`stage-live2d/hit-mapping.ts`、模型地址与 Cubism 参数读写
  （`stage-live2d/model-api.ts`，参数「名字 → 下标」表也搬过去，舞台上只剩一句调用）。
  三块都不加载 pixi，因此在 node 下能直接跑（新增 18 例）。
- 与后台引擎通信的传输层独立成 `app/main/sidecar/transport.ts`：拼地址、带 token、超时、
  取消、还原错误体这些细节只在这一个文件里，`sidecar-client.ts` 降到 886 行，只剩「每个接口
  该发什么、回什么怎么读」。传输层用真的回环 http 服务测了 6 例（超时文案、取消、二进制响应等）。
- 角色包编辑器整份拆进 `app/renderer/editor/`：固定上限与配色（`constants.ts`）、
  所有会变的量集中成一个 `editorState` 对象（`state.ts`，替掉 25 个模块级 `let`）、
  DOM 小工具（`dom.ts`）、画布换算与图片装载（`canvas.ts`）、纯绘制（`paint.ts`）、
  裁切交互（`crop.ts`）、部位交互（`regions.ts`），入口 `editor.ts` 只剩保存与三种进入模式，
  从 1564 行降到 439 行。以前「谁改了 `regions`」只能通读全文，现在函数里出现 `editorState`
  就说明它会写状态，绘制模块完全不碰状态。
- 设置窗的记忆面板按页面拆成目录（`app/renderer/settings/memory/`）：主列表、语义索引、
  时间线、日记、关系与待办、图谱各一个文件，「现在看的是哪个角色」与时间格式收进 `state.ts`。
  `memory.ts` 从 1397 行变成 108 行的装配层。原先七个页面共享一个闭包，改日记要在语义索引的
  状态里找上下文；现在每个页面只依赖「当前角色」，换角色时由主列表统一喊其它页面刷新。
- 角色包编辑器的「什么算合法的一包」与「怎么落盘」分家：校验、默认值、图片解码与
  `characters/<id>/…` 的组装搬到 `app/main/pack-editor/rules.ts`（不碰文件系统，纯函数），
  `pack-editor.ts` 从 772 行降到 409 行，只剩读图、读 JSON、写入这三件事。以后改「部位框最多几个」
  这类规则不用在读写逻辑里翻。
- 主窗的角色菜单搬到 `app/renderer/character-menu.ts`：谁被选中、点了谁、菜单里有哪些编辑入口
  都由它自己回答，主窗只提供「当前角色是谁」和「切过去」两个回调。两个弹层互斥（角色 / 窗口）
  改由菜单打开时通知外面收起，不再由主窗手写 DOM 判断；`index.ts` 从 1622 行降到 1494 行。
- 角色包编辑器的坐标换算（矩形/多边形的夹取、按角缩放、跟着外接框变形、描边）搬到
  `app/renderer/editor/geometry.ts`：只有数学，不读 DOM 也不读编辑器状态，因此第一次有了单测
  （`tests/editor-geometry.test.ts` 16 例，覆盖角落容差、反向拖拽不出现负宽高、多边形同比缩放）。
  `editor.ts` 从 1744 行降到 1500 行左右，改「画出来的框和主窗点到的地方对不上」这类问题时
  只需要看一个文件。
- 主进程启动脚本（`app/main/index.ts` 1133 → 916 行）拆出五块与启动顺序无关的部件：静态路径
  （`app-paths.ts`）、免打扰时段判断（`quiet-hours.ts`，纯整数比较，含跨午夜用例）、
  「导出数据包」的提示与防重入（`export-data.ts`）、托盘菜单（`tray-menu.ts`，菜单项该干什么
  由调用方注入，不再直接摸窗口/引擎单例）、屏幕观察与「观察结果进记忆」的节流
  （`companion-sync.ts`，输入是一次设置快照，能脱库测试）。截屏热键与定时观察共用同一套
  「OCR 失败就退回视觉摘要」的降级规则。
- 主窗脚本拆出三个不碰业务的小模块：找元素（`app/renderer/dom.ts`）、唯一的横幅（`banner.ts`，
  谁写的谁收、点横幅开哪一页由它自己回答）、语音电平柱（`voice-wave.ts`）。`index.ts` 从 1765 行降到 1622 行。
- 主进程的通道处理按域拆成模块（`app/main/ipc/`）：聊天、语音、触摸闸门、界面状态、记忆、
  角色包、模型供给、开发者面板各自一个文件，`ipc-handlers.ts` 从 1607 行降到 58 行，
  只剩「建注册表、建上下文、按域挂上去、退出时统一注销」。触摸闸门那套定时器与排队状态
  跟着触摸模块走，不再和别的域的变量挤在一个闭包里；通道对账脚本改成扫整棵 `app/main`，
  另外不再把注释里提到的 `ipcMain.handle` 当成违规写法。
- 设置窗按面板拆成模块：DOM 小工具（`app/renderer/settings/dom.ts`）、模型供给（`providers.ts`）、
  系统状态与使用统计（`system.ts`）、角色包（`packs.ts`）、记忆面板（`memory.ts`）、
  开发者面板（`dev.ts`），`settings.ts` 从 2980 行降到 271 行，只剩导航、外观、手势与装配。
  每个面板自带 `init`，按键接线跟着面板走，主入口不再有 40 多个散落的监听。
  记忆面板不再直接改开发者面板的角色下拉，改成「记忆面板刷新完喊一声，开发者面板自己填」；
  开发者面板也不再自己推导航，切页函数由主入口注入。
- 语音状态只有一个出处（D1）：说没说话、在不在想，现在只由后台引擎的语音会话在「开始一段活 / 结束一段活」时
  报一次，主进程只负责「这条状态属于当前接管话筒的那条流水线吗」并原样转给界面。
  顺带删掉了三处补丁：主进程自己先亮「在听 / 在想 / 打断中」、取消后代为落回空闲、
  以及「刚开口 1 秒内忽略迟到空闲」的时钟判断。界面行为上可见的差别是：按麦后「在听」等引擎真正开始收音才出现
  （通常几十毫秒），打断时「打断中 → 空闲」由引擎如实汇报，不再由界面猜。
- 无头验证语音链路：`tests/test_voice_ws.py` 用 FastAPI 的 TestClient + 假 ASR/LLM/TTS 直接断言状态帧序列
  （听→想→说→空闲、纯文字轮没有「在听」、关掉语音输出没有「在说」、说话中取消是「打断中→空闲」、
  还没开口就取消只落一次空闲），不需要真麦克风和音箱。

- 分层边界（D2）：主进程与渲染层共用的常量（帧率档位、供给来源）、97 条 IPC 通道名，以及全部 IPC 入参/回参类型、
  心跳视图搬到 `app/shared/`；界面层（preload + renderer）对主进程的引用降到 0，连 `import type` 也不允许，
  eslint 与 `tests/layer-boundary.test.ts` 一起守住这条线。
- IPC 通道改为统一注册表（`app/main/ipc-registry.ts`）：73 个请求 + 13 个事件在一处登记、退出时统一注销，
  不再靠 86 行手抄清单；`pnpm ipc:check` 额外对账「注册 == 注销」与「preload 调的 == 主进程实现的」。
- 主进程日志按 5 MiB 滚动、保留 5 份（写入改为同步 fd，滚动时机可控）。
- 新增 `pnpm test:coverage`（v8 provider，只报告不设门槛），CI 的 TS job 会跑一次。
- `tests/character-asset-path.test.ts` 不再写死 `D:\\deskpet\\characters`，可在任意平台/工作目录跑。
- 设置窗里切换「行为记忆」或「语义检索」后会立刻重启后台引擎（与模型供给同口径），
  横幅直接说「约两秒后生效」，不再需要自己去托盘点一次；原来提示里的「改 .env」也一并改掉。
- 主进程的 sidecar 客户端按职责拆成三个文件：契约形状（`app/main/sidecar/types.ts`）、
  脏数据解析（`app/main/sidecar/parsers.ts`）与请求编排（`app/main/sidecar-client.ts`）；
  对外 import 路径不变，行为零变化。
- 记忆的「取数 → 裁剪 → 组装」从 `sidecar/services/memory_service.py` 拆到
  `sidecar/services/recall_builder.py`（该文件 1476 → 934 行）：预算怎么裁、哪层先丢、
  语义检索怎么和全文检索融合，现在是不碰数据库也能测的规则（新增 10 个用例，不需要 DPAPI 密钥）。
- 记忆库的「建表 / 升级 / 升级后自检」从 sidecar/adapters/memory_sqlite.py 拆到
  sidecar/adapters/memory_schema.py（该文件 2399 → 2033 行）：库结构怎么变是一条线，
  怎么查怎么写是另一条线，以后加表加列不用在两千行的存储实现里翻找。
- 设置窗脚本开始按面板拆模块（app/renderer/settings.ts 2980 → 2507 行）：公共 DOM 工具放进
  `app/renderer/settings/dom.ts`，模型供给面板（来源选择、字段表单、保存、连通性探测）整体搬进
  `app/renderer/settings/providers.ts`；行为不变，之后改供给表单不必再翻整份设置脚本。
- 设置窗继续拆：引擎状态 / 外观 / 使用统计 / 麦克风权限搬进 `app/renderer/settings/system.ts`，
  角色包导入导出搬进 `app/renderer/settings/packs.ts`（app/renderer/settings.ts 2507 → 2224 行）。
- 设置收成一份（D4）：所有配置改存 `data/settings.json`——普通值放 `values`，API Key / token 放 `secrets`
  并用系统加密（Windows 下是 DPAPI）存储；旧 `.env` 只在「第一次启动且还没有 settings.json」时导入一次，
  之后既不读也不写。设置窗底部的「写入位置」会显示实际文件路径。
- 设置写盘用「临时文件 + 改名」原子替换，断电不会留下半个 JSON；文件版本高于本程序时改为只读，
  避免旧版程序把新配置写坏；密钥加密不可用时降级明文并在日志里明确告警。
- `app/main/env-file.ts` 删除写回能力（`applyEnvUpdates` / `updateEnvFile`），从根上避免
  「界面上改了、别处又把 .env 改回去」的两套真相。
- Python 静态检查钉死版本（`ruff==0.7.4`、`mypy==1.13.0`）：此前 dev 依赖写的是 `>=`，CI 每次拉到最新版，
  规则集一变「绿/红」就不可复现（本次就在新 ruff 下暴露 24 条既有告警：`UP038`、`RUF009`、`RUF012`、
  `N802` 等），现已全部修掉并让 `ruff format` 覆盖全仓 103 个 Python 文件。

- 角色包的各种上限（char_id 规则、立绘体积、部位数量/名字长度/优先级/容差/多边形点数）只留一份
  `app/shared/pack-limits.ts`：之前写盘校验、读回兜底、编辑器提前拦截各抄了一遍，改一处漏两处就会出现
  「界面能存、存进去读回来被截断」。

- 主进程和后台引擎之间的「怎么发请求」独立成 `app/main/sidecar/transport.ts`（token 头、超时、取消、
  错误信封还原），业务客户端 `sidecar-client.ts` 从 989 行降到 837 行，只剩「参数怎么翻译、结果怎么读」。
  新增 `tests/sidecar-transport.test.ts` 6 例，用一个真的回环 http 服务盯住这条路上最容易出错的地方
  （非 2xx 时错误码丢了、超时没真断、signal 先 abort 后挂监听会导致进程级异常）。

### Removed

- 旧的 HTTP 语音路径整个删掉：`voice.start` / `voice.stop` 两条 IPC 通道、`VoiceStopRequest` / `VoiceStopResponse`
  契约、`ChatOrchestrator.startListening/stopListening`。它和 WebSocket 语音是两套并行实现，
  渲染层早已不用，留着只会让人以为有两个入口。
