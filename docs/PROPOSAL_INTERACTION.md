# deskpet · 方案（v0.3，已获批）：人格导入 / 开发者模式 / 交互感知 / 角色包编辑器

> 状态：**已获批（用户 m09634「照此执行」）**；块 A（三只示例人格 + 换人感知）已于 2026-10-18 落地
> 日期：2026-10-18　版本：方案 v0.3（依据 m09592 需求 + m09622 五条决策 + m09634 三条补充）
> v0.2 → v0.3 变化：① 开发者模式开关定为 **`data/dev.json`**（`localStorage` 方案弃用：设置窗与主窗都要能读）；
> ② 部位点击的 streak 改成**整串累计**（不要求点在同一部位，跨部位连点也算同一串）；
> ③ 记忆编辑范围定案：**原文只读、只允许编辑 L0**（新增 `PATCH /memory/<id>`）；冷却 8 s / 每分钟 4 次、streak ≥10 无视先按默认；
> ④ 块 A 已落地：`characters/{amber,snow,momo}` + `scripts/persona_switch_check.py`（offline 4/4、`--live` 5/5）。

---

## 0. 已定决策（m09622）

| # | 你的决定 | 落进方案的位置 |
| --- | --- | --- |
| 1 | 导入 **amber / snow / momo**（amber 已存在，按 amber-sfw.md 对齐；新建 snow、momo） | §2 |
| 2 | 部位点击**走 LLM**；要能按点击次数给不同回应 | §4.3 |
| 3 | 自建角色包**先存仓库根目录的 characters/** | §5.3 |
| 4 | 点版本号 20 次开启；开启后设置里才出现「关闭开发者模式」与「角色记忆」 | §3.1 |
| 5 | 「角色记忆」两页：第一页原文，第二页注入上下文（= 预期给模型看的那份） | §3.3 |

---

## 1. 现状总览（要点，细节见 v0.1 保留的 §1）

- **角色包**：`characters/<char_id>/` 下 `card.json` / `pack.json` / `appearance.json` / `voice.json` / `emotion_map.json` / `assets/`；加载器 `sidecar/services/character_store.py:356 load_character_pack`；主进程列表 `app/main/character-list.ts:27 listCharacters`。
- **角色切换**：`app/renderer/index.ts:234 selectCharacter` → `api.ui.setState({char_id})`；记忆按 char_id 分库，切换写 `usage.db` 的 `switch_log`。
- **必先修的真 bug**：`app/renderer/index.html:29` 写死 `src=\"assets/placeholder.png\"`，渲染层没有任何 `.src =` 赋值 → 角色包的立绘根本没被加载，切角色看到的是同一张占位图。`appearance.portrait` 目前只有 sidecar 在校验。**这是 §4.3 与 §5 的前置**。
- **坐标**：现在 `.character` 是 `object-fit: cover`（会裁切）→ 部位命中前要改 `contain` 并算出「显示区 ↔ 素材」的偏移与缩放。
- **记忆**：`data/memories.db`（SQLCipher），表 `messages / memories / summaries / state` + 两张 FTS5；L0→L3 四层。现有 API 只有 search / list / write / delete / clear，**没有 update、没有读原文、没有读摘要、没有装配预览**。
- **使用统计**：`data/usage.db` 的 `session`（时长、消息数、**打断次数**、语音/文本、屏幕截图次数、provider）、`char_usage`（每角色时长/会话数）、`switch_log`（角色切换）、`daily`。
- **行为观察**：`sidecar/services/behavior_memory_service.py:50-66` 三条规则（打断频率、主时段、角色偏好）→ 产出 `kind=action` 的 L0 事实，每小时最多刷新一次。
- **感知不到**：窗口移动/拖动、任何鼠标点击、缩放/穿透/置顶开关、键盘行为、语音的音量/语速。
- **设置窗**：`app/renderer/settings.ts:769` 已经在显示版本号（`#app-version`），20 击手势只需加在它上面。

---

## 2. 块 A：hermes 人格导入（amber 对齐 + snow + momo）+ 换人验测

### 2.1 三个包
| char_id | 来源 | 动作 |
| --- | --- | --- |
| `amber` | `/home/sch/.hermes/personas/amber-sfw.md` | **已存在**：对照 md 的「说话风格 / 不要」把 `speaking_style` 与 `personality` 补齐，并把 `first_mes` / `alternate_greetings` 改成**不带括号动作**的写法（md 明确「不写旁白、不写括号动作说明」） |
| `snow` | `snow-sfw.md`（小雪·银白狐娘） | 新建：嘴硬、反问代替正面回答、话越认真越短 |
| `momo` | `momo-sfw.md`（莫莫·黑狼娘） | 新建：话极少、能一个字不用两个字、沉默是常态 |

每个包 = `card.json`（手写：`display_name` / `description` / `personality` / `speaking_style` / `scenario` / `first_mes` / `mes_example` / `proactive` / `verbosity` / `anti_sycophancy`）+ `pack.json` + `appearance.json`（暂共用占位立绘，等 §5 的编辑器让你换）+ 无 `voice.json`（沿用「示例角色先不做语音」）。**纯数据，不改 sidecar 代码。**

三张卡的性格差异要能一眼看出来：amber 嘴硬但话多、主动找话说；snow 嘴硬且用反问、越认真越短；momo 极简、沉默本身是回答。`anti_sycophancy` 三个都保持高（0.8+），momo / snow 的 `verbosity` 压到 0.25–0.3。

### 2.2 换人感知验测（新增 `scripts/persona_switch_check.py`，离线 + `--live`）
1. **人格生效**（离线断言）：切到 X 后装配出的 system 提示词含 X 的 display_name 与风格要点。
2. **记忆隔离**：对 amber 说一个事实 → 切 snow 问同一件事（注入里不含该事实）→ 切回 amber 问（应记得）。
3. **切换留痕**：`switch_log` 有 from→to、`char_usage` 分角色独立计数。
4. **观察派生**：三角色来回切够样本后跑一次 `BehaviorMemoryService.refresh`，应产出「他常来找 X」。
5. **风格可分**（live，人工看）：同一个问题问三只，回复风格肉眼可分。

---

## 3. 块 B：开发者模式 + 「角色记忆」两页

### 3.1 入口（m09622 第 4 条）
- 手势加在 `#app-version`：**间隔 >1000 ms 未点即归零**，累计 20 次进入；再连点 20 次退出。
- 开启前：设置窗里**什么都没有多**（普通用户看不到任何入口）。
- 开启后，设置窗多两样东西：
  1. `<h2>角色记忆</h2>` 区（角色下拉 + 两页内容）；
  2. 一个「**关闭开发者模式**」按钮（点了就退出并恢复原样）。
- 开关存储：**写 `data/dev.json`**（用户 m09634 定案；设置窗与主窗都能读；不进角色包、不占 `.env` 键）。
- 契约里写明：**这是界面级显隐开关，不是安全边界**（本机 API 本就有 token 鉴权）。

### 3.2 两页结构（m09622 第 5 条）
| 页 | 名字 | 内容 | 数据来源 |
| --- | --- | --- | --- |
| 第 1 页 | **原文** | `messages` 表：会话 id / 角色（user·assistant）/ 文本 / 时间 / 是否已被摘要覆盖（`covered_by`） | 新增 `GET /memory/messages` |
| 第 2 页 | **注入上下文** | **下一轮真的会塞给模型的那份记忆**，按 section 展开：L3 最新 / L2 / L1 摘要、L0 事实（检索命中的）、行为观察、最近历史；每段标注 token 数与预算、被裁掉的部分（`dropped`）、注入的 memory_id 列表 | 新增 `GET /memory/context` |

第 2 页的细节：
- 复用一个可传 `query` 的参数：`GET /memory/context?char_id=amber&query=…` —— 你可以在设置窗里敲一句「像用户会说的话」，直接看这轮会注入什么。空 query 就是「没有新话题」时的基础注入。
- 页面上同时给两个视图：**结构视图**（上面那张表）与**最终文本**（真正拼进 system 的那段记忆片段原文），后者用来核对格式与 untrusted 包裹。
- 每行 L0 事实带「编辑」按钮 → 就地改文本 / 种类 / 重要度（走 §3.4 的 PATCH），并给「刷新预览」看改完的效果。
- 页 1（原文）**只读**：它是压缩链路的输入，改了会破坏 `covered_by` 的覆盖关系。

### 3.3 编辑能力（回答你 m09592 的「查看、编辑」）
- **可编辑**：L0 记忆条目（文本、`kind` ∈ fact/preference/event/action、重要度 0–1）、新建一条、删除单条、清空该角色。
- **只读**：`messages` 原文、`summaries` 摘要（附一个「立即压缩一次」按钮，手动跑 L1→L2→L3）。
- 理由：摘要改坏会污染之后所有压缩；原文改坏会让「已覆盖」区间对不上。要改就删掉重新走一遍压缩，这是可控的。

### 3.4 需要的 API（sidecar）
- `PATCH /memory/<id>`：`MemoryUpdateRequest{text?, kind?, importance?, tier?}` → 适配器 `UPDATE` + **重算 `text_key` 去重键 + 同步 `memories_fts`**（最容易写错的地方，单独写单测）。
- `GET /memory/messages?char_id&limit&before_id`（第 1 页，只读）。
- `GET /memory/context?char_id&query`（第 2 页）—— 干跑一次 `MemoryService.recall` + `_fit_recall`，返回 sections / tokens / budget / dropped / injected_ids + 最终文本；**不调 LLM**。
- （可选）`POST /memory/compress?char_id`（第 2 页的「立即压缩一次」）。

### 3.5 拆分
- **B1**：手势 + 开启态两样东西 + 两页只读浏览（含注入预览）——安全、先让你看见真相。
- **B2**：编辑（PATCH + 新建 + 删除）+ FTS 同步单测。

---

## 4. 块 C：交互感知（晃动 + 部位点击）

### 4.1 统一管道
**动作发生 → ① `usage.db` 计数 → ② 规则聚合成 `kind=action` 观察（进提示词）→ ③ 角色反应走 LLM**。计数永远可靠；观察样本不足就不下结论；反应才花钱。

### 4.2 C1 窗口晃动（主进程，零渲染层改动）
- 数据源：`BrowserWindow` 的 `move` 事件（拖动链路 `beginDrag/stepDrag` 本来就在动窗口）。
- 判定：800 ms 滑窗内**方向反转 ≥4 次**且单次位移 ≥15 px → 记一次「晃动」；1.5 s 冷却，一次甩动不记成十次。
- 输出：`session` 加列 `window_shake_count`（沿用 T1.14 的 ALTER TABLE 迁移套路）；观察文案「他着急或者无聊的时候会晃你」；反应可选（本地一句，不必走 LLM）。

### 4.3 C2 部位点击（走 LLM + 按次数分级）

**前置**：修 §1 的立绘 bug + 改 `contain` + 定义部位文件。

**部位文件** `hits.json`（放角色包里，坐标用 **0–1 归一化**，换素材/缩放都不炸）：

```json
{
  \"version\": 1,
  \"regions\": [
    {
      \"id\": \"head\",
      \"name\": \"头\",
      \"rect\": [0.31, 0.03, 0.38, 0.22],
      \"color\": \"#ffb347\",
      \"reactions\": [\"别摸头。\"],
      \"act\": \"blush\"
    }
  ]
}
```

`rect` 是 [x, y, w, h]（相对素材宽高的比例）。`reactions` 与 `act` 是**离线兜底**（LLM 起不来时用）。

**点击次数怎么变成不同回应（你的问题）**——分三层，从快到慢：

1. **渲染层统计成「串」**：两次点击（**不限同一部位**）间隔 ≤1200 ms 算同一串，`streak` 递增；间隔超时归零。另标 `kind`：`single` / `double`（间隔 ≤300 ms）/ `hold`（按住 >600 ms）。
2. **主进程决定「要不要花一次 LLM」并合并**：上报 `{region_id, streak, gap_ms, kind}`；LLM 冷却 8 s（整串共用一个冷却）、全局每分钟最多 4 次。**冷却期里的点击只累加 streak**，等下一次真的发起时把最新的次数一起带上 —— 于是一口气戳 12 下只会产生一次调用，而模型看到的是「已经 12 下」。
3. **提示词里给的是事实，让模型自己分档**（写进 system 的独立一段【刚刚发生的互动】，不是用户消息）：

| streak | 注入描述 | 期望反应（靠人格，不硬编码台词） |
| --- | --- | --- |
| 1 | 他戳了一下你的「脸」 | 正常反应，可能反问 |
| 2–3 | 他连着戳了你的「脸」3 下 | 不耐烦、嫌烦、嘴上赶人 |
| 4–6 | 他一秒不到戳了你的「脸」6 下 | 明确制止 / 提条件 / 吐槽 |
| 7–9 | 他不停戳你的「脸」（已经 8 下） | 威胁、讨价还价 |
| ≥10 | 同上 + 「你可以不理他」 | **允许无视**（本地直接吞掉点击，不再发起 LLM）——符合「不无条件顺从」 |

**体感**：点击瞬间先给本地微反馈（气泡进「在想」+ 角色包 `acts` 里的动作，0 延迟），LLM 回复 1–3 s 后正常播报——LLM 的延迟被即时反馈盖住。

**降级**：LLM 不可用 / 端点失败 → 用 `hits.json` 的 `reactions` 本地台词；离线替身模型走同一路径。

**安全**：部位名来自角色包（可能是用户自建的数据）→ 注入前**截断到 24 字、去换行**，并和其它外部内容一样按不可信数据处理（`wrap_untrusted` 或至少加分隔与转义），不能让「部位名」变成一条指令。

**计数与观察**：`usage.db` 新表 `char_hits(char_id, region_id, count, max_streak, last_at)`；观察文案「他老戳你的脸」（importance 0.4，节流同行为记忆）。

### 4.4 要你补一句的两个参数（不阻塞开工，做时给默认值）
- LLM 冷却 8 s / 每分钟 4 次 → 嫌吵可以调大；
- `streak ≥10` 就无视，是否改成 6 或 15。

---

## 5. 块 D：角色包编辑器（上传 PNG + 裁切 + 部位框）

### 5.1 形态
设置窗「角色与立绘」→「新建角色包」→ **独立窗口**（新 `editor.html` / `editor.ts` + 主进程 `createEditorWindow`，建议 1000×700、可缩放）。四步向导：**选图 → 裁切 → 画部位 → 填卡片 → 保存**。

### 5.2 每步
1. **选图**：主进程 `dialog.showOpenDialog`（png/jpg/webp）→ 经 IPC 回传 dataURL（比放开 CSP 的 `file:` 干净）。
2. **裁切**：Canvas 拖框 + 四角手柄，自由比例；确认后画进新 canvas 并 `toDataURL(\"image/png\")`。
3. **画部位**：在裁切结果上继续拖框 → 输入部位名（**预置「身体」覆盖全身**）→ 可改颜色、可删、可复制上一框；导出成 §4.3 的 `hits.json`（归一化 rect）。
4. **填卡片**：`char_id`（英文，作目录名）、`display_name`、一句话 `description`；`personality` / `speaking_style` 可留空。
5. **保存**：主进程写 `characters/<char_id>/` 下的 `assets/portrait.png`（Buffer）+ `card.json` + `pack.json` + `appearance.json` + `hits.json`；写完刷新聊天条角色弹出层。

### 5.3 存哪（你选：仓库根目录）
- 落 `characters/{char_id}/`（即 `DESKPET_CHARACTERS_DIR`，`sidecar/config.py:89` 的默认值）。
- **已知限制（先记下，不改）**：打包安装到 `Program Files` 时这个目录通常不可写；到时若报写入失败，再给「用户目录」作为第二落点（这一条写进风险，不现在做）。

### 5.4 契约与复用
- 新 IPC：`deskpet:pack:pick-image`、`deskpet:pack:save`。
- 新渲染层文件 `app/renderer/editor.{html,ts,css}`（Canvas 交互，约 300–500 行，本项目第一段真正的图形交互代码）。
- 命中测试与坐标换算的代码**必须与 C2 共用**（抽到一个模块，别写两份）。

---

## 6. 契约与数据变更汇总

| 类别 | 新增/变更 |
| --- | --- |
| HTTP API | `PATCH /memory/<id>`、`GET /memory/messages`、`GET /memory/context`、（可选）`POST /memory/compress` |
| IPC | `deskpet:ui:char-hit`、`deskpet:pack:pick-image`、`deskpet:pack:save` |
| 角色包 | 新文件 `hits.json`（部位 / 颜色 / 兜底台词 / act）；`card.json` 等字段不变 |
| usage.db | `session` 加列 `window_shake_count`；新表 `char_hits` |
| 行为规则 | 新增 2 条（晃动、部位点击），文案 + importance 固定档，不带次数（否则去重键失效） |
| config | 暂无新键（`DESKPET_CHARACTERS_DIR` 已存在）；保留 `DESKPET_USER_CHARACTERS_DIR` 作为打包后的备选 |
| 文档 | REQUIREMENTS §6.4（记忆编辑与预览）/ §6.10（IPC）/ §6.11（交互与部位）/ §6.13（路径）；PLAN 新里程碑；MEASURED 各段；ACCEPTANCE |

---

## 7. 建议顺序与工作量

| 顺序 | 内容 | 预估 | 依赖 |
| --- | --- | --- | --- |
| A | amber 对齐 + snow / momo 角色包 + `persona_switch_check.py` | 0.5–1 轮 | 无 |
| C1 | 晃动检测 + 计数 + 观察 | 0.5–1 轮 | 无 |
| B1 | 20 击入口 + 「角色记忆」两页只读（含注入预览） | 1–1.5 轮 | 新 API 两条 |
| B2 | L0 编辑（PATCH + FTS 同步）+ 新建/删除 | 0.5–1 轮 | B1 |
| C2 | 立绘真加载（修 bug）+ `contain` + 部位点击 + 点击分级 + LLM 反应 + 兜底 | 1.5–2 轮 | C1、hits.json |
| D | 编辑器窗口 + 上传/裁切/部位框/保存 | 2–3 轮 | B1、C2 |

先做 A 的理由：纯数据、零风险，做完你立刻能切三只角色肉眼看风格差异，也顺手把「换人感知」验掉。

**明确不做**：屏幕识别（F7）、Live2D（M3）、语音（等你定 A/B/C）、角色包导出与市场（F6 仍下调）。

---

## 8. 已定案（用户 m09634）

1. **方案整体照此执行**：包含 §3.3 的收窄 —— **原文只读、只允许编辑 L0**（要连原文也能改再说）。
2. §4.4 两个参数（LLM 冷却 8 s / 每分钟 4 次；streak ≥10 无视）**先按默认值**，之后按体感调。
3. 开发者模式开关定 **`data/dev.json`**（跨窗口可读；不占 `.env` 键、不进角色包）。
4. 部位点击**先设一套默认部位划分**，次数按**整串累计**。

## 9. 附：本次勘察读过的关键位置
- 角色包：`sidecar/services/character_store.py:356`、`app/main/character-list.ts:27`、`characters/amber/{card,pack,appearance}.json`
- 立绘 bug：`app/renderer/index.html:29`、`app/renderer/index.ts:357 reportMetrics`、`:366 api.ui.metrics`
- 记忆：`sidecar/api/memory.py`、`sidecar/services/memory_service.py:180/208/216/224`
- 统计与观察：`sidecar/adapters/usage_sqlite.py:30-62/208/250`、`sidecar/core/usage.py:34-108`、`sidecar/services/usage_service.py:109/129`、`sidecar/services/behavior_memory_service.py:50-66`
- 设置窗：`app/renderer/settings.html`、`app/renderer/settings.ts:769`
- hermes 人设源：`/home/sch/.hermes/personas/`（amber-sfw / momo-sfw / snow-sfw / coldai / default / null）
