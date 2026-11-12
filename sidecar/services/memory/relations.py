"""文件职责：关系记忆：角色状态、关系卡、前瞻记忆（待办）与关系图谱。

依赖方向：services -> adapters / core / contracts；不 import api。
谁调用：services.memory.service 汇总成 MemoryService。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from core.character_state import CharacterState
from core.memory import (
    MemoryBackendError,
    MemoryDraft,
    MemoryIntention,
    MemoryQuery,
    MemoryRelation,
    MemoryStore,
    iso_time,
)

from .base import MemoryServiceBase


class RelationsMixin(MemoryServiceBase):
    """关系记忆：角色状态、关系卡、前瞻记忆（待办）与关系图谱。"""

    def record_facts(
        self,
        *,
        char_id: str,
        session_id: str,
        facts: Sequence[MemoryDraft],
        ts: float,
    ) -> list[int]:
        """写入 LLM 判定「值得长期记住」的事实（m 事件）；返回记忆 id（去重命中算同一条）。"""
        if self._store is None or not facts:
            return []
        ids: list[int] = []
        try:
            for fact in facts:
                body = fact.text.strip()
                if not body:
                    continue
                draft = replace(self._with_defaults(fact, char_id=char_id, ts=ts), text=body)
                memory_id, _created = self._store.upsert_memory(draft, now=ts)
                ids.append(memory_id)
        except MemoryBackendError as exc:
            self._degrade(exc, action="record_facts")
            return []
        return ids

    def load_character_state(
        self, char_id: str, *, seed_relationship: float = 0.5, now: float = 0.0
    ) -> CharacterState:
        """读取角色状态；库不可用或没有记录时用种子状态，绝不打断对话。"""
        store = self._store
        if store is None:
            return CharacterState.seed(char_id, relationship=seed_relationship, now=now)
        try:
            loaded = store.load_character_state(char_id)
        except MemoryBackendError as exc:
            self._degrade(exc, action="load_character_state")
            return CharacterState.seed(char_id, relationship=seed_relationship, now=now)
        if loaded is None:
            return CharacterState.seed(char_id, relationship=seed_relationship, now=now)
        return loaded.refresh(now) if now > 0 else loaded

    def save_character_state(self, state: CharacterState) -> None:
        """保存角色状态；失败只降级，状态是增强项。"""
        store = self._store
        if store is None:
            return
        try:
            store.save_character_state(state)
            self._sync_relation(store, state)
        except MemoryBackendError as exc:
            self._degrade(exc, action="save_character_state")

    def _sync_relation(self, store: MemoryStore, state: CharacterState) -> None:
        """把角色状态里的关系/未解事同步到关系记忆与前瞻记忆（T2.33）。

        手动在设置页填过的 trust / warmth 保留，只把 familiarity 跟着关系值走；
        未解事从 CharacterState.open_loops 投影过来，避免两套状态各说各话。
        """
        get_relation = getattr(store, "get_relation", None)
        save_relation = getattr(store, "save_relation", None)
        if not callable(get_relation) or not callable(save_relation):
            return
        existing = get_relation(state.char_id) or MemoryRelation(char_id=state.char_id)
        loops = [loop.text for loop in state.open_loops if loop.text.strip()]
        save_relation(
            replace(
                existing,
                familiarity=state.relationship,
                unresolved="；".join(loops) if loops else existing.unresolved,
                updated_at=state.updated_at,
            )
        )
        self._sync_intentions(store, state.char_id, loops, now=state.updated_at)

    def _sync_intentions(
        self, store: MemoryStore, char_id: str, loops: Sequence[str], *, now: float
    ) -> None:
        list_intentions = getattr(store, "list_intentions", None)
        add_intention = getattr(store, "add_intention", None)
        resolve = getattr(store, "resolve_intention", None)
        if not (callable(list_intentions) and callable(add_intention) and callable(resolve)):
            return
        wanted = {text.strip() for text in loops if text.strip()}
        existing = list_intentions(char_id, limit=100)
        current = {item.text for item in existing}
        for item in existing:
            if item.text not in wanted:
                resolve(item.intention_id, now=now)
        for text in wanted - current:
            add_intention(char_id=char_id, text=text, trigger_at=now + 2 * 3600.0, now=now)

    def get_relation(self, char_id: str) -> MemoryRelation:
        store = self._require_store()
        try:
            return store.get_relation(char_id) or MemoryRelation(char_id=char_id)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def save_relation(self, relation: MemoryRelation) -> None:
        store = self._require_store()
        try:
            store.save_relation(relation)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def record_intentions(self, *, char_id: str, texts: Sequence[str], now: float) -> list[int]:
        """把本轮 follow_up 收集成前瞻记忆；失败只降级。"""
        store = self._store
        if store is None or not texts:
            return []
        ids: list[int] = []
        try:
            existing = {item.text for item in store.list_intentions(char_id, limit=100)}
            for text in texts:
                body = text.strip()
                if not body or body in existing:
                    continue
                item = store.add_intention(
                    char_id=char_id, text=body, trigger_at=now + 2 * 3600.0, now=now
                )
                ids.append(item.intention_id)
                existing.add(body)
        except MemoryBackendError as exc:
            self._degrade(exc, action="record_intentions")
        return ids

    def add_intention(
        self, *, char_id: str, text: str, trigger_at: float = 0.0, now: float = 0.0
    ) -> MemoryIntention:
        store = self._require_store()
        try:
            return store.add_intention(char_id=char_id, text=text, trigger_at=trigger_at, now=now)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def resolve_intention(self, intention_id: int, *, now: float = 0.0) -> bool:
        store = self._require_store()
        try:
            return store.resolve_intention(intention_id, now=now)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def list_intentions(self, char_id: str, *, limit: int = 20) -> list[MemoryIntention]:
        store = self._require_store()
        try:
            return store.list_intentions(char_id, limit=limit)
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    def graph(self, char_id: str, *, limit: int = 40) -> dict[str, list[dict[str, object]]]:
        """记忆网络：时间桶 / 事实 / 日记作节点，period_sources 作边。"""
        store = self._require_store()
        try:
            periods = store.list_periods(char_id, limit=limit)
            memories = store.list_memories(MemoryQuery(char_id=char_id, limit=limit))
            diary = store.list_diary(char_id, limit=limit)
            nodes: dict[str, dict[str, object]] = {}
            for period in periods:
                node_id = "period:" + str(period.period_id)
                nodes[node_id] = {
                    "id": node_id,
                    "kind": "period",
                    "label": (period.label or period.day_key or period.level),
                    "summary": period.summary,
                    "level": period.level,
                }
            for memory in memories:
                node_id = "memory:" + str(memory.memory_id)
                nodes[node_id] = {
                    "id": node_id,
                    "kind": "memory",
                    "label": memory.kind,
                    "summary": memory.text,
                    "level": "",
                }
            for entry in diary:
                node_id = "diary:" + str(entry.entry_id)
                nodes[node_id] = {
                    "id": node_id,
                    "kind": "diary",
                    "label": (entry.occurred_at and iso_time(entry.occurred_at)) or "日记",
                    "summary": entry.text,
                    "level": "",
                }
            entities = store.list_entities(char_id, limit=limit)
            for entity in entities:
                node_id = "entity:" + str(entity.entity_id)
                nodes[node_id] = {
                    "id": node_id,
                    "kind": "entity",
                    "label": entity.name,
                    "summary": entity.kind,
                    "level": entity.kind,
                }
            edges: list[dict[str, object]] = []
            for period in periods:
                source_id = "period:" + str(period.period_id)
                for source_type, target_id in store.period_sources(period.period_id):
                    target = source_type + ":" + str(target_id)
                    if target in nodes and target != source_id:
                        edges.append(
                            {"source": source_id, "target": target, "relation": "contains"}
                        )
            for link in store.list_links(char_id, limit=limit * 4):
                source = link.from_type + ":" + str(link.from_id)
                target = link.to_type + ":" + str(link.to_id)
                if source in nodes and target in nodes:
                    edges.append({"source": source, "target": target, "relation": link.relation})
            return {"nodes": list(nodes.values()), "edges": edges}
        except MemoryBackendError as exc:
            raise self._domain_error(exc) from exc

    async def rebuild_graph(self, char_id: str, *, now: float = 0.0) -> dict[str, int]:
        graph = self._graph
        rebuild = getattr(graph, "rebuild", None)
        if not callable(rebuild):
            return {}
        result = await rebuild(char_id, now=now or self._now())
        return dict(result) if isinstance(result, dict) else {}
