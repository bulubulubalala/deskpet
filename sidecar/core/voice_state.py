"""文件职责：全双工语音状态机（需求 §4.3 / F2；PLAN T1.6）。

依赖方向：纯逻辑，只用标准库（CODE_STYLE §1.1：core 不发网络请求、不开 GPU、不读磁盘）。
谁调用：services/voice_service.py 把「活动进出」翻译成状态迁移；/health 读快照对外汇报。

为什么不是一条简单的状态链：语音链路上的工作在时间上会重叠——LLM 还在推句子时 TTS 已经
开始合成，而用户又能随时打断。若用「当前状态」互相覆盖，必然出现「TTS 结束时把还在跑的
ASR thinking 覆盖成 idle」这类错乱。所以这里记录**正在进行的活动集合**，状态由集合 +
听音标志 + 取消标志推导：

- cancelling 优先：取消请求已受理，在途活动还没退干净
- 正在听 → listening（**优先于在途活动**：用户开口即打断，播放侧已经立刻停了，此时在途的
  TTS 结果已经作废，UI 该显示「在听」，不该还显示「在说」）
- tts 在跑 → speaking（「不允许停在 speaking」由调用点 finally 里 end 保证）
- asr / chat 在跑 → thinking
- 都没有 → idle

取消只置标志并抬升 generation，等活动自然退干净后自动落回 idle——这就是「任何错误路径都必须
复位」的落地方式：调用点只要把 begin/end 放进 try/finally（services/voice_service.py 的
上下文管理器已经包好），就不会卡在某个状态里。generation 供调用方判定「这趟还算不算数」，
例如被用户打断后已经在途的 ASR 结果不该再喂给 LLM。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: 语音状态机的状态；与 app/main/ipc.ts 的 VOICE_STATES 逐字对齐（跨语言契约测试对账）。
VoiceState = Literal["idle", "listening", "thinking", "speaking", "cancelling"]

#: 会占用语音链路的活动名：asr（识别）/ chat（LLM 生成）/ tts（合成）
VoiceActivity = Literal["asr", "chat", "tts"]

VOICE_ACTIVITIES: tuple[VoiceActivity, ...] = ("asr", "chat", "tts")

#: 调用方没给原因时的兜底值；真实调用点都应给更具体的原因，便于日志归因
CANCEL_REASON_UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class VoiceSnapshot:
    """某一刻的状态快照；cancelling 表示「取消还没收尾」，不代表此刻还有声音在放。"""

    state: VoiceState
    generation: int
    cancel_reason: str
    listening: bool
    activities: tuple[str, ...]


class VoiceStateMachine:
    """语音链路的唯一状态入口（PLAN T1.6）。

    线程/任务安全说明：所有迁移都是同步的、不含 await，因此在 asyncio 事件循环里天然原子；
    不要在一个迁移与下一个迁移之间穿插磁盘/网络等待。
    """

    def __init__(self) -> None:
        self._activities: set[VoiceActivity] = set()
        self._listening = False
        self._cancelling = False
        self._cancel_reason = ""
        self._generation = 0

    # ---- 只读查询（不改状态；/health 与调用方随时可读） ----

    def state(self) -> VoiceState:
        """当前状态（推导，不落库）。"""
        if self._cancelling:
            return "cancelling"
        if self._listening:
            return "listening"
        if "tts" in self._activities:
            return "speaking"
        if self._activities:
            return "thinking"
        return "idle"

    def generation(self) -> int:
        """当前取消代数；调用方开工前取一次，收工后用它判断是否已被打断。"""
        return self._generation

    def is_cancelled(self, generation: int) -> bool:
        """generation 之后发生过取消 → 该 generation 的结果已作废。"""
        return generation < self._generation

    def snapshot(self) -> VoiceSnapshot:
        """给 /health 与日志用的不可变快照。"""
        return VoiceSnapshot(
            state=self.state(),
            generation=self._generation,
            cancel_reason=self._cancel_reason,
            listening=self._listening,
            activities=tuple(sorted(self._activities)),
        )

    # ---- 迁移（都返回迁移后的快照） ----

    def listen_start(self) -> VoiceSnapshot:
        """用户开始说话。

        即使在 cancelling 中也照样受理：打断的终点就是用户开口，所以这里会顺手清掉取消标记。
        """
        self._listening = True
        self._cancelling = False
        self._cancel_reason = ""
        return self.snapshot()

    def listen_stop(self) -> VoiceSnapshot:
        """用户说完了（送 ASR 之前）；空闲时是空操作。"""
        self._listening = False
        return self.snapshot()

    def begin(self, activity: VoiceActivity) -> VoiceSnapshot:
        """登记一个活动。

        幂等：同一个活动重复 begin 只算一次，一次 end 就能清掉。这样调用点即使重复触发
        （连按语音键、双击打断）也不会把状态卡住。
        """
        self._activities.add(activity)
        self._listening = False
        return self.snapshot()

    def end(self, activity: VoiceActivity) -> VoiceSnapshot:
        """注销活动；活动退干净且没有在听时，cancelling 也随之收尾回 idle。"""
        self._activities.discard(activity)
        self._settle_cancel()
        return self.snapshot()

    def cancel(self, reason: str = CANCEL_REASON_UNKNOWN) -> int:
        """受理一次打断，返回新的 generation。

        空闲时（没有活动也没在听）是空操作：既不改状态也不抬 generation，这样重复触发或
        误触不会产生「假的取消」，调用方也不会因为一次空取消而丢弃正常结果。
        """
        if not self._activities and not self._listening:
            return self._generation
        self._generation += 1
        self._cancelling = True
        self._cancel_reason = reason
        self._listening = False
        self._settle_cancel()
        return self._generation

    def reset(self) -> VoiceSnapshot:
        """硬复位：把状态清回 idle。

        错误路径兜底用（异常处理器、进程边界）；正常路径不需要它——上下文管理器已经保证
        活动成对进出。它刻意不动 generation：已经作废的结果不应因为一次复位又变成有效。
        """
        self._activities.clear()
        self._listening = False
        self._cancelling = False
        self._cancel_reason = ""
        return self.snapshot()

    # ---- 内部 ----

    def _settle_cancel(self) -> None:
        """在途工作退干净后收尾取消（此时状态自动落回 idle）。"""
        if self._cancelling and not self._activities and not self._listening:
            self._cancelling = False
            self._cancel_reason = ""
