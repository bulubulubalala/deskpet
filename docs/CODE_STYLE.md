# deskpet 代码规范 v1.3

> 状态：**已冻结（v1.4，2026-10-15）**，与同目录的 REQUIREMENTS.md v1.19 配套（v1.13 的发布节奏、v1.14 的 §6.10 IPC 白名单与 runtime.json 已并入本规范：IPC channel 命名见 §2、CI 措辞按「M0 只用本地 pre-commit」修正）；v1.3 把 T0.4 的日志实现（§6.1–§6.3）反写回规范，并修掉旧 §6.1 错误码域表错位在 §7 之后的问题；**v1.4 取消文件 / 函数 / 类的行数上限**（§1.2 由「尺寸上限」改为「拆分判据」）。编码阶段按本规范执行，变更走文末「变更记录」。
> 适用范围：app/（Electron + TypeScript）、sidecar/（Python）、tools/（外部引擎适配器）、scripts/、tests/。
> 两条硬要求（用户提出）：**① 模块化，便于后期维护 / 修复 / 增加功能；② 注释充分。**

## 0. 一句话原则

代码是写给人看的，顺便让机器能跑：**模块边界清楚、依赖方向单向、注释解释「为什么」。**

判断一条规范值不值得加，就问一句：**它能不能让下一个来改代码的人少踩一个坑？**

---

## 1. 模块化

