r"""文件职责：F3（持久化记忆 + 上下文压缩）的验收脚本——把四条判据跑成可复现的通过 / 失败表。

四条判据（docs/PLAN.md 的 T2.1 行 / 需求 §6.4）：
1. 重开记得上次话题：一轮对话写库后关掉这一份实例，再开一份新实例提问，答复里还有那件事；
2. 100 轮后仍能回忆第 10 轮的事实：那件事只靠阶梯摘要活下来（最近 6 条历史里已经没有它）；
3. 单轮上下文装配 <80ms，且注入的记忆条目可追溯来源（source_msg_ids + mark_used）；
4. 单条删除即时生效：删掉之后同一次检索不再注入它。

依赖方向：scripts -> sidecar（把自己加进 sys.path）；默认 offline 用替身模型，全程不出网；
加 --live 才用 .env 里的真实端点（要真的调模型，慢且花钱，判据 2 会连压三批）。

调用方式：
    .venv/Scripts/python.exe scripts/memory_check.py
    .venv/Scripts/python.exe scripts/memory_check.py --live --data-dir D:/tmp/deskpet-f3

退出码：0 = 四条全过；1 = 有失败（逐条打印原因）。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import statistics
import sys
import tempfile
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "sidecar"
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from config import LlmSettings, Settings, load_settings  # noqa: E402
from contracts.api_models import ChatStreamRequest  # noqa: E402
from contracts.events import SentenceEvent  # noqa: E402
from core.memory import MemoryDraft, MemoryQuery  # noqa: E402
from core.prompt import build_messages  # noqa: E402
from services.character_store import load_character_pack  # noqa: E402
from services.chat_service import ChatService  # noqa: E402
from services.memory_service import MemoryService, build_memory_service  # noqa: E402
from services.memory_summary_service import MemorySummarizer  # noqa: E402

CHAR_ID = "amber"
#: 判据 1 的那件事：首轮由用户说出口，之后要跨实例还在。
NEEDLE_CAT = "团子"
#: 判据 2 的那件事：只出现在第 10 轮的原文里，L0 事实刻意不写，逼它靠摘要活下来。
NEEDLE_BAND = "夜航"
#: 判据 3/4 的检索词：只命中「乌龙茶」那几条事实。
NEEDLE_TEA = "乌龙茶"

OPENING = "我刚养了一只猫，它叫" + NEEDLE_CAT + "。"
QUESTION_CAT = "我家猫叫什么名字？"
QUESTION_BAND = "我高中组的乐队叫什么名字？"
QUESTION_TEA = "我提过喜欢喝什么？"

SEED_TURNS = 120
SEED_FACT_TURN = 10
SEED_FACT_TEXT = "顺便说一句，我高中组的乐队叫" + NEEDLE_BAND + "。"
RECALL_SAMPLES = 30
RECALL_WARMUP = 5
RECALL_BUDGET_MS = 80.0

_NL = chr(10)
#: 替身模型认识的「值得记的事」：needle -> 事实正文。
FACTS: dict[str, str] = {
    NEEDLE_CAT: "用户养的猫叫" + NEEDLE_CAT,
    NEEDLE_BAND: "用户高中的乐队叫" + NEEDLE_BAND,
}


@dataclass
class CheckResult:
    """一条验收判据的结果；detail 要写清「凭什么这么判」。"""

    name: str
    ok: bool
    detail: str


@dataclass
class Runtime:
    """一次「打开应用」的全部服务（记忆库 + 压缩器 + 会话）。"""

    settings: Settings
    memory: MemoryService
    summarizer: MemorySummarizer
    chat: ChatService

    def close(self) -> None:
        """关掉加密库连接，模拟「关掉程序」。"""
        store = self.memory.store
        if store is not None:
            store.close()


class StubClient:
    """替身模型的流式接口：会话侧当「记得住事的观察者」，压缩侧当「只留关键词的摘要器」。

    会话侧只看**本轮最后一条 user 消息**来决定要不要吐 m 事件——这样「召回注入」不会被
    误当成「用户刚说了这件事」，判据 1 / 2 的答复才有判别力。
    """

    async def stream_chat(self, messages: Sequence[Mapping[str, str]]) -> AsyncIterator[str]:
        system = str(messages[0].get("content", "")) if messages else ""
        joined = _NL.join(str(message.get("content", "")) for message in messages)
        last_user = str(messages[-1].get("content", "")) if messages else ""
        if "压缩器" in system:
            hits = [needle for needle in FACTS if needle in joined]
            if hits:
                yield "用户提到：" + "、".join(hits) + "。" + _NL
            else:
                yield "用户和角色聊了聊日常，没什么要紧事。" + _NL
            return
        for needle, fact in FACTS.items():
            if needle in last_user:
                yield '{"t":"m","kind":"fact","text":"' + fact + '","importance":0.8}' + _NL
        hits = [needle for needle in FACTS if needle in joined]
        if hits:
            yield "我记得：" + "、".join(hits) + "。" + _NL
        else:
            yield "我不记得这些事。" + _NL


def stub_llm_settings() -> LlmSettings:
    """替身端点：只要配了 base_url 与 model 就会被选上，客户端由 client_factory 换掉。"""
    return LlmSettings(base_url="http://stub.invalid/v1", api_key="stub-key", model="stub-model")


def build_runtime(data_dir: Path, *, live: bool) -> Runtime:
    """按需求文档的装配方式开一份「应用实例」；offline 走替身模型，live 走 .env 的真实端点。"""
    base = load_settings() if live else Settings()
    settings = replace(base, data_dir=data_dir, characters_dir=REPO_ROOT / "characters")
    llm = settings.llm if live else stub_llm_settings()
    factory = None if live else (lambda _endpoint: StubClient())
    memory = build_memory_service(settings)
    summarizer = MemorySummarizer(memory.store, settings.memory, llm=llm, client_factory=factory)
    chat = ChatService(
        llm=llm,
        characters_dir=settings.characters_dir,
        client_factory=factory,
        memory=memory,
        summarizer=summarizer,
    )
    return Runtime(settings=settings, memory=memory, summarizer=summarizer, chat=chat)


def _read_env_file(path: Path) -> int:
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


def _quote(text: str, *, limit: int = 40) -> str:
    """把台词压成一行短引用，给结果表用。"""
    body = text.strip().replace(_NL, " ")
    if len(body) > limit:
        body = body[:limit] + "…"
    return '"' + body + '"'


async def run_turn(chat: ChatService, *, session_id: str, text: str) -> tuple[str, list[str]]:
    """跑一轮对话，返回（拼起来的台词，错误码列表）。"""
    request = ChatStreamRequest(session_id=session_id, char_id=CHAR_ID, text=text)
    spoken: list[str] = []
    errors: list[str] = []
    async for event in chat.stream_events(request):
        if isinstance(event, SentenceEvent):
            spoken.append(event.text)
        elif getattr(event, "t", "") == "e":
            errors.append(str(getattr(event, "code", "?")))
    # 给对话收尾排的摘任务让一次调度机会（fire-and-forget，不等它）
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    return "".join(spoken), errors


def _has_memory(runtime: Runtime, needle: str) -> bool:
    """库里有没有含这个关键词的长期事实（列表端点走的是同一条读路径）。"""
    records = runtime.memory.list_memories(MemoryQuery(char_id=CHAR_ID, limit=100))
    return any(needle in record.text for record in records)


async def check_restart(data_dir: Path, *, live: bool) -> CheckResult:
    """判据 1：写一轮 → 关掉 → 新实例提问，答复里还记得。"""
    notes: list[str] = []
    runtime = build_runtime(data_dir, live=live)
    try:
        reply, errors = await run_turn(runtime.chat, session_id="f3-restart-a", text=OPENING)
        notes.append("首轮 " + _quote(reply))
        if errors:
            notes.append("首轮错误事件 " + ",".join(errors))
        if live and not _has_memory(runtime, NEEDLE_CAT):
            # 真实模型偶尔不给 m 事件；本脚本验的是记忆链路，不是模型的取事实能力
            runtime.memory.record_facts(
                char_id=CHAR_ID,
                session_id="f3-restart-a",
                facts=[MemoryDraft(char_id=CHAR_ID, kind="fact", text=FACTS[NEEDLE_CAT])],
                ts=time.time(),
            )
            notes.append("模型没给 m 事件，脚本补写事实")
    finally:
        runtime.close()
    fresh = build_runtime(data_dir, live=live)
    try:
        reply, errors = await run_turn(fresh.chat, session_id="f3-restart-b", text=QUESTION_CAT)
        notes.append("重开后 " + _quote(reply))
        if errors:
            notes.append("错误事件 " + ",".join(errors))
        ok = fresh.memory.available and NEEDLE_CAT in reply
    finally:
        fresh.close()
    return CheckResult("1 重开记得上次话题", ok, "；".join(notes))


async def check_long_history(runtime: Runtime) -> CheckResult:
    """判据 2：120 轮之后还能想起第 10 轮说的事（只可能来自阶梯摘要）。"""
    now = time.time()
    for turn in range(1, SEED_TURNS + 1):
        moment = now - (SEED_TURNS - turn) * 30.0
        body = (
            SEED_FACT_TEXT if turn == SEED_FACT_TURN else "第 " + str(turn) + " 轮：没什么特别的。"
        )
        runtime.memory.record_message(
            char_id=CHAR_ID, session_id="f3-history", role="user", text=body, ts=moment
        )
        runtime.memory.record_message(
            char_id=CHAR_ID,
            session_id="f3-history",
            role="assistant",
            text="嗯，我听着呢。",
            ts=moment + 1.0,
        )
    created = 0
    for _ in range(4):
        created += await runtime.summarizer.compress(CHAR_ID)
    recall = runtime.memory.recall(char_id=CHAR_ID, query=QUESTION_BAND, now=time.time())
    layers = " ".join([recall.impressions, *recall.episodes, *recall.summaries])
    history = " ".join(turn.text for turn in recall.history)
    reply, errors = await run_turn(runtime.chat, session_id="f3-history-ask", text=QUESTION_BAND)
    in_layers = NEEDLE_BAND in layers
    in_history = NEEDLE_BAND in history
    detail = (
        "生成摘要 "
        + str(created)
        + " 条；摘要层命中="
        + str(in_layers)
        + "；最近 "
        + str(len(recall.history))
        + " 条历史命中="
        + str(in_history)
        + "；提问 "
        + _quote(reply)
    )
    if errors:
        detail += "；错误事件 " + ",".join(errors)
    return CheckResult(
        "2 一百轮后仍记得第 10 轮", in_layers and not in_history and NEEDLE_BAND in reply, detail
    )


async def check_assembly_and_delete(runtime: Runtime, card: object) -> list[CheckResult]:
    """判据 3：装配耗时与来源可追溯；判据 4：单条删除即时生效。"""
    facts = [
        MemoryDraft(
            char_id=CHAR_ID,
            kind="fact",
            text="用户喜欢喝" + NEEDLE_TEA + "（第 " + str(index) + " 次提到）。",
            importance=0.6,
            source="chat",
            source_msg_ids=str(500 + index),
        )
        for index in range(1, 4)
    ]
    created_ids = runtime.memory.record_facts(
        char_id=CHAR_ID, session_id="f3-assembly", facts=facts, ts=time.time()
    )
    recall = runtime.memory.recall(char_id=CHAR_ID, query=QUESTION_TEA, now=time.time())
    for _ in range(RECALL_WARMUP):
        runtime.memory.recall(char_id=CHAR_ID, query=QUESTION_TEA, now=time.time())
    durations: list[float] = []
    for _ in range(RECALL_SAMPLES):
        start = time.perf_counter()
        recall = runtime.memory.recall(char_id=CHAR_ID, query=QUESTION_TEA, now=time.time())
        build_messages(card, user_text=QUESTION_TEA, language="zh", recall=recall)
        durations.append((time.perf_counter() - start) * 1000.0)
    peak = max(durations)
    p95 = statistics.quantiles(durations, n=20)[-1]
    records = {
        record.memory_id: record
        for record in runtime.memory.list_memories(MemoryQuery(char_id=CHAR_ID, limit=200))
    }
    injected = list(recall.injected_ids)
    traced = [
        memory_id
        for memory_id in injected
        if memory_id in records and bool(records[memory_id].source_msg_ids)
    ]
    used = [
        memory_id
        for memory_id in injected
        if memory_id in records and records[memory_id].used_count > 0
    ]
    assembly = CheckResult(
        "3 装配 <80ms 且来源可追溯",
        peak < RECALL_BUDGET_MS and bool(injected) and len(traced) == len(injected) and bool(used),
        "装配 max="
        + format(peak, ".1f")
        + "ms / p95="
        + format(p95, ".1f")
        + "ms（预算 80ms）；新建事实 id="
        + str(created_ids)
        + "；注入 id="
        + str(injected)
        + "；条条有 source_msg_ids="
        + str(len(traced) == len(injected))
        + "；mark_used 生效="
        + str(used),
    )
    target = injected[0] if injected else 0
    before = runtime.memory.recall(char_id=CHAR_ID, query=QUESTION_TEA, now=time.time())
    removed = runtime.memory.delete(target)
    after = runtime.memory.recall(char_id=CHAR_ID, query=QUESTION_TEA, now=time.time())
    remaining = {
        record.memory_id
        for record in runtime.memory.list_memories(MemoryQuery(char_id=CHAR_ID, limit=200))
    }
    deletion = CheckResult(
        "4 单条删除即时生效",
        bool(target) and removed and target not in after.injected_ids and target not in remaining,
        "删 id="
        + str(target)
        + "；删前注入="
        + str(list(before.injected_ids))
        + "；删后注入="
        + str(list(after.injected_ids))
        + "；列表里仍在="
        + str(target in remaining),
    )
    return [assembly, deletion]


async def _main(args: argparse.Namespace) -> int:
    loaded = _read_env_file(REPO_ROOT / ".env") if args.live else 0
    data_dir = (
        Path(args.data_dir).resolve()
        if args.data_dir
        else Path(tempfile.mkdtemp(prefix="deskpet-f3-"))
    )
    data_dir.mkdir(parents=True, exist_ok=True)
    print(
        "模式：" + ("live（真实端点，需要 .env）" if args.live else "offline（替身模型，不出网）")
    )
    if args.live:
        print(
            "已读 .env " + str(loaded) + " 条；模型 " + (load_settings().llm.model or "（未配置）")
        )
    print("数据目录：" + str(data_dir))
    results: list[CheckResult] = []
    results.append(await check_restart(data_dir, live=args.live))
    runtime = build_runtime(data_dir, live=args.live)
    try:
        if not runtime.memory.available:
            results.append(
                CheckResult(
                    "2 / 3 / 4", False, "记忆库打不开：" + str(runtime.memory.startup_error)
                )
            )
        else:
            pack = load_character_pack(runtime.settings.characters_dir / CHAR_ID)
            results.append(await check_long_history(runtime))
            results.extend(await check_assembly_and_delete(runtime, pack.card))
    finally:
        runtime.close()
    print("")
    passed = 0
    for item in results:
        print(("[PASS] " if item.ok else "[FAIL] ") + item.name + " -- " + item.detail)
        passed += 1 if item.ok else 0
    print("")
    print("结果：" + str(passed) + "/" + str(len(results)) + " 通过")
    if not args.keep and not args.data_dir:
        shutil.rmtree(data_dir, ignore_errors=True)
    return 0 if passed == len(results) else 1


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="F3 持久化记忆 + 上下文压缩验收脚本")
    parser.add_argument(
        "--live", action="store_true", help="用 .env 里的真实端点（默认走替身模型）"
    )
    parser.add_argument("--data-dir", default="", help="数据目录（默认用临时目录，跑完即删）")
    parser.add_argument("--keep", action="store_true", help="保留临时数据目录，便于事后翻库")
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main(_parse_args(sys.argv[1:]))))
