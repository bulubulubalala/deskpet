# deskpet · 触摸互动方案（部位自由定义 + 力度 + 互动模式）

状态：**v0.2 手势部分、v0.3 触摸仲裁、v0.4 三通道互斥（2026-10-20，用户确认三选一）均已定案并落地**；版本 **v0.4**。

v0.3 → v0.4 的变化：把文字 / 语音 / 互动改成互斥三选一；切换模式只停旧输入、已提交回复继续；取消「listening 合并触摸」与 `AudioEnd.interaction`；新增同高提示区、语音自动开麦、文字发送 barge-in 与 `TurnCoordinator`。§1–§12 的手势部分不变。

v0.1 → v0.2 的变化：① 互动按钮位置定为聊天条**麦克风旁边**；② 互动模式下**不允许**拖动窗口（移动只走左上角把手）；③ 手势扩充「揉」「拍」，并把**进入互动模式的手势**与手势清单放进设置窗的「手势」菜单；④ 互动按钮是**开关式**（点一下生效、再点关闭）；⑤ 不加兜底规则——理不理完全由模型按角色设定决定；⑥ 新增「最小化窗口」按钮（设置按钮旁边）+ 托盘右键菜单的「最小化窗口」。

本方案取代 `docs/PROPOSAL_INTERACTION.md` v0.3 里块 C 的「点击部位 + 预制台词」部分；
已经落地的 T2.3-C1（晃动）与 T2.3-C2a/C2b（立绘真加载 / 点击 / 闸门 / 记账）保持不变，只在其上改造。

## 1. 你的三条要求怎么落（先给结论）

| 你的要求 | 方案 | 关键点 |
|---|---|---|
| 部位不用设定死，用户自己拉框填 | 部位框仍由角色包 `hits.json` 定义，**名字完全由用户填（中文也行）**；没有文件、或框为空时，整张立绘视为一个默认区域「身体」 | 代码里**不出现任何具体部位名**；示例角色包的 8 个框只是我画的初稿，可以在编辑器里随便改 |
| 不用预制台词 | 删掉 `hits.json` 的 `reactions`（本地兜底台词）；所有回应都由 LLM 现场生成 | 闸门拦截时不写字，改用**无声的视觉脉冲**（立绘轻微回弹 + 光晕 150 ms）告诉你「点到了」 |
| 用连点次数决定力度 | 一串动作聚合成**一条事件描述**（模板生成，不含角色语气），例如「用户轻轻摸了一下胳膊。」「用户戳了胸 3 下。」 | 多部位写进同一句：「用户轻轻摸了一下胳膊和腿。」；滑动轨迹也能成句：「用户从脸一路摸到肩膀。」 |

## 2. 部位定义：不再写死

- `characters/<char_id>/hits.json` 的 `regions[]` 仍是唯一正本，字段：
  `id`（ascii，自动从名字 slug 化）、`name`（**用户填，中文可用，≤24 字**）、`rect`（0–1 归一化 [x,y,w,h]）、`color`（仅界面叠色用）、`act`（可选动作名，M3 接 Live2D 后才有效果）。
- **删除** `reactions` 字段（v1 包里的该字段被忽略，不报错）。
- 没有任何 region、或 `hits.json` 不存在 → 整张立绘当「身体」一个区域（`id: "body"`、名字「身体」），仍然可以点、可以摸。
- 部位框由角色包编辑器画（已有功能，T2.3-D）；本轮把编辑器里的「台词」输入框**去掉**，只留名字 / 颜色 / act。
- 部位名进提示词前一律洗过（去不可打印字符、折叠空白、截 24 字）并按**不可信数据**包起来——角色包是用户数据。

## 3. 没有预制台词之后，点击的即时反馈

| 时刻 | 用户看到什么 |
|---|---|
| 互动模式关闭时点到立绘 | **什么都不发生**（防误触；见 §5） |
| 互动模式打开、点到立绘 | 立绘一次 150 ms 的轻微回弹 + 淡光晕（纯 CSS，不写文字） |
| 一串动作结束、闸门放行 | 气泡里出现 LLM 的回应（逐句播报，与普通对话同一条链路） |
| 闸门拦截（冷却 / 超频 / 一串太长） | 只有视觉脉冲，没有回应 —— 这是设计，不是 bug |

