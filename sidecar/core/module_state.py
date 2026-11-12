"""文件职责：模块状态登记表（纯内存、无 I/O），供 /health 与 UI 心跳使用。

依赖方向：core 是最内层纯逻辑，不 import adapters / api / services（CODE_STYLE §1.1）。
谁调用：services/health_service.py 读取快照；M1 起各 service 在加载/失败时上报状态。
"""

from contracts.health import ModuleHealth, ModuleName, ModuleState


class ModuleRegistry:
    """模块状态登记表：把「我活着吗、正在加载什么」集中在一处（CODE_STYLE §1.5 的思想）。"""

    def __init__(self, module_names: tuple[ModuleName, ...]) -> None:
        self._modules: dict[ModuleName, ModuleHealth] = {
            name: ModuleHealth(name=name, state=ModuleState.IDLE) for name in module_names
        }

    def mark(self, module: ModuleName, state: ModuleState, detail: str | None = None) -> None:
        """更新某模块状态；detail 只写机器可读短描述，不写敏感内容（CODE_STYLE §6）。"""
        if module not in self._modules:
            raise KeyError(f"未登记的模块：{module.value}")
        self._modules[module] = ModuleHealth(name=module, state=state, detail=detail)

    def snapshot(self) -> list[ModuleHealth]:
        """返回当前状态的副本（按登记顺序），调用方改不动内部登记表。"""
        return list(self._modules.values())
