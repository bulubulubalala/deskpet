r"""deskpet 的 IndexTTS 常驻适配器（独立小包，必须用 IndexTTS 自己的解释器运行）。

文件职责：
    给 deskpet 的 sidecar 提供「一次一句话」的本地 HTTP 合成服务。子模块分工：
      config.py     常量与命令行参数
      errors.py     对外错误类型与 HTTP 状态码映射
      audio.py      wav 读取 / 峰值归一化（soundfile + numpy，延迟 import）
      engine.py     模型生命周期与推理（IndexTTS2）
      worker.py     单线程队列 + 取消语义
      http_api.py   路由、鉴权、JSON 信封
      cli.py        进程入口

依赖方向：
    sidecar --HTTP--> 本包 --进程内--> indextts.infer_v2_5.IndexTTS2
    本包**不 import deskpet 的任何模块**，也不安装 / 修复 / 升级 IndexTTS（需求 D14）。

启动（仓库根，用 IndexTTS 自己的 venv）：
    D:\IndexTTS\.venv\Scripts\python.exe -m tools.indextts_adapter --port 8742
契约：需求 docs/REQUIREMENTS.md §6.12。
"""

from __future__ import annotations

from tools.indextts_adapter.engine import IndexTtsEngine
from tools.indextts_adapter.errors import AdapterError
from tools.indextts_adapter.worker import SynthesisRequest, TtsWorker

__all__ = ["AdapterError", "IndexTtsEngine", "SynthesisRequest", "TtsWorker"]