好处：气泡里**只出现角色真的说的话**，不再有「别碰这里。」这种作者的预制句。

## 4. 手势与力度：一串动作 = 一条描述

### 4.1 三种手势

- `tap`：按下后 300 ms 内松开，且指针位移 <6 px。
- `stroke`（到处摸）：按住拖动，沿路径每 ~16 ms 采样一次命中的部位，形成部位序列；松手结束。
- `hold`：按住不动 ≥600 ms（`kindOf` 已有该判据）。
- `knead`（揉）：按住状态下在一个**小范围**内往复移动（1.5 s 内方向反转 ≥3 次、单次位移 <40 px、总位移 <120 px）。
- `pat`（拍）：快速按-起 ≥3 次（间隔 ≤300 ms），每次几乎不移动（<6 px）。与「连点`tap`」的区别是节奏：拍要求节奏均匀且快，连点只要次数。

### 4.2 聚合规则

- 一次「互动会话」= 从进入互动模式后的第一次按下，到**间隔超过 `TOUCH_SESSION_GAP_MS = 1500` 没有新动作**为止（或手动关闭互动模式）。
- 会话里累计：命中次数 `taps`、部位命中计数、轨迹顺序、持续时长。
- 会话结束时**只发一次** LLM 请求（沿用现有闸门：600 ms 去抖 → 8 s 冷却 → 每分钟 4 次 → 一串 ≥10 下按上限截断并附「你可以不理他」）。

### 4.3 力度分级（纯模板，不含角色语气）

| 条件 | 描述（示例，部位名代入用户填的名字） |
|---|---|
| 1 次轻点 | 用户轻轻摸了一下<部位>。 |
| 2–3 次 | 用户戳了<部位> 3 下。 |
| 4–9 次 | 用户连着戳了<部位> 6 下。 |
| ≥10 次 | 用户不停戳<部位>（已经 12 下），你可以不理他。 |
| 长按 hold | 用户按住<部位>不放。 |
| 揉 knead | 用户在<部位>上揉了好一会儿。 |
| 拍 pat | 用户拍了拍<部位>。 |
| 滑动 stroke（跨部位） | 用户从<部位A>一路摸到<部位B>。 |
| 滑动 stroke（单部位内） | 用户在<部位>上摸来摸去。 |

多部位（同一串里点/摸到多个框）合并成一句，最多列 3 个，其余折成「…等等」：

> 用户轻轻摸了一下胳膊和腿。
> 用户戳了脸、头发和肩膀 5 下。

### 4.4 为什么用模板而不是让模型自己数

模型数不准次数（同一批提示词里它会把 3 下说成 2 下），力度必须由我们算好、只把**事实**告诉它；至于「理不理、怎么回」仍然是角色卡与当下情绪自由发挥（反谄媚规则照旧适用：可以嫌烦、可以不理）。

## 5. 互动按钮与鼠标形态（防误触）

- 聊天条加一个「互动」开关按钮，位置在**麦克风旁边**（默认 **关**）。关着的时候：点立绘、在立绘上滑动都**不产生任何互动**（拖动窗口照旧）。
- 打开后：
  - 鼠标移到立绘上变成互动光标（`cursor: grab`，按下时 `grabbing`）；
  - 立绘外围浮一圈柔和描边（视觉上明确「现在在摸」）；
  - 左上角把手仍然是「拖窗口」——把手优先，不会因为互动模式就拖不动窗口。
- 互动模式下**按住立绘不再移动窗口**（改为抚摸）；移动窗口只靠把手。
- 退出：再点一次互动按钮（**开关式**：点一下生效、再点关闭），或按 `Esc`。窗口失焦**不**自动退出（否则一摸别的窗口状态就"莫名其妙"关了）。
- **互动模式下不允许拖动窗口**（按住立绘 = 摸，不移动窗口），移动窗口只走左上角把手。

### 5.1 设置窗的「手势」菜单

设置窗新增一块「手势」（与其他设置项同级），两块内容：

