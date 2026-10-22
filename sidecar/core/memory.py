"""文件职责：记忆系统的纯数据与纯函数（需求 §6.4 四层阶梯 / F3）。

依赖方向：只依赖标准库；不碰磁盘、不 import adapters、不 import contracts。
谁调用：adapters.memory_sqlite 实现 MemoryStore 协议；services.memory_service 负责组装；
core.prompt 只取这里的数据类型与预算常量来装配一轮上下文。
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol

#: 记忆种类（与 contracts.events.MemoryEvent / contracts.api_models.MemoryWriteRequest 一致）
MemoryKind = Literal["fact", "preference", "event", "action"]
#: 记忆来源（同上）
MemorySource = Literal["chat", "user", "system", "action", "screen"]
#: 「行为观察」固定用这组 kind / source：只由行为记忆规则从 usage.db 派生（T2.1c），
#: 模型事件与手写端点都不许造（MemoryWriteRequest.kind 的枚举只有三种，见 §6.4）。
ACTION_KIND: MemoryKind = "action"
ACTION_SOURCE: MemorySource = "action"
#: 阶梯层号：1=阶段摘要，2=章节梗概，3=长期印象（§6.4）
SummaryTier = Literal[1, 2, 3]
#: 历史消息的角色：只记 user / assistant 两种，system 不进历史
HistoryRole = Literal["user", "assistant"]

#: 一层上下文的预算（§6.4）。裁剪顺序固定为「历史 → L0 片段 → L1 → L2」，L3 永不裁。
#: 数值是「注入给模型的记忆部分」的上限，不含人设与用户当前这句话。
DEFAULT_L3_BUDGET_TOKENS = 200
DEFAULT_L2_BUDGET_TOKENS = 300
DEFAULT_L1_BUDGET_TOKENS = 200
DEFAULT_RECALL_BUDGET_TOKENS = 400
DEFAULT_HISTORY_BUDGET_TOKENS = 1200
#: 行为观察（动作事实）单独一段的预算；它不该挤掉用户真正说过的话
DEFAULT_OBSERVATION_BUDGET_TOKENS = 200
#: 历史注入的默认轮数（一问一答算一轮）
DEFAULT_RECENT_TURNS = 6
#: 单轮最多检索出多少条 L0 片段
DEFAULT_RECALL_LIMIT = 8
#: 管理界面一页最多返回多少条
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200
#: 开发者模式「原文」页一页最多返回多少条历史消息（T2.3-B1）
DEFAULT_MESSAGE_PAGE_LIMIT = 100
MAX_MESSAGE_PAGE_LIMIT = 500

#: 检索打分权重（§6.4：全文 + 重要度 + 时间衰减）；三项权重之和为 1，便于解释分数
W_FTS = 0.65
W_IMPORTANCE = 0.25
W_RECENCY = 0.10
#: 时间衰减半衰期
DECAY_HALF_LIFE_DAYS = 30.0
#: 摘要阶梯的默认触发阈值（T2.1b 用；放在这里是为了「可调参数集中」）
DEFAULT_SUMMARY_TRIGGER_MESSAGES = 40
DEFAULT_SUMMARY_TRIGGER_TOKENS = 2000
DEFAULT_EPISODE_LIMIT = 5
DEFAULT_IMPRESSION_MESSAGES = 200
#: 阶梯压缩（T2.1b）：一次最多把多少条未覆盖原文喂给模型做 L1 摘要
DEFAULT_SUMMARY_BATCH_MESSAGES = 80
#: 攒够多少条 L1 才聚成一条 L2、攒够多少条 L2 才归纳出一条 L3
DEFAULT_L1_AGGREGATE_SUMMARIES = 3
DEFAULT_L2_AGGREGATE_SUMMARIES = 3
#: 原文 / 低重要度事实的保留天数；0 = 不自动清理
DEFAULT_RETENTION_DAYS = 7.0
#: 达到这个重要度的记忆永久保留，不参与 7 天清理
DEFAULT_PERMANENT_IMPORTANCE = 0.8

_CJK_RANGES: tuple[tuple[int, int], ...] = (
    (0x3400, 0x4DBF),  # CJK 扩展 A
    (0x4E00, 0x9FFF),  # CJK 基本区
    (0xF900, 0xFAFF),  # CJK 兼容表意
    (0x3040, 0x30FF),  # 平假名 / 片假名
    (0xAC00, 0xD7AF),  # 谚文音节
)


def is_cjk(char: str) -> bool:
    """判断是否为需要「逐字切分」的表意字符（FTS5 的 unicode61 不会切中文）。"""
    code = ord(char)
    return any(low <= code <= high for low, high in _CJK_RANGES)


def estimate_tokens(text: str) -> int:
    """粗估 token 数：表意字符每字 1 个，其余按 4 字符 1 个。

    只用于上下文预算裁剪（§6.4），不追求与实际分词器一致；宁可高估也不要低估。
    """
    if not text:
        return 0
    cjk = sum(1 for char in text if is_cjk(char))
    return cjk + (len(text) - cjk + 3) // 4


def token_count_of_messages(texts: Sequence[str]) -> int:
    """一组文本的合计预算。"""
    return sum(estimate_tokens(text) for text in texts)


def iso_time(ts: float | None) -> str:
    """把 epoch 秒转成本地时区的 ISO 字符串（契约里所有时间字段都是字符串）。"""
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, tz=UTC).astimezone().isoformat(timespec="seconds")


def parse_iso_time(text: str | None, *, default: float = 0.0) -> float:
    """把契约里的 ISO 时间串转回时间戳；解析不了就用 default（不因时间格式炸掉写入）。

    HTTP 边界上人类可读字符串更友好（MemoryWriteRequest.occurred_at），库里统一存时间戳，
    转换只发生在这一处。无时区的串按本机时区解释。
    """
    if not text:
        return default
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return default
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return parsed.timestamp()


def truncate_to_tokens(text: str, budget: int, *, ellipsis: str = "…") -> str:
    """按预算截断文本：放得下就原样返回，否则在预算内切一刀并加省略号。

    只给「宁可截断也不能整条丢」的层用（L3 长期印象，§6.4）。与 estimate_tokens 用同一套
    粗估口径，所以不会出现「截完了还超预算」。
    """
    if budget <= 0 or not text:
        return ""
    if estimate_tokens(text) <= budget:
        return text
    limit = max(0, budget - 1)  # 给省略号留一个 token
    keep: list[str] = []
    used = 0.0
    for char in text:
        cost = 1.0 if is_cjk(char) else 0.25
        if used + cost > limit:
            break
        keep.append(char)
        used += cost
    return "".join(keep).rstrip() + ellipsis


_FTS_SEPARATOR = re.compile(r"[^0-9A-Za-z\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+")


def to_fts_body(text: str) -> str:
    """把原文转成 FTS5 的入库文本：表意字符逐字空格分开，ASCII 词小写保留。

    unicode61 分词器只按空白与标点切词，中文整句会被当成一个 token，所以入库前
    必须自己把汉字切开（查「猫」才能命中「我养了一只猫」）。
    """
    out: list[str] = []
    for char in text:
        if is_cjk(char):
            out.append(" ")
            out.append(char)
            out.append(" ")
        else:
            out.append(char.lower())
    return _FTS_SEPARATOR.sub(" ", "".join(out)).strip()


def to_fts_query(text: str) -> str:
    """把用户输入转成 FTS5 的 MATCH 表达式；没有可用 token 时返回空串。

    用 OR 连接（任一词命中都算），每个 token 用双引号包住，避免 FTS5 的
    保留字（AND / OR / NOT / NEAR）与语法字符把查询搞坏。
    """
    tokens: list[str] = []
    seen: set[str] = set()
    for token in to_fts_body(text).split():
        if token and token not in seen:
            seen.add(token)
            tokens.append(token)
    return " OR ".join(f'"{token}"' for token in tokens)


def normalize_memory_text(text: str) -> str:
    """去重键：折叠空白、去首尾、ASCII 大小写归一（中文不受影响）。"""
    return re.sub(r"\s+", " ", text).strip().casefold()


def clamp_importance(value: float) -> float:
    """重要度夹到 [0, 1]；非有限值按默认值 0.5 处理（模型偶尔会吐 NaN）。"""
    if value != value or value in (float("inf"), float("-inf")):
        return 0.5
    return min(1.0, max(0.0, value))


def recency_weight(
    occurred_at: float, now: float, *, half_life_days: float = DECAY_HALF_LIFE_DAYS
) -> float:
    """时间衰减权重：半衰期默认 30 天，未来时间按 1.0 处理。"""
    if occurred_at <= 0 or now <= 0 or half_life_days <= 0:
        return 0.0
    age_days = max(0.0, now - occurred_at) / 86400.0
    return float(0.5 ** (age_days / half_life_days))


def fts_weight(rank: float) -> float:
    """把 bm25 的原始分（越小越好，通常是负数）映射到 (0, 1]，越大越相关。"""
    return 1.0 / (1.0 + max(0.0, -rank))


def score_memory(*, rank: float, importance: float, occurred_at: float, now: float) -> float:
    """检索总分 = 0.65 * 全文相关 + 0.25 * 重要度 + 0.10 * 时间衰减。"""
    return (
        W_FTS * fts_weight(rank)
        + W_IMPORTANCE * clamp_importance(importance)
        + W_RECENCY * recency_weight(occurred_at, now)
    )


@dataclass(frozen=True, slots=True)
class MessageDraft:
    """待落库的一条历史消息（L0 原文；记 user / assistant 两种角色）。"""

    char_id: str
    session_id: str
    role: HistoryRole
    text: str
    ts: float
    token_len: int = 0


@dataclass(frozen=True, slots=True)
class MessageRow:
    """落库后的历史消息。"""

    message_id: int
    char_id: str
    session_id: str
    role: str
    text: str
    ts: float
    token_len: int
    #: 已被哪条摘要覆盖（0 = 还没进过压缩链路）；开发者模式的「原文」页用它标灰（T2.3-B1）
    covered_by: int = 0


@dataclass(frozen=True, slots=True)
class MemoryDraft:
    """待落库的一条记忆（携带模型给的 kind / text / importance）。"""

    char_id: str
    kind: MemoryKind
    text: str
    importance: float = 0.5
    source: MemorySource = "chat"
    source_msg_ids: str = ""
    tier: str = "fact"
    occurred_at: float | None = None


@dataclass(frozen=True, slots=True)
class MemoryRecord:
    """管理界面看到的一条记忆。"""

    memory_id: int
    char_id: str
    kind: str
    tier: str
    text: str
    importance: float
    created_at: float
    last_used_at: float | None
    used_count: int
    source_msg_ids: str


@dataclass(frozen=True, slots=True)
class MemoryQuery:
    """列表 / 检索的通用过滤条件（char_id 必填，其余留空表示不限）。"""

    char_id: str
    kind: str = ""
    tier: str = ""
    min_importance: float = 0.0
    limit: int = DEFAULT_LIST_LIMIT


@dataclass(frozen=True, slots=True)
class HistoryTurn:
    """注入给模型的一条历史消息。"""

    role: str
    text: str
    ts: float


@dataclass(frozen=True, slots=True)
class FactSnippet:
    """检索命中的一条 L0 片段。"""

    memory_id: int
    kind: str
    text: str
    importance: float
    score: float
    occurred_at: float


@dataclass(frozen=True, slots=True)
class SummarySnippet:
    """一条阶梯摘要（L1 / L2 / L3）。"""

    summary_id: int
    tier: int
    text: str
    covers_to: float
    #: 这条摘要覆盖到的下层 id（L1 = 消息 id，L2/L3 = 下层摘要 id，逗号串）；
    #: 阶梯聚合靠它判断「上一层已经聚合到哪一条」（T2.1b）
    source_ids: str = ""


@dataclass(frozen=True, slots=True)
class RecallQuery:
    """一轮对话开始时的检索请求。"""

    char_id: str
    query: str = ""
    now: float = 0.0
    limit: int = DEFAULT_RECALL_LIMIT
    min_importance: float = 0.0
    #: 不参与这轮检索的 kind（行为观察单独取，避免占掉用户事实的名额）
    exclude_kinds: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class RecallContext:
    """一轮对话实际注入的记忆（prompt 只认这个对象，不认数据库）。

    dropped 记录被预算裁掉的层名，便于日志与实测判断「是不是记忆把窗口挤爆了」。
    """

    impressions: str = ""
    episodes: tuple[str, ...] = ()
    summaries: tuple[str, ...] = ()
    facts: tuple[FactSnippet, ...] = ()
    #: 行为观察（kind=action 的派生事实）：由我们自己按用量规则归纳，独立一段注入
    observations: tuple[FactSnippet, ...] = ()
    history: tuple[HistoryTurn, ...] = ()
    injected_ids: tuple[int, ...] = ()
    dropped: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        """没有任何可注入的内容。"""
        return not (
            self.impressions
            or self.episodes
            or self.summaries
            or self.facts
            or self.observations
            or self.history
        )

    @property
    def tokens(self) -> int:
        """记忆部分占用的预算估算。"""
        texts = [self.impressions, *self.episodes, *self.summaries]
        texts.extend(fact.text for fact in self.facts)
        texts.extend(observation.text for observation in self.observations)
        texts.extend(turn.text for turn in self.history)
        return token_count_of_messages(texts)


class MemoryBackendError(RuntimeError):
    """记忆库不可用的基类：服务层据此转成 DP-MEM-* 错误码与用户指引。"""


class MemoryKeyInvalidError(MemoryBackendError):
    """密钥缺失 / 读不出 / 与库不匹配（DP-MEM-001）。"""


class MemoryReadonlyError(MemoryBackendError):
    """库文件或目录不可写（DP-MEM-002）。"""


class MemoryIndexBrokenError(MemoryBackendError):
    """全文索引建不起来或查不动（DP-MEM-003）。"""


class MemoryStore(Protocol):
    """记忆库的存储协议：实现方是 adapters.memory_sqlite。

    全部方法都是同步的——SQLite 在本机读写是毫秒级，异步包装只会增加噪音。
    实现方必须保证「同一进程内线程安全」（sqlite3 连接按 check_same_thread=False + 锁）。
    """

    def add_messages(self, drafts: Sequence[MessageDraft]) -> tuple[int, ...]:
        """按顺序落库一批历史消息，返回它们的 id。"""
        ...

    def recent_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
        """取该角色最近 limit 条历史消息（时间升序返回）。"""
        ...

    def list_messages(
        self, char_id: str, *, limit: int = DEFAULT_MESSAGE_PAGE_LIMIT, before_id: int | None = None
    ) -> list[MessageRow]:
        """按 id 倒序翻该角色的历史原文（开发者模式「原文」页，T2.3-B1）。

        before_id 给了就只取更早的那些（向下翻页）；原文只读，删除由压缩链路负责。
        """
        ...

    def count_messages(self, char_id: str) -> int:
        """该角色累计落库的消息条数（摘要触发阈值用）。"""
        ...

    def uncovered_messages(self, char_id: str, *, limit: int) -> list[MessageRow]:
        """按时间升序取尚未被摘要覆盖的旧消息（L1 摘要的输入）。"""
        ...

    def mark_covered(self, message_ids: Sequence[int], *, summary_id: int) -> int:
        """把消息标记为已被某条摘要覆盖；原文在保留期到达后才删除。"""
        ...

    def mark_summaries_archived(self, summary_ids: Sequence[int], *, now: float) -> int:
        """标记下层摘要已被成功聚合；保留期从这一刻开始计时。"""
        ...

    def purge_expired(self, *, cutoff: float, permanent_importance: float) -> dict[str, int]:
        """清理到期原文、已聚合摘要和低重要度事实。"""
        ...

    def reset_character(self, char_id: str) -> dict[str, int]:
        """完整重置一个角色：原文、事实、摘要、状态全部删除。"""
        ...

    def upsert_memory(self, draft: MemoryDraft, *, now: float) -> tuple[int, bool]:
        """写入一条记忆，返回 (id, 是否命中去重)。"""
        ...

    def search_memories(self, query: RecallQuery) -> list[FactSnippet]:
        """全文 + 重要度 + 时间衰减检索 L0 片段，按总分降序。"""
        ...

    def list_memories(self, query: MemoryQuery) -> list[MemoryRecord]:
        """按重要度与新鲜度列记忆（管理界面用，不做全文检索）。"""
        ...

    def delete_memory(self, memory_id: int) -> bool:
        """删除一条记忆；id 不存在返回 False（幂等）。"""
        ...

    def get_memory(self, memory_id: int) -> MemoryRecord | None:
        """按 id 取一条记忆；id 不存在返回 None（编辑前要检查 kind）。"""
        ...

    def update_memory(
        self, memory_id: int, *, text: str, importance: float | None = None
    ) -> tuple[MemoryRecord | None, bool]:
        """改一条 L0 记忆的文本（可选重要度），返回（改完的记录，是否并进了已有的一条）。

        (None, False) 表示 id 不存在。文本变了要重算去重键并同步 FTS 行；
        改后与同角色另一条撞去重键时并成一条：保留已有那行、删掉本条。
        """
        ...

    def clear_memories(self, char_id: str, *, keep_days: float | None = None) -> int:
        """清空该角色的记忆（L1 / L2 / L3 摘要一并删），返回删除条数。"""
        ...

    def mark_used(self, memory_ids: Sequence[int], *, now: float) -> int:
        """把注入过的记忆标记为「用过」（last_used_at / used_count）。"""
        ...

    def add_summary(
        self,
        *,
        char_id: str,
        tier: int,
        text: str,
        covers_from: float,
        covers_to: float,
        source_ids: str = "",
        now: float = 0.0,
    ) -> int:
        """追加一条阶梯摘要，返回 id。"""
        ...

    def latest_summary(self, char_id: str, tier: int) -> SummarySnippet | None:
        """取该层最新一条摘要（没有返回 None）。"""
        ...

    def list_summaries(self, char_id: str, tier: int, *, limit: int) -> list[SummarySnippet]:
        """取该层最近 limit 条摘要，新的在前。"""
        ...


class MemoryGateway(Protocol):
    """对话链路用到的最小记忆接口（services.memory_service 实现，chat_service 只认它）。"""

    def record_message(
        self, *, char_id: str, session_id: str, role: HistoryRole, text: str, ts: float
    ) -> None:
        """落一条 L0 原文（失败只记日志，绝不影响这一轮对话）。"""
        ...

    def record_facts(
        self,
        *,
        char_id: str,
        session_id: str,
        facts: Sequence[MemoryDraft],
        ts: float,
    ) -> list[int]:
        """把模型这条消息里的 m 事件落库，返回新增 / 命中的记忆 id。"""
        ...

    def recall(self, *, char_id: str, query: str, now: float) -> RecallContext:
        """装配本轮要注入的记忆（L3 / L2 / L1 + 检索到的 L0 + 最近历史）。"""
        ...


class CompressionScheduler(Protocol):
    """对话链路用来触发阶梯压缩的最小接口（T2.1b）。

    实现方是 services.memory_summary_service.MemorySummarizer：schedule 只负责把活排到
    后台，必须立刻返回——压缩是增强项，绝不能拖慢或搞崩这一轮对话（§6.4）。
    """

    def schedule(self, char_id: str) -> None:
        """安排一次后台压缩；已有任务在跑或库不可用时安静跳过。"""
        ...


class BehaviorScheduler(Protocol):
    """对话链路用来触发行为观察刷新的最小接口（T2.1c）。

    实现方是 services.behavior_memory_service.BehaviorMemoryService：和压缩一样，schedule
    只把活排到后台就返回——观察是增强项，统计读不动也只是少一条观察（§6.4 / §6.9）。
    """

    def schedule(self, char_id: str) -> None:
        """安排一次后台刷新；已有任务在跑或统计读不到时安静跳过。"""
        ...
