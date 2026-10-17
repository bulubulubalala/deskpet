# deskpet · 模块化与规范有效性审计（2026-10-18）

> 触发：用户 m09634「开始做并要求整体梳理项目确保模块化与规范有效」。
> 方法：脚本化静态统计（文件行数 / 函数数 / >100 列行 / TODO / 跨文件 6 行重复窗口 / 中文注释覆盖）+ 人工对照 docs/CODE_STYLE.md（v1.7）与 .pre-commit-config.yaml。
> 一句话结论：**分层、命名与门禁是有效的，没有发现逻辑重复**；但有**两个真实盲区**——`tests/` 不在 ruff 覆盖面内、覆盖率门槛（core ≥85% / 整体 ≥70%）没有任何钩子在执行。

## 1. 规模实况

| 层 | 文件 | 行数 |
| --- | ---: | ---: |
| app/main（主进程） | 21 | 4480 |
| sidecar/services | 12 | 3423 |
| sidecar/adapters | 13 | 2238 |
| sidecar/core | 14 | 2107 |
| app/renderer | 2 | 1328 |
| sidecar/contracts（含生成的 openapi.json / llm_events.schema.json） | 9 | 989 |
| sidecar/api | 11 | 757 |
| tools/indextts_adapter | 9 | 756 |
| app/preload | 2 | 242 |
| scripts | 12 | 2197 |
| tests（39 个 pytest 文件 7771 行 + 14 个 vitest 文件） | 53 | ~11000 |

合计 171 个源文件、32279 行（未计 docs/ 与 characters/）。

## 2. 大文件（>400 行）与拆分判读

判据来自 docs/CODE_STYLE.md §1.2 的六条：一个文件两件事 / 读函数要来回翻 / 类里两组字段不共用 / 单测要 mock 一串无关依赖 / 参数排到 5、6 个 / 嵌套要数括号。**行数只是提示，不是上限**（v1.4 已取消上限）。

| 文件 | 行 | 判读 |
| --- | ---: | --- |
| sidecar/contracts/openapi.json | 1622 | **生成物**（scripts/export_openapi.py），不参与人工评审 |
| app/renderer/settings.ts | 777 | 已承载「模型供给 + 记忆管理 + 行为开关」，算得上两件事；**T2.3-B1 加开发者模式前应先拆**（settings-providers / settings-memory / settings-dev） |
| sidecar/services/chat_service.py | 712 | 单类但四件事：流式编排 / 记忆写入 / 压缩调度 / provider 记账；建议抽 chat_memory.py |
| sidecar/adapters/memory_sqlite.py | 590 | 一个 store 类 + FTS + 迁移，属一件事，暂不拆但要盯 |
| app/main/sidecar-client.ts | 553 | HTTP/SSE 客户端 + 各响应解析，属一件事 |
| app/renderer/index.ts | 551 | 主窗渲染脚本（气泡 / 拖动 / 语音态 / 指标上报），接近「两件事」，加部位点击前建议先抽 |
| app/main/ipc.ts | 544 | 声明式通道与类型清单，属表，可接受 |
| tests/test_memory_service.py | 525 | 测试集合，用例多；出现「mock 一串无关依赖」再拆 |
| sidecar/config.py | 512 | Settings 各组 dataclass + env 读取，属表，可接受 |
| app/renderer/style.css | 508 | 样式表，不计 |
| sidecar/services/memory_service.py | 505 | 会话链路 + 管理端点 + 裁剪，接近两件事；建议与 chat_service 的记忆部分一并规划 |
| sidecar/core/memory.py | 496 | 数据类 + 纯函数 + Protocol，属一件事 |
| scripts/memory_check.py | 443 | 验收脚本（灌 120 轮 + 四条判据） |
| sidecar/services/character_store.py | 431 | 角色包加载与校验 |
| tests/test_chat_service.py | 429 | 测试集合 |

## 3. 跨文件重复片段（6 行窗口）

共 **19 处**，**全部是 import 列表或测试夹具，没有一处是逻辑重复**：

- `app/main/ipc-handlers.ts:20-36` ↔ `app/preload/index.ts:19-35`：同 12 个窗口，都是 `import type {...}` 的类型名列表。
- `sidecar/adapters/memory_sqlite.py:22` ↔ `sidecar/services/memory_service.py:37`：import 记忆异常与数据类。
- `tests/character-voice.test.ts` / `tests/chat-orchestrator.test.ts` / `tests/sidecar-client.test.ts` 的 `logger` 夹具；`tests/test_prompt.py` / `tests/test_prompt_memory.py` 的 `_card`；`tests/test_tts_api.py` / `test_tts_client.py` / `test_tts_service.py` 的 `payload` / `_request`。