1. **进入互动模式的触发方式**（多选；默认只勾「点互动按钮」）：点互动按钮 / **双击立绘** / **长按立绘 600 ms** / 托盘的「互动模式」菜单项。勾了哪个就按哪个进。
2. **互动中的手势清单**（每一项可**单独启用或禁用**，并显示判据说明）：轻摸 / 戳 / 来回摸（stroke）/ 按住 / 揉 / 拍。禁用掉的手势不再触发事件（比如不想要「揉」就关掉）。

先不做**阈值调参**（判据数值固定，写进文档），等真机跑一阵子再决定要不要放开；配置存 `data/ui.json`（与界面状态同处，本机文件、不入库）。

### 5.2 最小化窗口

- 主窗聊天条在**设置按钮旁边**加一个「最小化」按钮（`window.minimize()`；立绘窗无边框，最小化后可从托盘恢复）。
- 托盘右键菜单加「最小化窗口」一项（与既有的「显示主界面」「位置重置到屏幕中央」「设置」「退出」并列）。
- 两个入口都只是「最小化」；恢复仍走托盘「显示主界面」。
- 状态不落盘（每次启动都是关），避免下次启动忘了自己开着而误触。

## 6. 数据与契约改动

| 位置 | 改动 |
|---|---|
| `characters/<id>/hits.json` | 删 `reactions`；`version` 1 → 2（读 v1 时忽略 reactions，兼容） |
| `app/renderer/char-hit.ts` | 新增 `TouchSession`（会话聚合）、`intensityOf(taps, kind)`、`describeTouch(session, regions)`（模板成句）、`samplePath`；**删** `localReaction` |
| `app/main/char-hit-gate.ts` | 去抖 / 冷却 / 每分钟上限保留；入参由「点击串」扩为「互动会话摘要」（`gesture` / `intensity` / `regions` / `duration_ms`） |
| `app/main/ipc.ts` | `CharHitMessage` 增 `gesture` / `regions` / `duration_ms`；新增 `interactMode` 通道（渲染层只报状态，主进程不干预鼠标） |
| `sidecar/contracts/api_models.py` | `ChatInteraction` 增 `gesture` / `regions` / `duration_ms`（老字段保留，缺省即老行为） |
| `sidecar/core/prompt.py` | `build_interaction_note` 改为接收结构化事件；文案表按 §4.3 重写；`wrap_interaction` 不变 |
| `sidecar/core/usage.py` / `adapters/usage_sqlite.py` | `char_hits` 加 `gesture` / `intensity`；`SCHEME_VERSION` 4 → 5（老库 `ALTER TABLE` 补列） |
| `app/renderer/editor.ts` | 去掉台词输入；加「不画框就整张身体」的提示 |

## 7. 行为记忆（第 5 条规则）跟着改

- 现在记的是「点某个部位的次数」；改为按**手势类型**统计：常摸（stroke 多）/ 常戳（tap 多）/ 力度偏大（intensity 均值高）。
- 仍不带中文部位名（进 `usage.db` 与观察文案的都只有统计量），部位名只在**当轮提示词**里出现。
- 阈值沿用「样本不足不下结论」的口径：同角色 ≥5 次互动会话才归纳。

## 8. 实现清单（按模块，估时按前几块的实际速度）

| # | 任务 | 产物 | 预估 |
|---|---|---|---|
| 1 | 契约与纯逻辑：手势 / 力度 / 模板成句 + 单测 | `char-hit.ts` / `char-hit-gate.ts` / vitest | 半天 |
| 2 | 互动模式 UI：按钮 / 光标 / 描边 / 视觉脉冲 | `index.html` / `index.ts` / `style.css` | 半天 |
| 3 | 轨迹采样与拖动冲突处理（互动模式下不拖窗） | `index.ts` / `ui-controller.ts` | 半天 |
| 4 | sidecar：契约 / 提示词文案 / 记账 / 观察规则 + 单测 | `prompt.py` / `usage*.py` / pytest | 半天 |
| 5 | 编辑器去掉台词 + hits.json v2 兼容 | `editor.ts` / `pack-editor.ts` | 2 小时 |
| 6 | 设置窗「手势」菜单（触发方式 + 手势开关 + 持久化） | `settings.ts` / `ipc.ts` / `ui.json` | 半天 |
| 7 | 手势扩充（揉 / 拍）+ 轨迹几何 | `char-hit.ts` / vitest | 半天 |
| 8 | 最小化按钮 + 托盘菜单项 | `index.ts` / `windows.ts` / `ipc.ts` / `index.html` | 1–2 小时 |
| 9 | 示例包改造（删 reactions）+ 真机取证 + 五份文档 + 提交 | 探针 + docs | 半天 |

