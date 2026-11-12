# deskpet vX.Y.Z 发布说明

> 模板：每个版本的 release 都复制一份成 `docs/RELEASE_vX.Y.Z.md`，与 CHANGELOG 的对应小节保持一致。
> 正文只写用户能感知的变化；「为什么」写在 CHANGELOG 里，不重复。

## 下载

- `deskpet-X.Y.Z-x64.zip`（便携包，解压即用；本地自签名，首次运行仍会有 SmartScreen 提示）
- `SHA256SUMS.txt`（下载后先比对：`certutil -hashfile deskpet-X.Y.Z-x64.zip SHA256`）
- `deskpet-X.Y.Z-release.json`（构建时间、提交、各文件大小与哈希，排查问题用）
- `deskpet-X.Y.Z-x64.zip` 已用本地自签名证书签名，指纹：`<填写 pnpm sign:win 打印的指纹>`

## 这一版最重要的三件事

1.
2.
3.

## 新增

-

## 改进

-

## 修复

-

## 升级须知

- 退出 deskpet 后解压覆盖；数据默认在 `%APPDATA%\deskpet\data`，不受影响。
- 便携模式（exe 同级有 `portable.txt`）：保留 `portable.txt`、`data/`、`characters/`，只覆盖程序文件。
- 升级前建议先「导出数据包…」；出问题可在设置窗「记忆 → 备份与迁移 → 从数据包恢复…」换回来。
- 记忆库结构升级时会自动留底到 `data\backups\memories-pre-v<旧版本>-<时间>.db`。

## 已知问题

-
