"""文件职责：记忆知识图谱的实体 / 关系抽取（T2.37）。

把最近的事实、日记与时间桶交给模型，要求它只输出 JSON；解析后写入
`memory_entities` / `memory_links`。失败只记日志，不阻塞对话。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable, Sequence
from typing import Any

from adapters.llm_openai import LlmEndpoint, OpenAiChatClient
from config import LlmSettings, MemorySettings, Settings
from core.logging import get_logger, log_event
from core.memory import MemoryBackendError, MemoryQuery, MemoryStore
from core.prompt import wrap_untrusted
from services.llm_ports import ClientFactory

LOGGER = get_logger("services.memory_graph_service")

MAX_OUTPUT_CHARS = 5000
MAX_INPUT_ITEMS = 60

_SYSTEM = (
    "你是记忆知识图谱抽取器。输入是带 id 的记忆条目。"
    "只抽原文有依据的内容，不要编造。只输出 JSON，不要代码块，不要解释。"
    '格式：{"entities":[{"name":"实体名","kind":"person|place|topic|thing|event",'
    '"aliases":""}],"mentions":[{"source":"memory:12","entities":["实体名"]}],'
    '"relations":[{"from":"实体名","to":"实体名","relation":"关系"}]}'
    "实体名用原文里的短名词；没有就返回空数组。"
)


class MemoryGraphService:
    def __init__(
        self,
        store: MemoryStore | None,
        settings: MemorySettings,
        *,
        llm: LlmSettings,
        client_factory: ClientFactory | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._store = store
        self._settings = settings
        self._llm = llm
        self._client_factory = client_factory or self._build_client
        self._now = now or time.time
        self._running: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def available(self) -> bool:
        return bool(self._store is not None and self._settings.timeline_enabled)

    def _build_client(self, endpoint: LlmEndpoint) -> OpenAiChatClient:
        return OpenAiChatClient(endpoint, timeout_s=self._llm.total_timeout_s)

    def schedule(self, char_id: str) -> None:
        if not self.available or not char_id or char_id in self._running:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._running.add(char_id)
        task = loop.create_task(self._guarded(char_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _guarded(self, char_id: str) -> None:
        try:
            await self.rebuild(char_id)
        finally:
            self._running.discard(char_id)

    async def rebuild(self, char_id: str, *, now: float | None = None) -> dict[str, int]:
        if not self.available:
            return {"entities": 0, "links": 0}
        store = self._store
        if store is None:
            return {"entities": 0, "links": 0}
        try:
            items = self._collect(store, char_id)
            if not items:
                return {"entities": 0, "links": 0}
            raw = await self._complete(_render_items(items))
            parsed = _parse_json(raw)
            if parsed is None:
                return {"entities": 0, "links": 0}
            entities = _entities_of(parsed)
            mentions = _mentions_of(parsed)
            relations = _relations_of(parsed)
            if not entities:
                return {"entities": 0, "links": 0}
            moment = float(now or self._now())
            store.clear_graph(char_id)
            ids: dict[str, int] = {}
            for name, kind, aliases in entities:
                ids[name] = store.upsert_entity(
                    char_id=char_id, name=name, kind=kind, aliases=aliases, now=moment
                )
            links = 0
            for source, names in mentions:
                source_type, source_id = _parse_source(source)
                if not source_type or source_id <= 0:
                    continue
                for name in names:
                    entity_id = ids.get(name)
                    if entity_id:
                        store.upsert_link(
                            char_id=char_id,
                            from_type=source_type,
                            from_id=source_id,
                            to_type="entity",
                            to_id=entity_id,
                            relation="mentions",
                            confidence=0.75,
                            now=moment,
                        )
                        links += 1
            for source_name, target_name, relation in relations:
                entity_from = ids.get(source_name)
                entity_to = ids.get(target_name)
                if entity_from and entity_to and relation:
                    store.upsert_link(
                        char_id=char_id,
                        from_type="entity",
                        from_id=entity_from,
                        to_type="entity",
                        to_id=entity_to,
                        relation=relation,
                        confidence=0.6,
                        now=moment,
                    )
                    links += 1
            return {"entities": len(ids), "links": links}
        except MemoryBackendError as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_graph_service",
                event="memory.graph_failed",
                message="记忆图谱写库失败",
                fields={"char_id": char_id, "error": str(exc)},
            )
            return {"entities": 0, "links": 0}
        except Exception as exc:
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.memory_graph_service",
                event="memory.graph_failed",
                message="记忆图谱抽取失败",
                fields={"char_id": char_id, "error": str(exc)},
            )
            return {"entities": 0, "links": 0}

    def _collect(self, store: MemoryStore, char_id: str) -> list[tuple[str, str]]:
        items: list[tuple[str, str]] = []
        memories = store.list_memories(MemoryQuery(char_id=char_id, limit=30))
        for memory in memories:
            items.append(("memory:" + str(memory.memory_id), memory.text))
        for entry in store.list_diary(char_id, limit=15):
            items.append(("diary:" + str(entry.entry_id), entry.text))
        for period in store.list_periods(char_id, limit=15):
            items.append(("period:" + str(period.period_id), period.summary))
        return items[:MAX_INPUT_ITEMS]

    async def _complete(self, user: str) -> str:
        specs = self._llm.endpoint_specs()
        if not specs:
            return ""
        url, api_key, model, _label = specs[0]
        client = self._client_factory(
            LlmEndpoint(
                base_url=url,
                api_key=api_key,
                model=model,
                preset=getattr(self._llm, "preset", ""),
            )
        )
        chunks: list[str] = []
        total = 0
        try:
            async for delta in client.stream_chat(
                [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}]
            ):
                chunks.append(delta)
                total += len(delta)
                if total >= MAX_OUTPUT_CHARS:
                    break
        except Exception:
            return ""
        return "".join(chunks).strip()

    async def run_forever(self) -> None:
        while True:
            if self.available and self._store is not None:
                lister = getattr(self._store, "list_character_ids", None)
                if callable(lister):
                    for char_id in lister():
                        if char_id not in self._running:
                            self._running.add(char_id)
                            try:
                                await self.rebuild(char_id)
                            except Exception:
                                pass
                            finally:
                                self._running.discard(char_id)
            await asyncio.sleep(max(300.0, self._settings.timeline_interval_s))


def _render_items(items: Sequence[tuple[str, str]]) -> str:
    body = "\n".join(f"- id={item_id} text={text}" for item_id, text in items)
    return "从下面记忆条目抽实体与关系：\n" + wrap_untrusted(body, what="记忆条目")


def _parse_json(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced is not None:
        text = fenced.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _entities_of(parsed: dict[str, Any]) -> list[tuple[str, str, str]]:
    result: list[tuple[str, str, str]] = []
    raw = parsed.get("entities")
    if not isinstance(raw, list):
        return result
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = " ".join(str(item.get("name", "")).split())
        if not name:
            continue
        kind = str(item.get("kind", "topic")) or "topic"
        aliases = str(item.get("aliases", ""))
        result.append((name, kind, aliases))
    return result


def _mentions_of(parsed: dict[str, Any]) -> list[tuple[str, list[str]]]:
    result: list[tuple[str, list[str]]] = []
    raw = parsed.get("mentions")
    if not isinstance(raw, list):
        return result
    for item in raw:
        if not isinstance(item, dict):
            continue
        source = str(item.get("source", ""))
        names = [
            str(name).strip()
            for name in item.get("entities", [])
            if isinstance(name, str) and name.strip()
        ]
        if source and names:
            result.append((source, names))
    return result


def _relations_of(parsed: dict[str, Any]) -> list[tuple[str, str, str]]:
    result: list[tuple[str, str, str]] = []
    raw = parsed.get("relations")
    if not isinstance(raw, list):
        return result
    for item in raw:
        if not isinstance(item, dict):
            continue
        source = str(item.get("from", "")).strip()
        target = str(item.get("to", "")).strip()
        relation = str(item.get("relation", "")).strip()
        if source and target and relation:
            result.append((source, target, relation))
    return result


def _parse_source(source: str) -> tuple[str, int]:
    kind, _, raw_id = source.partition(":")
    if kind not in {"memory", "diary", "period"}:
        return "", 0
    try:
        return kind, int(raw_id)
    except ValueError:
        return "", 0


def build_memory_graph_service(settings: Settings, store: MemoryStore | None) -> MemoryGraphService:
    return MemoryGraphService(store, settings.memory, llm=settings.llm)