顺序：1 → 2 → 3 可以并（2 与 3 同一个文件，实际串行）→ 4 → 5 → 6。

## 9. 验收判据

**自动**：
- vitest：会话聚合（1 下 / 连点 / 长按 / 跨部位滑动）、力度分档、模板成句、闸门在会话结束只放行一次。
- 真机探针：开互动模式 → 沿立绘拖一条跨两个部位的路径 → `chat.start` **恰好 1 条**且提示词里同时出现两个部位名；关掉模式后再点立绘 → 0 条互动、0 条 LLM。
- pytest：新契约字段落到 `char_hits`、老库自动补列、观察规则按手势统计。

**人工（要你亲手试）**：
- 开着互动模式到处摸：鼠标形态是否明确、误触是否消失、跨部位滑动是不是只回一句。
- 关掉互动模式后，点立绘只是「点到」而不是「摸」。

## 10. 兼容与迁移

- 老 `hits.json`（带 reactions）继续能读，只是那些预制台词不再显示。
- 老 `usage.db` 自动补 `gesture` / `intensity` 两列，历史行按 `tap` / 1 计。
- 老 `ChatInteraction` 请求（只带 region_id / streak）仍被接受，按「一次轻点」处理。

## 11. 已定案（用户 m12028）与仍需确认的小点

| 问题 | 定案 |
|---|---|
| 1 互动按钮位置 | 聊天条**麦克风旁边** |
| 2 互动模式下能否拖窗 | **不允许**（拖动只走把手） |
| 3 力度分档与手势 | **加手势支持**（揉 / 拍）；进入互动模式的手势与手势清单放进设置窗「手势」菜单 |
| 4 互动模式常开还是单次 | **按钮开关式**（点一下生效、再点关闭） |
| 5 要不要兜底规则 | **不加**：理不理完全由模型按角色设定决定 |

仍需确认（不影响开工，实现时按括注默认值先行）：

1. 「手势」菜单里的**进入互动模式手势**默认勾哪些？（默认：只勾「点互动按钮」）
2. 手势判据的**数值**先固定、不放开调参，可以吗？（默认：先固定）

## 11.1 原 v0.1 的待拍板问题（留档）

1. **互动按钮放哪**：聊天条最左侧（与麦克风 / 发送同排，推荐）还是立绘左上角把手旁边的小按钮？
2. **互动模式下按住立绘是否还允许拖窗口**：我建议不允许（拖动只走把手），否则「摸」和「拖」会互相打架。
3. **力度分档 4 档够不够**，措辞用不用更中性（现在是「轻轻摸 / 戳 / 连着戳 / 不停戳」）？要不要加「揉」「拍」这类（需要额外手势，比如按住画圈）？
4. **互动模式常开还是「一次有效」**：我建议常开（再点按钮或 Esc 关闭），避免每次摸都要先点一下。
5. **要不要给硬规则**：现在「理不理你」完全由模型决定（可能摸半天它装死）——保持自由，还是给一条「连续互动 N 次至少回应一次」的兜底？

## 12. 与既有文档的关系

- 本方案获批后会写进 `docs/REQUIREMENTS.md` §6.1（部位点击落地段改写）+ §13（新增一条「互动模式与力度」）与 `docs/PLAN.md` §7.8（T2.3-C2c 任务行）。
- `docs/PROPOSAL_INTERACTION.md` v0.3 的 §4.2 / §4.3（预制台词与按部位计数）标注「已被 PROPOSAL_TOUCH v0.1 取代」。

## 13. 三通道输入：文字 / 语音 / 互动（T2.6，v0.4 已落地）

### 13.1 结论：三个输入模式，互斥，但共用一轮对话

用户 m 定案：**文字 / 语音 / 互动做成三个互斥按键，同一时间只能选一个**。落地后的模型：

