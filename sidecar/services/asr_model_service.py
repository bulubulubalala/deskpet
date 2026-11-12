"""文件职责：语音识别模型的「装没装、下到哪了」——预下载与进度（D7）。

依赖方向：services -> config / contracts / core；不 import api / adapters。
谁调用：api/asr.py 的 GET /asr/model 与 POST /asr/model/prefetch；
sidecar/app.py 经 AsrModelService(settings, asr_service.adapter) 构造。

为什么需要它：模型**本来就不进安装包**（faster-whisper 首次加载时才下载），
但这意味着用户第一次点麦克风会静默等几分钟、没有任何反馈；下载失败也只看到一句
「语音识别不可用」。这里把「要不要下、下到哪、失败为什么」变成可查询的状态，
让设置窗能提前把模型下好、下载时显示进度。

约定：
- 下载＝调用适配器的 load()（它就是 faster-whisper 的「没有就下」入口），
  在线程池里跑，事件循环不被阻塞；同一时刻只允许一个下载任务（单飞）。
- 进度不靠 faster-whisper 报告（它没有回调），而是轮询 model_dir 的体积；
  预计体积按模型名估（MODEL_ESTIMATED_BYTES），估不出来就只报「已下载 X MB」，
  绝不编一个假百分比。
- 下载完成写一个标记文件 `.deskpet-ready`：它比「目录里有文件」更可靠
  （半途中断的目录也有文件），但已有的旧缓存仍以「存在 *.bin」视为就绪。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path

from config import PROVIDER_CLOUD, AsrSettings, Settings
from contracts.asr_model import AsrModelState, AsrModelStatus
from core.errors import DeskpetError
from core.logging import get_logger, log_event

LOGGER = get_logger("services.asr_model_service")

STATUS_READY: AsrModelStatus = "ready"
STATUS_MISSING: AsrModelStatus = "missing"
STATUS_DOWNLOADING: AsrModelStatus = "downloading"
STATUS_ERROR: AsrModelStatus = "error"

#: 标记文件：本服务成功跑完一次 load() 后写下，内容为模型名
READY_MARKER = ".deskpet-ready"

#: 进度条用的「大概多大」（字节）。faster-whisper 的 CTranslate2 int8 权重量级，
#: 只用于显示百分比，不参与任何判断；估不出来（自定义模型名 / 本地目录）就报 0。
MODEL_ESTIMATED_BYTES: dict[str, int] = {
    "tiny": 75_000_000,
    "base": 148_000_000,
    "small": 488_000_000,
    "medium": 1_530_000_000,
    "large-v3": 3_090_000_000,
}

#: 轮询目录体积的间隔（秒）；只在下载期间起作用，不影响识别
PROGRESS_POLL_S = 0.5

DirSize = Callable[[Path], int]


def _dir_size(root: Path) -> int:
    """目录下所有普通文件的字节数；读不到的条目跳过（下载中的文件会变化）。"""
    total = 0
    try:
        entries = list(root.rglob("*"))
    except OSError:
        return 0
    for entry in entries:
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def _estimated_bytes(model: str) -> int:
    """按模型名估总体积：`small` / `small.en` / `Systran/faster-whisper-small` 都归到 small。"""
    name = model.strip().lower().rsplit("/", 1)[-1]
    # Systran/faster-whisper-small / whisper-small 这类写法也归到 small
    for prefix in ("faster-whisper-", "whisper-"):
        if name.startswith(prefix):
            name = name[len(prefix) :]
    for key in sorted(MODEL_ESTIMATED_BYTES, key=len, reverse=True):
        if name == key or name.startswith(key + ".") or name.endswith("-" + key):
            return MODEL_ESTIMATED_BYTES[key]
    return 0


def _mb(value: int) -> str:
    """字节 → 「123 MB」；给用户看的文案用，不追求精确。"""
    return f"{value / 1_000_000:.0f} MB"


class AsrModelService:
    """一个进程一个实例：状态在内存里，下载任务单飞，标记文件落在模型目录。"""

    def __init__(
        self,
        settings: AsrSettings,
        asr: object,
        *,
        loader: Callable[[], None] | None = None,
        dir_size: DirSize | None = None,
        poll_interval_s: float = PROGRESS_POLL_S,
    ) -> None:
        """asr 只需要 `load()` 与 `is_loaded` 两个成员（真身是 FasterWhisperAsr）。"""
        self._settings = settings
        self._asr = asr
        # 注入对象没有 load()：保持可用，只是永远报错（用户会看到「不支持预下载」）
        resolved: Callable[[], None] | None = loader
        if resolved is None:
            candidate = getattr(asr, "load", None)
            resolved = candidate if callable(candidate) else None
        self._loader: Callable[[], None] = resolved or self._missing_loader
        self._dir_size = dir_size or _dir_size
        self._poll_interval_s = poll_interval_s
        self._task: asyncio.Task[None] | None = None
        self._error: str = ""
        self._error_hint: str = ""

    # ---- 对外 ----

    def status(self) -> AsrModelState:
        """当前状态：不碰网络、不触发下载，随时可查（设置窗每秒拉一次）。"""
        if self._settings.provider == PROVIDER_CLOUD:
            return self._state(
                STATUS_READY,
                message="语音识别走云端，不需要下载模型。",
            )
        if self._error:
            return self._state(
                STATUS_ERROR,
                message="语音识别模型下载失败：" + self._error,
                user_hint=self._error_hint,
                progress=0.0,
            )
        downloading = self._task is not None and not self._task.done()
        downloaded = self._dir_size(self._settings.model_dir)
        estimated = _estimated_bytes(self._settings.model)
        if downloading:
            return self._state(
                STATUS_DOWNLOADING,
                downloaded=downloaded,
                estimated=estimated,
                progress=_progress(downloaded, estimated),
                message="正在下载语音识别模型…已下载 " + _mb(downloaded) + "。",
            )
        if self._present():
            return self._state(
                STATUS_READY,
                downloaded=downloaded,
                estimated=estimated,
                progress=1.0,
                message="语音识别模型已就绪。",
            )
        hint = (
            "第一次点麦克风会静默下载好几分钟；建议现在先点「下载模型」。"
            if not self._settings.hf_endpoint
            else "已配置镜像 " + self._settings.hf_endpoint + "，点「下载模型」会从这里拉。"
        )
        return self._state(
            STATUS_MISSING,
            downloaded=downloaded,
            estimated=estimated,
            message="还没下载语音识别模型（约 " + _mb(estimated or 0) + "）。"
            if estimated
            else "还没下载语音识别模型。",
            user_hint=hint,
        )

    def start(self) -> AsrModelState:
        """启动后台下载（幂等）：已就绪 / 正在下 / 云端 → 什么都不做。"""
        if self._settings.provider == PROVIDER_CLOUD or self._present():
            return self.status()
        if self._task is not None and not self._task.done():
            return self.status()
        self._error = ""
        self._error_hint = ""
        self._task = asyncio.get_running_loop().create_task(self._download())
        log_event(
            LOGGER,
            logging.INFO,
            module="services.asr_model_service",
            event="asr.model_prefetch_started",
            message="开始下载语音识别模型",
            fields={"model": self._settings.model, "dir": str(self._settings.model_dir)},
        )
        return self.status()

    async def wait(self) -> None:
        """等当前下载任务结束（测试与优雅退出用；没有任务时立即返回）。"""
        task = self._task
        if task is None:
            return
        await asyncio.gather(task, return_exceptions=True)

    # ---- 内部 ----

    async def _download(self) -> None:
        """线程里跑 load()（缺模型时它就是下载入口），期间轮询体积供 status() 显示。"""
        try:
            self._settings.model_dir.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(self._loader)
            self._write_marker()
            log_event(
                LOGGER,
                logging.INFO,
                module="services.asr_model_service",
                event="asr.model_prefetch_done",
                message="语音识别模型已下载并加载",
                fields={
                    "model": self._settings.model,
                    "bytes": self._dir_size(self._settings.model_dir),
                },
            )
        except DeskpetError as exc:
            self._fail(str(exc), exc.user_hint or "")
        except (OSError, RuntimeError, ValueError) as exc:
            self._fail(str(exc), "检查网络后重试；国内可在设置里填 HuggingFace 镜像。")
        except Exception as exc:  # 下载链路上的任何意外都不该让 /health 崩掉
            self._fail(repr(exc), "检查网络后重试；仍然失败请复制诊断信息。")

    def _fail(self, message: str, hint: str) -> None:
        self._error = message
        self._error_hint = hint
        log_event(
            LOGGER,
            logging.WARNING,
            module="services.asr_model_service",
            event="asr.model_prefetch_failed",
            message="语音识别模型下载失败",
            fields={"model": self._settings.model, "error": message},
        )

    def _present(self) -> bool:
        """就绪判定：已加载 / 有标记文件 / 目录里已有 .bin（旧缓存直接算就绪）。"""
        try:
            if bool(getattr(self._asr, "is_loaded", False)):
                return True
        except Exception:
            return False
        model_dir = self._settings.model_dir
        try:
            if (model_dir / READY_MARKER).is_file():
                return True
            return any(p.suffix == ".bin" for p in model_dir.rglob("*.bin"))
        except OSError:
            return False

    def _write_marker(self) -> None:
        try:
            (self._settings.model_dir / READY_MARKER).write_text(
                self._settings.model, encoding="utf-8"
            )
        except OSError as exc:  # 标记写不下不影响已下载好的模型
            log_event(
                LOGGER,
                logging.WARNING,
                module="services.asr_model_service",
                event="asr.model_marker_failed",
                message="写模型就绪标记失败",
                fields={"error": str(exc)},
            )

    def _missing_loader(self) -> None:
        raise RuntimeError("这个 ASR 适配器没有 load()，无法预下载")

    def _state(
        self,
        status: AsrModelStatus,
        *,
        downloaded: int = 0,
        estimated: int = 0,
        progress: float = 0.0,
        message: str = "",
        user_hint: str = "",
    ) -> AsrModelState:
        return AsrModelState(
            status=status,
            provider=self._settings.provider,
            model=self._settings.model,
            downloaded_bytes=max(0, downloaded),
            estimated_bytes=max(0, estimated),
            progress=max(0.0, min(1.0, progress)),
            message=message,
            user_hint=user_hint,
        )


def _progress(downloaded: int, estimated: int) -> float:
    """估不出总量就返回 0（界面只显示「已下载 X MB」），估出来也封顶 0.99 直到真正就绪。"""
    if estimated <= 0:
        return 0.0
    return min(0.99, downloaded / estimated)


def build_asr_model_service(settings: Settings, asr: object) -> AsrModelService:
    """组合根用的构造器：settings 取 asr 段，asr 取 AsrService.adapter。"""
    return AsrModelService(settings.asr, asr)