### 1.1 依赖只能单向流动（最重要的一条）

    Electron：
      renderer (UI)  --IPC 白名单-->  main  --HTTP/WS-->  sidecar
      · renderer：只画界面。contextIsolation 开、nodeIntegration 关，不能碰文件系统 / 网络 / Node API，
        只能调 preload 暴露的白名单方法。
      · main：只做窗口、托盘、进程、系统集成（热键、截屏 API、权限）与转发。
        **不写业务逻辑**（记忆、prompt、TTS 调度一律在 sidecar）。
      · sidecar：所有业务逻辑与模型调用。

    Python（四层，依赖只能由外向内）：
      api/       薄路由：只做参数校验、调 service、序列化返回；一行业务规则都不许有
      services/  用例编排：把 core 的纯逻辑与 adapters 的外部调用串起来（事务边界在这一层）
      core/      纯逻辑：记忆摘要阶梯、事件协议解析、prompt 装配、状态机
      adapters/  外部世界：SQLite、DPAPI、IndexTTS、faster-whisper、云端 LLM、屏幕 OCR
      contracts/ 跨模块数据结构（Pydantic 模型 / 类型定义）

      api  →  services  →  core
                    ↘        ↑（core 定义 Protocol 接口，adapters 去实现）
                     adapters

    **core/ 禁止 import adapters/ 或 api/**，禁止直接发网络请求 / 开 GPU / 读磁盘；
    它是纯函数，因此可以在没有显卡、没有麦克风的 CI 上跑。

    例：记忆摘要是 core/（纯函数），读写 SQLite 是 adapters/db.py，
        串起来是 services/memory_service.py，暴露成 HTTP 是 api/memory.py。

### 1.2 拆分判据（**不设行数上限**）

用户于 2026-10-15 定下：**不设文件 / 函数 / 类的行数上限**。理由：行数是我们自己拍出来的刻度——一个文件 519 行本身不是缺陷，**职责混在一起才是**；拿数字卡人，只会逼出「为凑行数而拆」的假模块。

所以这一节不给数字，给**该拆了的信号**。命中任意一条就拆，按职责拆，不按行数拆：

| 信号 | 长什么样 | 怎么拆 |
|---|---|---|
| 一个文件里住着两件事 | 改 A 功能不必看 B，但每次都得到同一个文件里翻 | 抽成模块 + 一层薄 facade，对外 import 路径不变 |
| 读一个函数要来回翻 | 要滚动才看得完，或得先在脑子里记住 3 个以上中间状态 | 提炼子函数、提前 return |
| 一个类有两组不共用的字段 | 一半方法里的 `self.xxx` 在另一半方法里从不出现 | 按职责拆成协作类 |
| 单测要 mock 一串无关依赖 | 测一件小事，却要伪造整个外部世界 | 沿「纯逻辑 / I-O / 契约」轴切 |
| 参数排到第 5、6 个 | 调用点要靠位置记忆来读参数 | 收进 dataclass / 配置对象 |
| 嵌套要数括号 | if / for / try 叠到看不清出口 | 提前 return、查表代替 if 链 |

**不设上限 ≠ 放弃约束**，真正硬的东西一条都没松：
- 依赖单向（§1.1）、模块有明确出口（§1.3）、契约先行（§1.8）不变；
- 文件头必须写清**职责 / 依赖方向 / 谁调用**（§3）——所以「这个文件负责什么」永远写在文件里，不靠行数暗示；
- 每个模块必须有测试（§7），核心逻辑要能在无 GPU / 无麦克风的 CI 上跑；
- 最终判据仍是 §1.3 那句：**删掉一个模块的实现，只有它的入口文件需要改**。

> 别和 §9 的**行宽 100 列**搞混：那是排版规则（每行最多几个字符），由 ruff / prettier 强制；本节说的是文件有多长，不设限。

### 1.3 模块必须有明确出口
- Python：包内 `__init__.py` 用 `__all__` 声明公开 API，外部只从包顶层导入；私有实现加下划线前缀。
- TypeScript：每个目录一个 `index.ts` 出口；**禁止跨层深路径 import**（用 ESLint `no-restricted-imports` 强制）。
- 判据：**删掉一个模块的实现，只有它的入口文件需要改**。

### 1.4 依赖注入，不要随处 import 单例
组合根 `sidecar/app.py` 负责构造 DB 连接、TTS 引擎、LLM 客户端、时钟，再注入给 service。
好处很直接：测试里塞 fake，CI 不用 GPU 也能跑完整测试；换供应商（D2：LLM 全可配置）不用改业务代码。

### 1.5 状态用状态机，不用一堆布尔
语音会话只有一个状态变量（idle / listening / thinking / speaking / interrupted），迁移集中在**一张迁移表**里。
禁止出现 `isSpeaking` + `isListening` + `wasInterrupted` 并存——那等于要求读者在脑子里求交集。

### 1.6 配置与常量
- 可调参数进 `config.py` / `config.ts`，从 `.env` 读，默认值同步写进 `.env.example`。
- **禁止魔法数字**：阈值、超时、字数上限必须命名常量，并注明出处，例如
  `MAX_SENTENCE_CHARS = 40  # IndexTTS 硬上限，超了会吞字（需求 §3.5）`。

### 1.7 错误与取消
- 自定义异常基类 `DeskpetError` + 按域子类（LlmError / AsrError / TtsError / MemoryStoreError / ScreenError / DeviceError / StageError / PackError / SidecarError，见 `sidecar/core/errors.py`）。**刻意不叫 `MemoryError` / `SystemError`**：与内建同名，会在 `except MemoryError` 处理 OOM 时埋雷；错误码与异常类型通过类属性 `domain` 强制一致（`sidecar/core/errors.py:DeskpetError.__init__`）。
- 内部抛异常，不用返回 None 表示失败；只在边界层（api/、IPC）转成错误码 + 用户可读文案。
- 禁止裸 `except:` / 空 catch；至少要记日志并带上上下文。
- **取消是一等公民**：所有长任务接受取消令牌；被打断后必须清干净资源（音频流、GPU 锁、临时文件）。

### 1.8 契约先行
跨模块 / 跨进程的数据结构集中在 `contracts/`，用 Pydantic / interface 显式声明（对应需求 §6.2、§6.3）。
**改契约必须同时改两侧并补契约测试。**
开工顺序统一为：**先写接口 + docstring + 测试骨架，再填实现**——这样各里程碑之间能并行，不会互相等。

---

## 2. 命名

| 对象 | 规则 | 例子 |
|---|---|---|
| Python 模块 / 包 | lower_snake | `memory_ladder.py` |
| Python 函数 / 变量 | lower_snake | `build_prompt()` |
| TS 文件 | kebab-case | `stage-adapter.ts` |
| TS 函数 / 变量 | camelCase | `playAct()` |
| 类 / 类型 | PascalCase | `StageAdapter` |
| 常量 | UPPER_SNAKE | `MAX_SENTENCE_CHARS` |
| 布尔 | is / has / can 开头 | `isSpeaking`、`hasVoice` |
| 角色包目录 | kebab-case | `characters/amber-gf/` |
| IPC channel | `deskpet:<域>:<动作>`（域用 lower_snake） | `deskpet:health:get` |

不用缩写（`usr`、`cfg`、`mgr` 一律写全）；文件名与类名对得上，方便 `Ctrl+P` 跳转。

---

## 3. 注释与文档（第二条硬要求）

### 3.1 三种注释，各司其职
1. **文件头 docstring**：这个模块负责什么、依赖方向、谁在调它。
2. **公开 API docstring**：用途 / 参数 / 返回 / 抛什么异常 / 副作用（网络、GPU、磁盘、音频设备）。
3. **行内注释**：只写「为什么」，不写「是什么」——代码本身已经说了是什么。

### 3.2 必须写注释的 8 个场景（评审时逐条看）
1. 魔数与阈值：数值哪来的、谁定的（引用需求章节或实测记录）。
2. 时序 / 等待 / 重试：为什么等 150ms、为什么重试三次。
3. 状态机迁移条件：什么事件触发哪种迁移。
4. 竞态与取消：打断时为什么先停播放再清队列。
5. prompt 模板：这段提示词想达到什么效果，**以及不可信输入的边界**（屏幕文本 / 记忆 / 角色包文本必须包在隔离标记里）。
6. 协议字段：事件 `t=s/m/a/end` 各字段含义与版本。
7. 临时方案与兼容：`TODO(名字, 日期): 做什么 + 什么条件下可以删`。
8. 性能取舍：为什么串行、为什么切成 40 字、为什么这里加缓存。

### 3.3 规则
- **注释与文档用中文，标识符用英文**；专有名词保留英文（IndexTTS、faster-whisper、Live2D）。
- 禁止三样：注释掉的死代码（删掉，git 记得住）、与代码矛盾的注释（改代码必须改注释）、无主 TODO。
- 注释密度不是指标：**废话注释比没有注释更糟**。评审看的是关键决策处有没有解释。

### 3.4 示例：什么算「充分注释」

    # sidecar/core/memory_ladder.py
    """记忆摘要阶梯（L0 原文 → L1 会话 → L2 情节弧 → L3 关系状态）。

    依赖方向：core 层，禁止 import adapters/ 或 api/。纯函数，输入文本输出文本，便于单测。
    调用方：services/memory_service.py —— 每轮对话结束后、以及后台空闲时调用。
    """

    from __future__ import annotations

    L1_MIN_TURNS = 12        # 攒够 12 轮再做会话摘要：更少会把寒暄也写成「事件」（实测见 docs/）
    SUMMARY_MAX_CHARS = 800  # 摘要目标长度：云端 LLM 成本与信息量的平衡点

    def summarize_l0_to_l1(turns: list[Turn], llm: Summarizer) -> str:
        """把 L0 原文压缩成 L1 会话摘要。

        Args:
            turns: 按时间升序的对话轮次。
            llm:   可注入的摘要器；测试里塞 fake，不联网。
        Returns:
            摘要文本。**不包含**对用户的承诺与时间承诺——那些由 core/promise.py 单独抽取，
            否则「明天提醒你」这类承诺会在摘要里被抹掉。
        Raises:
            LlmError: 上游失败时向上抛，由 service 层决定重试还是降级为「本轮不压缩」。
        Side effects:
            无（除了调用注入的 llm）。
        """

---

## 4. 工具链（能自动化的都不靠自觉）

| 层 | 工具 | 配置要点 |
|---|---|---|
| Python 格式化 + lint | **Ruff**（`ruff format` + `ruff check`） | line-length 100，target-version py312 |
| Python 类型 | **mypy** | core/ 开 strict，adapters/ 放宽（第三方 SDK 类型不全） |
| Python 测试 | **pytest** + pytest-asyncio | core/ 覆盖率 ≥ 85%，整体 ≥ 70% |
| 前端格式化 | **Prettier** | 默认风格 |
| 前端 lint | **ESLint** + typescript-eslint | `no-restricted-imports` 实现 §1.3 的边界规则 |
| 前端类型 | **tsc --noEmit**，`strict: true` | 不用 `any`；实在要用必须带注释说明原因 |
| 前端测试 | **Vitest** | 组件 + IPC 契约 |
| 提交前 | **pre-commit**：ruff、mypy(core)、eslint、prettier --check、commitlint | 本地就拦住，别等 CI |
| CI | **M0 只用本地 pre-commit**（ruff check / format、mypy、eslint、prettier --check、tsc --noEmit）；**GitHub Actions（lint → type → test → Windows 打包 smoke）推迟到 M5（按需）** | 先守住本地这道闸；流水线与 Release 一起在 M5 做（需求 v1.13） |

---

## 5. 提交、分支、版本

- **Conventional Commits**：`type(scope): 摘要`
  - type：feat / fix / refactor / perf / test / docs / chore / build / ci
  - scope：app / sidecar / api / core / memory / tts / asr / llm / stage / pack / screen / build / docs
  - 例：`feat(memory): 实现 L0→L1 会话摘要`、`fix(tts): 打断后残留尾音`
- 一次提交只做一件事；PR 建议 < 400 行 diff。
- 分支：`main` 保护；功能 `feat/xxx`、修复 `fix/xxx`；发布打 tag（SemVer）。
- PR 模板四问：**为什么改 / 改了什么 / 怎么验证 / 有什么风险**。
- 需求文档版本（REQUIREMENTS.md v1.x）与软件版本（0.1.0 起）分开记；角色包 `pack_version` 独立。

---

## 6. 日志与错误码

### 6.1 日志行 schema（T0.4 冻结）

单行 JSON、UTF-8、LF 换行，落点 `data/logs/deskpet.log`（目录可用 `DESKPET_DATA_DIR` 改）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `ts` | ✓ | ISO 8601（含 +00:00 与毫秒） |
| `level` | ✓ | DEBUG / INFO / WARNING / ERROR |
| `logger` | ✓ | `deskpet.<模块>`，例 `deskpet.sidecar.main` |
| `message` | ✓ | 一行摘要；**用户可见文案不放这里** |
| `module` | ✓ | 业务模块名，例 `sidecar.main` / `api.error_handlers` |
| `event` | ✓ | 稳定事件名，例 `sidecar.launch` / `deskpet_error` / `unhandled_error` |
| `code` | 异常时 | `DP-域-三位` |
| `domain` | 异常时 | 错误码域（LLM / ASR / …） |
| `trace` | 异常时 | 完整堆栈（多行字符串，仍包在同一行 JSON 内） |
| 业务字段 | 可选 | 例 `pid` / `port` / `path` / `sentence_index` |

统一由 `sidecar/core/logging.py:log_event()` 产出，业务字段走 logging 的 extra 里挂 `dp` 键；保留键不允许被业务字段覆盖。**禁止 print / console.log 留在提交里。**

### 6.2 敏感字段脱敏

字段名命中即替换为 `[已脱敏]`：`api_key` / `apikey` / `authorization` / `token` / `password` / `prompt` / `messages` / `conversation` / `memory_text` / `memory_body` / `ocr_text` / `screen_text` / `ref_audio_path` / `reference_audio`（屏幕 OCR 原文、记忆正文、参考音绝对路径按需只记长度或 hash）。实现在 `sidecar/core/logging.py:redact_fields()`——**新增敏感字段先改这张表，再写代码**。

### 6.3 滚动与保留

- 单文件超 `DESKPET_LOG_MAX_BYTES`（默认 20 MB = 20971520）即滚动为 `deskpet.log.<UTC 时间戳>`；早于 `DESKPET_LOG_RETENTION_DAYS`（默认 7 天）的历史文件自动删除。
- 每次写入现开现关（Windows 下持有句柄会挡住改名 / 删除）；写日志失败不得影响业务（兜底 stderr）。
- 只给 `deskpet` logger 装一个 handler（`propagate = False`），不接管 uvicorn 与第三方库的日志。

### 6.4 错误码域表（与需求 §6.7 配套）

| 域 | 前缀 | 典型错误 |
|---|---|---|
| LLM | DP-LLM | 鉴权失败、限流、超时、返回体解析失败 |
| ASR | DP-ASR | 设备占用、识别超时、空结果 |
| TTS | DP-TTS | 引擎未加载、单句超时、合成失败 |
| 记忆 | DP-MEM | 加密密钥失效、DB 只读降级、FTS 索引异常 |
| 屏幕 | DP-SCR | 截屏失败、OCR 失败、权限被拒 |
| 设备 | DP-DEV | 麦克风 / 扬声器不可用 |
| 形象 | DP-STAGE | Live2D 模型缺失、回退 PNG |
| 角色包 | DP-PACK | 必填字段缺失、素材不可解码 |
| 进程 | DP-SYS | sidecar 离线、重启次数超限、版本不匹配 |

约定：错误码只在边界层（HTTP / IPC）出现（实现见 `sidecar/api/error_handlers.py`），内部一律抛 `DeskpetError` 子类；日志里 code 与 domain 两者都记。非 `DeskpetError` 的未预期异常统一回 `DP-SYS-500`（对外只说「sidecar 内部错误」，细节只进日志，`event=unhandled_error`）。级别用法：DEBUG 开发排查 / INFO 状态变化 / WARNING 可恢复异常 / ERROR 用户能感知的失败。

---

## 7. 测试

- 金字塔：core 纯逻辑单测（快）→ 契约测试（事件协议 §6.2、API §6.3）→ sidecar 集成（fake 引擎）→ 手动 E2E 清单（真 GPU、真麦克风）。
- **音频与 GPU 相关代码必须能无硬件跑测试**：靠接口隔离 + fake 实现（这也是 §1.4 依赖注入的目的）。
- 一个模块「完成」的定义：**实现 + docstring + 测试 + 无未登记 TODO + 职责单一（§1.2）**。
---

## 8. PR 自查清单

- [ ] 依赖方向没被破坏（renderer 没碰 Node；core 没 import adapters）
- [ ] 新模块有明确出口，外部没有深路径 import
- [ ] 没有魔法数字；新常量注明了出处
- [ ] 关键决策处（时序 / 竞态 / prompt / 阈值）有注释
- [ ] 公开函数有 docstring，含副作用与异常
- [ ] 有测试；core 的测试不依赖网络与 GPU
- [ ] 日志不含敏感信息
- [ ] 提交信息符合 Conventional Commits；PR 描述回答了「怎么验证」

---

## 9. 已定的 5 个点（v1.0 冻结）

| # | 项 | 决定 |
|---|---|---|
| 1 | 行宽 | 100 |
| 2 | Python 基线 | 3.12（pyproject 里 requires-python = ">=3.12"） |
| 3 | 覆盖率门槛 | core/ ≥ 85%，整体 ≥ 70%（CI 不达标即失败） |
| 4 | 注释语言 | 注释与文档用中文，标识符用英文 |
| 5 | M0 工具链 | **M0 即上 pre-commit**；GitHub Actions 与 Windows 打包 smoke 推迟到 M5（按需，需求 v1.13） |

## 10. 变更记录

- **v1.4（2026-10-15）**：**取消尺寸上限**（用户决定）。§1.2 由「尺寸上限」表（文件 400 行 / 函数 60 行 / 类 300 行 / 参数 5 个 / 嵌套 4 层）改写为「**拆分判据**」：不再给数字，改为列「该拆了的信号」（一个文件两件事 / 读函数要来回翻 / 类里两组不共用字段 / 单测要 mock 一串无关依赖 / 参数排到第 5、6 个 / 嵌套要数括号），并明确按职责拆而非按行数拆；同时点明**不设上限不等于放弃约束**（依赖单向、模块出口、文件头写职责、必须有测试、§1.3 的删除判据都不变），并区分**行宽 100 列**（§9，仍强制）与文件长度（不设限）。背景：`scripts/indextts_server.py` 519 行为此前的 400 行上限超限，用户据此决定去掉上限。§7 的模块完成定义同步改为「职责单一（§1.2）」；适用范围补 `tools/`。
- **v1.3（2026-10-14）**：**T0.4 完成**，§6 从「4 条散点」改写为 **§6.1 日志行 schema**（ts/level/logger/message/module/event/code/domain/trace + 业务字段）、**§6.2 敏感字段脱敏清单**（14 个字段名，`redact_fields()`）、**§6.3 滚动与保留**（20 MB / 7 天、现开现关、只装一个 handler、写失败兜底 stderr）、**§6.4 错误码域表**（从错位的旧 §6.1 移回 §6 下，并补「边界层才出现错误码 / 非 DeskpetError 回 DP-SYS-500 / 对外不吐细节」）；§1.7 的异常子类列表据实现更正为九个（`MemoryStoreError` 不叫 `MemoryError`）。
- **v1.2（2026-10-14）**：§2 命名表新增 **IPC channel** 规则（`deskpet:<域>:<动作>`，与需求 §6.10 配套）；§4 与 §9 的 CI 条款按需求 v1.13 修正为「M0 只用本地 pre-commit，GitHub Actions 推迟到 M5」。
- **v1.1（2026-10-14）**：新增 §6.1 错误码域表（DP-LLM / ASR / TTS / MEM / SCR / DEV / STAGE / PACK / SYS），与需求 §6.7 配套。
- **v1.0（2026-10-13）**：由草案 v0.1 冻结。用户确认 5 个待定点（行宽 100、Python 基线 3.12、覆盖率 core ≥85% / 整体 ≥70%、中文注释 + 英文标识符、M0 即上 pre-commit + CI）；§4 的 Ruff target-version 落定为 py312。