- 三个模式**恰好一个**生效，默认**文字**，不记忆上次模式（避免一启动就开麦）。
- 模式只决定**输入**，不决定输出：TTS / 气泡 / 打断按钮在三种模式下都照常。
- 切换模式**只停旧模式的输入采集**，不打断已经提交的回复：
  - 语音正在听你说话时切走 → 取消这条**未提交**的语音轮；
  - 互动的手势 / 排队触摸 → 清空；
  - 文字草稿 → 保留，切回来还在；
  - 已经在 thinking / speaking 的回复 → 继续，直到按停止或用新输入打断。
- 三种模式**不做跨通道合并**：文字与触摸不合并，语音与触摸也不合并（互斥后它们本来就不会同时发生）。之前 v0.3 的「listening 合并触摸」与 `AudioEnd.interaction` 已取消，sidecar 本轮零改动。
- 文字发送在 thinking / speaking 时**直接停播 + cancel + 起新文字轮**；语音开口同样；demand 触摸同样。backchannel 轻点不打断。

### 13.2 已定案（2026-10-20）

| # | 问题 | 定案 |
|---|---|---|
| 1 | speaking 中的单点 | **只视觉 + 记账，丢弃**（不打断、不排队、不回应） |
| 2 | 空闲时单点 | **仍起一轮**（保持现状） |
| 3 | demand 取消时机 | **手势一成立就停播 + cancel**（hold 600 ms / stroke 40 px / 第 3 下 / knead 成立时） |
| 4 | 冷却排队到期时还在说话 | **等到 idle**，不二次打断；超过 10 s TTL 丢弃 |
| 5 | demand 会话静默阈值 | **600 ms**（空闲 tap 仍 1500 ms） |
| 6 | 切换模式时已提交的回复 | **继续**，只停旧输入 |
| 7 | 非当前模式的输入区 | **同高提示区替换**，窗口不跳、草稿保留 |
| 8 | 语音模式的麦克风 | **选中即开麦**，切走即关；权限失败退回文字 |
| 9 | 听音中按文字发送 | 语音模式没有发送键；切到文字模式会先取消未提交的语音轮 |

### 13.3 模式 × 状态矩阵

`listening` 只存在于语音模式；文字 / 互动模式不会出现 listening。`phase` 仍由 `TurnCoordinator` 统一维护。

| 当前 phase | 文字模式 | 语音模式 | 互动模式 |
|---|---|---|---|
| `idle` | 发送 = 起文字轮 | 开口 = 开始听 | 轻点 / demand = 起触摸轮 |
| `thinking` | 发送 = 停播 + cancel + 新轮 | 开口 = cancel + 开始听 | 轻点 = 只视觉；demand = 停播 + cancel + 新轮 |
| `speaking` | 发送 = 停播 + cancel + 新轮 | 开口 = 停播 + cancel + 开始听 | 轻点 = 只视觉；demand = 停播 + cancel + 新轮 |
| 冷却期 | 正常发送 | 正常听 | demand 排队，到期等 idle |

触摸仲裁只剩 `idle / thinking / speaking / cooling` 四态：

| 当前 phase | backchannel（tap 1–2） | demand（tap≥3 / pat / hold / knead / stroke） |
|---|---|---|
| `idle` | 起一轮互动（走闸门） | 起一轮互动（走闸门） |
| `thinking` | 视觉脉冲 + 记账，不排队 | 立即 cancel；会话结束后起新轮 |
| `speaking` | 视觉脉冲 + 记账，不打断 | 立即停播 + cancel；会话结束后起新轮 |
| 冷却期 | 视觉 + 记账，不排队 | 排队；冷却结束且 idle 时起一轮（TTL 10 s） |

### 13.4 意图分类与两阶段事件

`classifyTouchIntent` 只看已经聚合好的会话事实：

| 意图 | 手势与条件 |
|---|---|
| `backchannel` | `tap` 且 `count <= 2` |
| `demand` | `tap` 且 `count >= 3`；`pat`；`hold`；`knead`；`stroke` |

两阶段：

