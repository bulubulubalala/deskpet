"""文件职责：LLM 事件协议契约测试（需求 §6.2 的样本行逐字验证）。

依赖方向：tests -> contracts（events）+ 快照文件；无外部依赖、无硬件。
谁调用：pytest。
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from contracts.events import (
    LLM_EVENT_ADAPTER,
    LLM_EVENT_KINDS,
    MAX_SENTENCE_CHARS,
    ActEvent,
    EndEvent,
    ErrorEvent,
    MemoryEvent,
    SentenceEvent,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
EVENT_SCHEMA_SNAPSHOT = REPO_ROOT / "sidecar" / "contracts" / "llm_events.schema.json"

# 逐字取自需求 §6.2 的样本行（不要改成其它写法，样本本身就是契约）
SAMPLE_LINES = [
    '{"t":"s","i":0,"text":"……","emotion":"害羞","intensity":0.7,"act":"blush"}',
    '{"t":"s","i":1,"text":"……","emotion":"平静","intensity":0.2}',
    '{"t":"m","kind":"fact","text":"用户下周三要考试","importance":0.8}',
    '{"t":"a","act":"look_at_screen","why":"用户提到报错"}',
    '{"t":"e","code":"DP-LLM-003","user_hint":"网络不通，稍后再试","recoverable":true}',
    '{"t":"end"}',
]


def test_sample_lines_parse_into_expected_models() -> None:
    """六行样本必须各自解析成对应模型（t 就是判别字段）。"""
    parsed = [LLM_EVENT_ADAPTER.validate_json(line) for line in SAMPLE_LINES]
    assert [type(event) for event in parsed] == [
        SentenceEvent,
        SentenceEvent,
        MemoryEvent,
        ActEvent,
        ErrorEvent,
        EndEvent,
    ]


def test_event_kinds_cover_every_model() -> None:
    """判别值清单是跨语言锚点：app/main/ipc.ts 的 CHAT_EVENT_KINDS 必须与它一致（T1.3）。"""
    assert list(LLM_EVENT_KINDS) == ["s", "m", "a", "end", "e"]


def test_error_event_carries_technical_hint_and_is_recoverable_by_default() -> None:
    """error 事件是「技术提示」的唯一通道（§6.7）：角色台词不承担报错，也不许吞掉它。"""
    event = LLM_EVENT_ADAPTER.validate_json(
        '{"t":"e","code":"DP-LLM-003","user_hint":"网络不通，稍后再试"}'
    )
    assert isinstance(event, ErrorEvent)
    assert event.recoverable is True


def test_error_event_rejects_bad_code_pattern() -> None:
    """错误码必须符合 DP-域-三位（CODE_STYLE §6.1），随手写的字符串要当场被拒。"""
    with pytest.raises(ValidationError):
        LLM_EVENT_ADAPTER.validate_json('{"t":"e","code":"oops","user_hint":"x"}')


def test_sentence_longer_than_limit_is_rejected() -> None:
    """超过 MAX_SENTENCE_CHARS 的句子必须被拒（IndexTTS 会吞字，需求 §3.5）。"""
    assert MAX_SENTENCE_CHARS == 40
    with pytest.raises(ValidationError):
        SentenceEvent.model_validate({"t": "s", "i": 0, "text": "字" * (MAX_SENTENCE_CHARS + 1)})


def test_missing_discriminator_is_rejected() -> None:
    """没有 t 字段的 JSON 行必须报错，由上层降级为纯文本模式（需求 §6.2）。"""
    with pytest.raises(ValidationError):
        LLM_EVENT_ADAPTER.validate_json('{"text":"你好"}')


def test_unknown_field_is_rejected() -> None:
    """协议不认识的字段直接报错，避免 LLM 自由发挥把格式带偏。"""
    with pytest.raises(ValidationError):
        LLM_EVENT_ADAPTER.validate_json('{"t":"end","extra":1}')


def test_event_schema_snapshot_matches_contract() -> None:
    """提交的 llm_events.schema.json 必须与 events.py 一致；改了就要重跑导出脚本。"""
    assert EVENT_SCHEMA_SNAPSHOT.is_file(), "缺少事件协议快照：执行 python scripts/export_openapi.py"
    snapshot = json.loads(EVENT_SCHEMA_SNAPSHOT.read_text(encoding="utf-8"))
    assert snapshot == LLM_EVENT_ADAPTER.json_schema()
