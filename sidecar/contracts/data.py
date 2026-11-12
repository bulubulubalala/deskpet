"""文件职责：数据导出（D9 / M3）的响应契约——"搬家要带走的东西"打成的 zip。

依赖方向：只依赖 pydantic；被 api/data.py 序列化，services/export_service.py 产出同形数据。
谁调用：主进程 app/main/sidecar-client.ts 的 exportData()，再由托盘「导出数据包」触发。
约定：path 是 sidecar 所在机器的绝对路径（同机部署，主进程直接拿去 openPath）；
entries 只列顶层条目，方便界面一句话说清"导出了什么"。
"""

from typing import Literal

from pydantic import BaseModel, Field

#: 备份文件的类型（界面分组用）：services/backup_service.py 也用它标注 list_files() 的返回值
BackupKind = Literal["daily", "before", "replaced", "rejected", "other"]


class DataExportResponse(BaseModel):
    """一次数据导出的结果；不含任何密钥内容。"""

    path: str = Field(description="导出包绝对路径")
    bytes: int = Field(description="导出包大小（字节）")
    created_at: str = Field(description="创建时间（本地时间 ISO 字符串）")
    entries: list[str] = Field(default_factory=list, description="包内顶层条目")
    skipped: list[str] = Field(
        default_factory=list, description="跳过的内容与原因（如记忆库没打开）"
    )


class BackupEntry(BaseModel):
    """备份目录里的一个文件；kind 只给界面分组用。"""

    file: str = Field(description="文件名（不含目录）")
    kind: BackupKind = Field(
        description="daily=每日快照，before=操作前留底，replaced/rejected=恢复残骸，other=认不出来"
    )
    bytes: int = Field(description="文件大小（字节）")
    modified_at: float = Field(description="修改时间（unix 秒）")


class DataBackupsResponse(BaseModel):
    """备份目录现状：界面用来显示「有哪些后悔药」，不做任何删除。"""

    dir: str = Field(description="备份目录绝对路径")
    total_bytes: int = Field(description="所有备份合计大小（字节）")
    entries: list[BackupEntry] = Field(default_factory=list, description="按时间新→旧")


class DataBackupNowResponse(BaseModel):
    """「立即备份」的结果；path 为空表示没做成（记忆库没打开、磁盘满等）。"""

    path: str = Field(default="", description="新备份的绝对路径")
    file: str = Field(default="", description="新备份的文件名")
    bytes: int = Field(default=0, description="新备份大小（字节）")


class DataRestoreRequest(BaseModel):
    """从导出包恢复：只接受本机路径（主进程的文件选择框给出的那个）。"""

    path: str = Field(description="数据包（zip）的绝对路径")


class DataRestoreResponse(BaseModel):
    """一次恢复的暂存结果；真正替换发生在下次 sidecar 启动时。"""

    archive: str = Field(description="数据包绝对路径")
    db_bytes: int = Field(description="包里的 memories.db 解压后大小（字节）")
    pending_path: str = Field(description="暂存位置；重启引擎时会替换到记忆库路径")
    entries: list[str] = Field(default_factory=list, description="包内全部条目")
    restart_required: bool = Field(
        default=True, description="是否要重启引擎才生效（当前实现总是 true）"
    )