1. **`ui.touch-intent`**（渲染层 → 主进程，立即）：`TouchTracker.liveIntent()` 在手势刚成立时返回一次 demand 手势（每条会话 latch 一次）。主进程只做「停播 + cancel」，不记账、不发起新轮；取消后留一个 2.5 s 兜底，避免完整会话丢失时卡在 `cancelling`。
2. **`ui.touch`**（会话结束，完整事实）：沿用 `TouchMessage`（gesture / regions / count / duration_ms），按 §13.3 决定起轮、排队或丢弃。

时序：

- demand 会话静默阈值 `TOUCH_DEMAND_SESSION_GAP_MS = 600`；空闲 tap 仍 `TOUCH_SESSION_GAP_MS = 1500`。
- demand 不再重复等闸门 600 ms 去抖（`onHit(..., debounceMs=0)`）；冷却 / 每分钟上限照旧。
- backchannel / 空闲 tap 仍走 `HIT_DEBOUNCE_MS = 600`。

### 13.5 三种模式各自的输入路径

- **文字**：`chat.send` → `TurnCoordinator.startHttp()` → HTTP `/chat/stream`。忙时 `startHttp` 先 `cancelAll()`（停播 + 取消 HTTP/WS），再发新轮；渲染层不再因为 `turnActive` 静默丢弃发送。
- **语音**：选中模式即 `voiceEngine.start()`；开口 → `voice.begin` → `TurnCoordinator.startVoice()`（先取消旧轮，再推 `listening`）→ WS `/ws/voice`；说完 `voice.end` → `markVoiceEnd()`。切走时用 `VoiceEngine.stopCapture()`，**不停播**；只有这一句还没提交时才 `voice.cancel()`。
- **互动**：`setInteractMode(true)`；触摸事实仍走 HTTP `interaction`（现有 `ChatStreamRequest.interaction`）。主进程 `uiCharHit` 只接受 `mode === "touch"`；`uiTouchIntent` 只做早停播。
- **主进程的单一话筒** `app/main/turn-coordinator.ts`：
  - 维护 `mode`、`phase`、`source`（http / voice / none）、`cancelling`；
  - HTTP 与 WS 的状态先汇入它，只有当前 source 能改 phase，旧 pipeline 迟到的 `idle` 丢弃；
  - `cancelAll()` 只停在 `cancelling`，新轮用 `startHttp/startVoice` 接管，停止按钮 / 切走用 `finishCancel()`；
  - 刚开口 1 s 内忽略上一轮 cancel 迟到的 WS `idle`。

### 13.6 冷却排队

- `CharHitGate` 新增 `cooldownEndsAt(now)` / `isCooling(now)` / `isRateLimited(now)`；`onHit` 可传 `debounceMs`。
- demand 在 cooling 时进入 `queuedTouch`：
  - 与已有排队的合并（部位去重最多 3 个、count 最大、gesture 最强、duration 最大），不覆盖、不叠加成多轮；
  - 到期且 `idle` → 起一轮；仍在 thinking / speaking → 等下一次 idle（`TurnCoordinator.subscribe`）；
  - 超过 `TOUCH_QUEUE_TTL_MS = 10 s`、角色切走、或撞上 `rate_limited` → 丢弃并记 `ui.touch_queue_drop`。
- 冷却期 backchannel 直接丢弃（只视觉 + 记账），不排队。
- 切走互动模式 / 关互动时清空待发与排队；如果当时正因 intent 停在 cancelling，顺手 `finishCancel()`。

### 13.7 停播与取消

- `TurnCoordinator.cancelAll()` 先推 `state = cancelling`，再取消 HTTP 与 WS；渲染层 `renderVoiceState` 收到 cancelling 立即 `ensureVoiceEngine().interrupt()`，停掉播放队列。
- 文字发送、语音开口、demand 触摸都走同一套；停止按钮 `chat.cancel` 也走同一套（不再分别直连 orchestrator / voiceSocket）。
- 目标：发送 / 手势成立到 `PlaybackQueue` 停止 <200 ms；从松手到新轮首句仍受 LLM 延迟限制。

### 13.8 实际改动

