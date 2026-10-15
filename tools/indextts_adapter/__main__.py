r"""文件职责：`python -m tools.indextts_adapter` 的入口，只把 cli.main() 的返回值变成退出码。"""

from __future__ import annotations

from tools.indextts_adapter.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
