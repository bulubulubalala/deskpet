"""文件职责：T0.5 launcher 的端到端契约测试（真 socket + 真 HTTP + 优雅退出即删）。

为什么不打桩：T0.5 的验收就是「监听成功 → 写 runtime.json → /health 快 → 退出即删」，
这条链路只有起真服务器才验得了。它不加载模型、不碰 GPU、不占麦克风，所以 CI 也能跑
（CODE_STYLE §7：音频与 GPU 相关代码必须能无硬件跑测试）。
"""

import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from api.auth import TOKEN_HEADER
from config import Settings
from contracts.errors import (
    CODE_NOT_IMPLEMENTED,
    CODE_TTS_NOT_AVAILABLE,
    CODE_UNAUTHORIZED,
)
from main import launch, serve

STARTUP_TIMEOUT_S = 15.0
SHUTDOWN_TIMEOUT_S = 15.0
# 需求 §6.3 要求 /health ≤10ms；测试放宽到 100ms，只为拦住「心跳里偷偷加载模型」这类回归
HEALTH_LATENCY_BUDGET_MS = 100.0
MODULE_ORDER = ["tts", "asr", "llm", "memory", "screen", "stage"]


def _request(url: str, token: str | None = None, method: str = "GET", payload: dict | None = None):
    """发一次请求并返回（状态码, JSON）。4xx/5xx 也算正常返回——我们就是要验信封。"""
    headers = {TOKEN_HEADER: token} if token else {}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, headers=headers, data=data, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def _wait_until_healthy(url: str, token: str) -> None:
    deadline = time.perf_counter() + STARTUP_TIMEOUT_S
    last_error: Exception | None = None
    while time.perf_counter() < deadline:
        try:
            if _request(url, token)[0] == 200:
                return
        except (urllib.error.URLError, OSError) as exc:  # 端口还没开始 listen
            last_error = exc
        time.sleep(0.05)
    raise AssertionError("sidecar 未在 %.1fs 内就绪：%r" % (STARTUP_TIMEOUT_S, last_error))


def test_launcher_serves_health_then_removes_runtime_file(tmp_path: Path) -> None:
    settings = Settings(host="127.0.0.1", port=0, data_dir=tmp_path, log_level="warning")
    launched = launch(settings)
    assert launched.info.port > 0  # port=0 时由系统分配，Electron 只能从 runtime.json 学到
    assert launched.runtime_file == tmp_path / "runtime.json"
    assert launched.runtime_file.exists()

    thread = threading.Thread(target=serve, args=(launched,), daemon=True)
    thread.start()
    base_url = "http://%s:%d" % (launched.info.host, launched.info.port)
    try:
        _wait_until_healthy(base_url + "/health", launched.info.token)
        # 握手文件内容 = 真实端口 + token，且目录里不能留半截 .tmp
        assert json.loads(launched.runtime_file.read_text(encoding="utf-8")) == (
            launched.info.model_dump()
        )
        assert sorted(item.name for item in tmp_path.iterdir()) == ["runtime.json"]

        status, body = _request(base_url + "/health", launched.info.token)
        assert status == 200
        assert body["status"] == "ok"
        assert [module["name"] for module in body["modules"]] == MODULE_ORDER
        assert body["gpu"]["loaded_mb"] == 0

        # token 是硬门槛（本机其它进程不该能乱调）
        assert _request(base_url + "/health")[0] == 401
        assert _request(base_url + "/health")[1]["code"] == CODE_UNAUTHORIZED
        # 未实现的路由：方法对得上才给 501 + 统一信封（/gpu/lock 是 POST）
        # HTTPException 的 detail 会被 FastAPI 包一层：{"detail": {"code": ...}}（401 那两条不同，
        # 中间件直接返回 JSONResponse，所以读顶层）
        lock_payload = {"holder": "tts", "request_id": "probe"}
        status, body = _request(
            base_url + "/gpu/lock", launched.info.token, method="POST", payload=lock_payload
        )
        assert status == 501
        assert body["detail"]["code"] == CODE_NOT_IMPLEMENTED
        # T1.5 起 /tts 是真实现：真启动的 sidecar 上没跑适配器，必须是明确的「引擎不可用」
        # 而不是 404 / 501（D14：只说清楚，不假装在说话）
        tts_payload = {"text": "你好", "voice_id": "amber", "request_id": "probe"}
        status, body = _request(
            base_url + "/tts", launched.info.token, method="POST", payload=tts_payload
        )
        assert status == 500
        assert body["code"] == CODE_TTS_NOT_AVAILABLE

        samples_ms = []
        for _ in range(5):
            tick = time.perf_counter()
            _request(base_url + "/health", launched.info.token)
            samples_ms.append((time.perf_counter() - tick) * 1000)
        assert min(samples_ms) < HEALTH_LATENCY_BUDGET_MS
    finally:
        launched.server.should_exit = True
        thread.join(timeout=SHUTDOWN_TIMEOUT_S)

    assert not thread.is_alive()
    assert not launched.runtime_file.exists()