| 文件 | 改动 |
|---|---|
| `app/renderer/index.html` | 新增 `[文字 / 语音 / 互动]` 三段控件；文字输入行与 `#mode-hint` 同高替换；移除独立 🎤 / ✋ 按钮 |
| `app/renderer/index.ts` | `inputMode`、`setInputMode`、`renderInputMode`；文字发送不再被 `turnActive` 静默拦截；`cancelling` 停播；切模式 / 换角色清理 |
| `app/renderer/style.css` | `.input-mode` / `.mode-button` / `.text-input-row` / `.mode-hint`；窗口高度 420×791 |
| `app/renderer/voice-engine.ts` | 新增 `stopCapture()`（只停采集，不停播放）；`stop()` = `stopCapture()` + `interrupt()` |
| `app/renderer/touch.ts` | `liveIntent()`、demand 600 ms 静默、`intentSent` latch、hold 期间不结算 |
| `app/main/turn-coordinator.ts`（新） | 单一话筒：mode / phase / source / cancelling / 迟到状态过滤 / 订阅 |
| `app/main/touch-arbiter.ts`（新） | `classifyTouchIntent`、`mergeTouches` |
| `app/main/char-hit-gate.ts` | `cooldownEndsAt` / `isCooling` / `isRateLimited`、`onHit` 可选 `debounceMs` |
| `app/main/ipc.ts` | 新 channel `uiInputMode` / `uiTouchIntent`；`UiInputMode` / `TouchIntentMessage`；不新增 WS 字段 |
| `app/main/ipc-handlers.ts` | 模式校验、intent 早停播、`touchIntentPending`、冷却排队、文字 / 语音 barge-in |
| `app/main/index.ts` | 创建 `TurnCoordinator`；HTTP / WS 状态汇入；注入 IPC |
| `app/preload/api.ts` / `index.ts` | `ui.setInputMode` / `ui.touchIntent` |
| **sidecar** | **零改动**：语音轮仍只有 text；触摸轮继续用 `ChatStreamRequest.interaction` |

### 13.9 验收（已跑）

**自动**：vitest **26 文件 246 例** —— `turn-coordinator` 7 例（HTTP / WS 状态不互覆盖、迟到 idle、取消后接管、订阅）、`touch-arbiter` 5 例（意图 / 合并）、`touch` 14 例（liveIntent / 600 ms 结算 / hold 期间不提前结算）、`char-hit-gate` 9 例、`ipc-contract` 26 例。pytest **549**、pre-commit **7 钩子**全绿。

**真机探针**（真实 Electron + 真实 LLM / edge TTS + 假麦克风）：

| 项 | 数字 / 结论 |
|---|---|
| 默认模式 | `text`；文字行可见、提示区隐藏；窗口 **420×791** |
| 模式切换 | 互动：`body.interacting=true`、文字行隐藏、提示「互动模式…」、发送键不可见；语音：自动开麦、提示「正在听…」、发送键不可见；三模式高度都 **791**（不跳） |
| 切回文字 | 提示区隐藏、发送键恢复、输入框自动聚焦 |
| 语音听音中切文字 | 状态 **在听 → 空闲**（未提交的语音轮被取消） |
| 文字打断 | 长回复在说时发下一句：**6 ms** 进入 `打断中`，旧轮停止；新轮被接受并出台词（不是「上一轮还没结束」） |
| 互动不打断 | 在说时切到互动，状态仍是 **在说** |
| 按住打断 | 在说时按住：**764 ms**（含 750 ms 按住）进入 `打断中`；松手后 **761 ms** 进入 `在想`，并起一轮新触摸回应 |
| 窗口高度 | 文字 / 语音 / 互动来回切，`innerHeight` 始终 **791** |

**人工仍要看**：三种按钮的手感、模式切换时是否误触、语音权限失败的回退提示、互动模式的误触率。

### 13.10 还没做 / 已知限制

- 语音与触摸**不能同时**（互斥模式的直接代价）；想边说话边摸，只能切到语音或用文字。
- 文字与触摸**不合并**；打字期间摸一下会先起触摸轮，随后发送文字会打断它。
- 模式不持久化：每次启动默认文字；语音模式选中即开麦，没有独立的「语音模式内静音」。
- 触摸仍不能删除已有部位（见 T2.5），也不能在交互模式里拖动窗口（拖动只走左上角把手）。
