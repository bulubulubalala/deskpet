/**
 * 文件职责：把字节数写成人看的大小（1.5 MiB 这种）。
 *
 * 为什么单独一个文件：它是最典型的「纯展示逻辑」，却能顺手把整个 electron 拖进单测；
 * 放在这里之后测试不用 import electron（那个包在 node 里会尝试下载二进制）。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "（大小未知）";
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  }
  if (bytes >= 1024) {
    return Math.round(bytes / 1024) + " KiB";
  }
  return bytes + " B";
}