建议（低优先）：主进程抽 `app/main/ipc-types.ts` 统一 re-export，preload 只 import；测试夹具抽 `tests/helpers.py` / `tests/helpers.ts`。

## 4. 规范盲区（带实测证据）

1. **`tests/` 不在 ruff 覆盖面内**：`.pre-commit-config.yaml:22` 与 `:29` 的 `files: ^(sidecar|tools|scripts)/.*\.py$`。后果是实测存在超限行——`tests/test_env_events_wiring.py:73`（111 列）、`:90`（115 列）、`:107`（106 列）、`:159`（106 列）。建议把 files 改成 `^(sidecar|tools|scripts|tests)/.*\.py$`，先跑一次 `ruff check --config sidecar/pyproject.toml tests` 看真实条数再修。
2. **覆盖率门槛没有执行者**：CODE_STYLE 要求 core ≥85% / 整体 ≥70%，但全仓 grep `--cov` / `fail_under` **零命中**，`pytest.ini` 的 addopts 只有 `-q`。建议加 `scripts/run_coverage.py`（`pytest --cov=sidecar --cov-report=term-missing --cov-fail-under=70`）+ 一条 pre-commit 钩子；core 的 85% 用 `[tool.coverage.report]` 分段或脚本单独判定。
3. **mypy 不含 `scripts/`**：mypy 钩子的 files 是 `^(sidecar|tools)/.*\.py$`，而 scripts 下有 8 个 py（含本轮新增 `scripts/persona_switch_check.py`）。建议先手动跑通 `scripts/*.py` 再决定是否上钩子。
4. **其它 >100 列属合理例外**：`scripts/lib/cdp.mjs:97`（102）、`:118`（103）、`:119`（110）是浏览器端表达式拼接（eslint 无 max-len）；`app/renderer/index.html:8` 与 `app/renderer/settings.html:7` 是 CSP meta（113 列，prettier 断不了）。建议把这两类写进 CODE_STYLE §1 的例外清单，免得每轮复评。
5. **prettier 覆盖 `json`**：因此 `characters/*/card.json` 会被自动格式化（本轮 `characters/momo/card.json` 就是被它改的）。新增角色包时要么先 `prettier --write`，要么接受它改。

## 5. 正向结论（有效的部分）

- **依赖方向干净**：core ← services ←（api / adapters）；contracts 只有数据与路由表、无业务；app 三层（main / preload / renderer）边界清楚，IPC 契约有 `tests/ipc-contract.test.ts` 对账。
- **注释与命名规范有效**：171 个源文件**全部含中文注释**（零 no-CJK 源文件）；TODO/FIXME 仅 3 处（`tests/test_logging.py`、`tests/test_memory_key.py`、`tests/test_memory_service.py`），无债务堆积。
- **门禁有效**：pre-commit 7 钩子（ruff check / ruff format / mypy 两趟 / .ps1 BOM / eslint / prettier / tsc）+ pytest 476 passed + vitest 14 文件 122 例，本轮 T2.3-A 改动全部通过。

## 6. 建议清单（可直接排期）

| 优先级 | 事项 | 理由 | 预估 |
| --- | --- | --- | --- |
| P1 | `tests/` 纳入 ruff 覆盖面并修完超限行 | 消除最大规范盲区，代价小 | 0.5 天 |
| P1 | 落地覆盖率门槛（脚本 + 钩子） | CODE_STYLE 已有要求但无人执行 | 0.5–1 天 |
| P2 | T2.3-B1 前先拆 `settings.ts`；抽 `chat_service.py` 的记忆部分 | 避免在最大文件上继续叠功能 | 0.5 天 |
| P3 | 主进程 `ipc-types.ts` 统一 re-export；测试夹具抽 helpers | 消掉 19 处重复窗口 | 0.5 天 |
| P3 | `scripts/` 纳入 mypy | 8 个脚本目前零类型检查 | 0.5 天 |
| P3 | 把 cdp.mjs / CSP 的 >100 列写进 CODE_STYLE 例外清单 | 免每轮复评 | 10 分钟 |

---

复现命令（在仓库根、Windows 侧）：

```powershell
# 行数排行（含分层汇总）
Get-ChildItem -Recurse -Include *.py,*.ts,*.mjs | Where-Object { $_.FullName -notmatch 'node_modules|\.venv|dist|__pycache__' } | ForEach-Object { [PSCustomObject]@{ Lines = (Get-Content $_.FullName).Count; Path = $_.FullName } } | Sort-Object Lines -Descending | Select-Object -First 25
# 覆盖率（当前未接入，手动跑法）
.venv\Scripts\python.exe -m pytest --cov=sidecar --cov-report=term-missing
```
