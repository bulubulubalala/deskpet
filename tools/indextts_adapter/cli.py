r"""文件职责：适配器进程入口——解析参数、起 worker 与 HTTP 服务、优雅退出。

依赖方向：最外层，依赖本包其余模块；不被任何模块 import（只有 __main__ 调它）。
为什么单独一个文件：把「怎么起服务」与「服务里有啥」分开，http_api 才能在测试里被直接驱动。
"""

from __future__ import annotations

import logging
from http.server import ThreadingHTTPServer
from pathlib import Path

from tools.indextts_adapter.config import build_parser
from tools.indextts_adapter.engine import IndexTtsEngine
from tools.indextts_adapter.errors import AdapterError
from tools.indextts_adapter.http_api import AdapterState, make_handler
from tools.indextts_adapter.worker import TtsWorker

__all__ = ["main"]

LOG = logging.getLogger("deskpet.indextts_adapter")


def main(argv: list[str] | None = None) -> int:
    """起服务并阻塞在 serve_forever；Ctrl-C 退出。返回进程退出码。"""
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    engine = IndexTtsEngine(Path(args.model_dir), Path(args.voice_dir))
    worker = TtsWorker(engine)
    worker.start()
    state = AdapterState(engine, worker, args.token)
    if args.preload:
        try:
            engine.load()
        except AdapterError as exc:
            # 预热失败不致命：真正合成时还会再试一次，错误也会原样报给调用方（D14）
            LOG.error("preload failed: %s", exc.message)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    LOG.info("listening on http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        server.server_close()
        worker.stop()
    return 0
