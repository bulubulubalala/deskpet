"""文件职责：角色包与人格切换的验收脚本——三只人格装得进、切得动、记忆不串（方案 §2.2）。

五条判据（docs/PLAN.md 的 T2.3 行）：
1. 人格生效（离线）：三份提示词各带自己的 display_name 与风格标记，且不混入另两只；
2. 记忆隔离（离线）：给 amber 记下的事实，在 snow 的召回里不出现，切回 amber 又在；
3. 切换留痕（离线）：同一会话中途换角色，switch_log 有 from→to，char_usage 按角色分开计数；
4. 观察派生（离线）：同角色会话 / 打断样本够了以后，refresh 能派生出 kind=action 的观察；
5. 风格可分（--live 才有）：同一个问题问三只，打印三份回复供人眼比对。

依赖方向：scripts -> sidecar（把自己加进 sys.path）；默认 offline 不出网，加 --live 才用真实端点。

调用方式：
    .venv/Scripts/python.exe scripts/persona_switch_check.py
    .venv/Scripts/python.exe scripts/persona_switch_check.py --live --keep

退出码：0 = 判据 1–4（离线）/ 1–5（live）全过；1 = 有失败。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import shutil
import sqlite3
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path

#: 控制台默认是 GBK，结果里的 ✓/✗ 会直接炸掉；统一把标准输出按 UTF-8 编码。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "sidecar"
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from adapters.usage_sqlite import UsageStatsReader  # noqa: E402
from config import Settings, load_settings  # noqa: E402
from contracts.api_models import ChatStreamRequest  # noqa: E402
from contracts.events import ErrorEvent, SentenceEvent  # noqa: E402
from core.memory import MemoryDraft, MemoryQuery, RecallContext  # noqa: E402
from core.prompt import build_system_prompt  # noqa: E402
from services.behavior_memory_service import build_behavior_memory_service  # noqa: E402
from services.character_store import load_character_pack  # noqa: E402
from services.chat_service import build_chat_service  # noqa: E402
from services.memory_service import build_memory_service  # noqa: E402
from services.usage_service import build_usage_service  # noqa: E402

#: 三只示例人格；amber 是已有的，snow / momo 由 T2.3 从 hermes 人设导入。
CHAR_IDS = ("amber", "snow", "momo")
#: 判据 1 的判别依据：每只 speaking_style 里独有的一句，必须只出现在自己那份提示词里。
STYLE_MARKERS = {
    "amber": "知道了知道了",
    "snow": "反问代替正面回答",
    "momo": "能一个字说完的不用两个字",
}
#: 判据 2 用的事实：只有 amber 该记得。
FACT_CHAR = "amber"
FACT_TEXT = "我上个月把吉他的弦换成了蓝色那套。"
FACT_NEEDLE = "蓝色那套"
#: 判据 5 的同一句提问。
LIVE_QUESTION = "我今天有点累。"
#: 固定时间基准：判据要可复现，不用真实时钟。
NOW = 1_760_000_000.0


@dataclass
class CheckResult:
    """一条验收判据的结果；detail 要写清「凭什么这么判」。"""

    name: str
    ok: bool
    detail: str


def read_env_file(path: Path) -> int:
    """把仓库根的 .env 读进 os.environ（不覆盖已存在的变量）；返回读到的条数。"""
    if not path.is_file():
        return 0
    count = 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()
            count += 1
    return count


def build_settings(data_dir: Path, *, live: bool) -> Settings:
    """离线用默认 Settings（不读 .env），live 才读真实端点配置。"""
    base = load_settings() if live else Settings()
    return replace(base, data_dir=data_dir, characters_dir=REPO_ROOT / "characters")


def close_memory(memory) -> None:
    """关掉加密库连接，模拟「关掉程序」。"""
    store = memory.store
    if store is not None:
        store.close()


def _fact_texts(context: RecallContext) -> list[str]:
    """召回上下文里的 L0 事实文本（判据 2 只看这一层）。"""
    return [fact.text for fact in context.facts]


def check_persona_prompts() -> CheckResult:
    """判据 1：三份提示词各自带自己的风格标记，且互不混入。"""
    missing: list[str] = []
    leaks: list[str] = []
    sizes: list[str] = []
    for char_id in CHAR_IDS:
        pack = load_character_pack(REPO_ROOT / "characters" / char_id)
        prompt = build_system_prompt(pack.card)
        marker = STYLE_MARKERS[char_id]
        if pack.card.display_name not in prompt:
            missing.append(char_id + " 缺 display_name")
        if marker not in prompt:
            missing.append(char_id + " 缺风格标记「" + marker + "」")
        for other in CHAR_IDS:
            if other != char_id and STYLE_MARKERS[other] in prompt:
                leaks.append(char_id + " 混进了 " + other + " 的风格标记")
        sizes.append(char_id + "=" + str(len(prompt)) + " 字")
    ok = not missing and not leaks
    if ok:
        detail = "三份提示词各带自己的标记、互不混入（" + "、".join(sizes) + "）"
    else:
        detail = "；".join(missing + leaks)
    return CheckResult("判据 1 人格生效", ok, detail)


def check_memory_isolation(settings: Settings) -> CheckResult:
    """判据 2：同一件事只被自己的角色召回到。"""
    name = "判据 2 记忆隔离"
    memory = build_memory_service(settings)
    if not memory.available:
        return CheckResult(name, False, "记忆库没打开（密钥或目录问题）")
    try:
        draft = MemoryDraft(
            char_id=FACT_CHAR, kind="fact", text=FACT_TEXT, importance=0.7, source="user"
        )
        memory.record_facts(char_id=FACT_CHAR, session_id="iso", facts=[draft], ts=NOW)
        amber = memory.recall(char_id=FACT_CHAR, query=FACT_NEEDLE, now=NOW)
        snow = memory.recall(char_id="snow", query=FACT_NEEDLE, now=NOW)
        back = memory.recall(char_id=FACT_CHAR, query=FACT_NEEDLE, now=NOW)
    finally:
        close_memory(memory)
    hit = any(FACT_NEEDLE in text for text in _fact_texts(amber))
    leaked = any(FACT_NEEDLE in text for text in _fact_texts(snow))
    again = any(FACT_NEEDLE in text for text in _fact_texts(back))
    ok = hit and not leaked and again
    detail = (
        "amber 命中 " + str(hit) + "；snow 串库 " + str(leaked) + "；切回 amber 命中 " + str(again)
    )
    return CheckResult(name, ok, detail)


def check_switch_trace(settings: Settings) -> CheckResult:
    """判据 3：中途换角色要留痕，且分角色计数。"""
    name = "判据 3 切换留痕"
    usage = build_usage_service(settings)
    usage.record_turn("switch-1", "amber", voice=False, at=NOW)
    usage.record_turn("switch-1", "snow", voice=False, at=NOW + 10)
    usage.record_turn("switch-1", "snow", voice=False, at=NOW + 20)
    asyncio.run(usage.flush(close_all=True))
    with contextlib.closing(sqlite3.connect(settings.usage_db_file)) as conn:
        switches = conn.execute(
            "SELECT from_char_id, to_char_id FROM switch_log ORDER BY id"
        ).fetchall()
        per_char = conn.execute(
            "SELECT char_id, session_count FROM char_usage ORDER BY char_id"
        ).fetchall()
    expect = [("amber", "snow")]
    chars = [row[0] for row in per_char]
    ok = switches == expect and "amber" in chars and "snow" in chars
    detail = "switch_log=" + repr(switches) + "；char_usage=" + repr(per_char)
    return CheckResult(name, ok, detail)


def check_observation(settings: Settings) -> CheckResult:
    """判据 4：样本够了以后能派生出 kind=action 的观察。"""
    name = "判据 4 观察派生"
    usage = build_usage_service(settings)
    for index in range(4):
        session = "obs-snow-" + str(index)
        usage.record_turn(session, "snow", voice=False, at=NOW + index * 3600)
        if index < 3:
            usage.record_interrupt(session, at=NOW + index * 3600 + 5)
    usage.record_turn("obs-amber", "amber", voice=False, at=NOW + 60)
    asyncio.run(usage.flush(close_all=True))
    memory = build_memory_service(settings)
    if not memory.available:
        return CheckResult(name, False, "记忆库没打开")
    try:
        reader = UsageStatsReader(settings.usage_db_file)
        behavior = build_behavior_memory_service(settings, memory, reader=reader)
        ids = behavior.refresh("snow")
        rows = memory.list_memories(MemoryQuery(char_id="snow", kind="action", limit=50))
        texts = [row.text for row in rows]
    finally:
        close_memory(memory)
    has_interrupt = any("打断" in text for text in texts)
    ok = len(ids) > 0 and has_interrupt
    detail = "写入 / 命中 " + str(len(ids)) + " 条：" + "；".join(texts)
    return CheckResult(name, ok, detail)


async def ask_three(settings: Settings) -> tuple[dict[str, str], list[str]]:
    """判据 5：同一句话问三只，各自出一份回复；顺带收回错误事件里的人话提示。"""
    chat = build_chat_service(settings)
    replies: dict[str, str] = {}
    errors: list[str] = []
    for char_id in CHAR_IDS:
        request = ChatStreamRequest(
            session_id="style-" + char_id, char_id=char_id, text=LIVE_QUESTION
        )
        parts: list[str] = []
        async for event in chat.stream_events(request):
            if isinstance(event, SentenceEvent):
                parts.append(event.text)
            elif isinstance(event, ErrorEvent):
                errors.append(char_id + "：" + event.user_hint)
        replies[char_id] = "".join(parts)
    return replies, errors


def main(argv: Sequence[str] | None = None) -> int:
    """跑四条离线判据（加 --live 再跑判据 5），打印结果表。"""
    parser = argparse.ArgumentParser(description="角色导入与换人感知的验收脚本")
    parser.add_argument(
        "--live", action="store_true", help="用 .env 的真实端点跑判据 5（会真的调模型）"
    )
    parser.add_argument("--data-dir", default="", help="复用指定数据目录；默认为临时目录")
    parser.add_argument("--keep", action="store_true", help="跑完保留临时数据目录")
    args = parser.parse_args(argv)
    if args.data_dir:
        data_dir = Path(args.data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        temporary = False
    else:
        data_dir = Path(tempfile.mkdtemp(prefix="deskpet-personas-"))
        temporary = True
    loaded = read_env_file(REPO_ROOT / ".env") if args.live else 0
    settings = build_settings(data_dir, live=args.live)
    mode = "（live）" if args.live else "（offline 替身模型）"
    print("数据目录：" + str(data_dir) + mode)
    if args.live:
        print("从 .env 读到 " + str(loaded) + " 个配置键")
    results = [
        check_persona_prompts(),
        check_memory_isolation(settings),
        check_switch_trace(settings),
        check_observation(settings),
    ]
    if args.live:
        replies, errors = asyncio.run(ask_three(settings))
        ok = all(text.strip() for text in replies.values())
        detail = "三只都回了话，请人眼比对风格" if ok else "有人没回话；" + "；".join(errors)
        results.append(CheckResult("判据 5 风格可分", ok, detail))
        head = "：通过（有回复）" if ok else "：失败（有角色没回话）"
        print("判据 5 风格可分（人工看）" + head)
        for char_id in CHAR_IDS:
            print("  " + char_id + "｜" + replies[char_id])
    else:
        print("判据 5 风格可分：跳过（加 --live 才会真的问模型）")
    print("")
    for result in results:
        mark = "✓ " if result.ok else "✗ "
        print(mark + result.name + " — " + result.detail)
    failed = [result for result in results if not result.ok]
    print("")
    print("结果：" + str(len(results) - len(failed)) + "/" + str(len(results)) + " 通过")
    if temporary and not args.keep:
        shutil.rmtree(data_dir, ignore_errors=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
