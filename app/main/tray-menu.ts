/**
 * 文件职责：托盘图标与右键菜单（显示 / 位置重置 / 设置 / 目录 / 诊断 / 导出 / 重启引擎 / 退出）。
 *
 * 为什么单独一个文件：菜单是「窗口没了也还能用」的唯一入口，属于产品界面而不是启动装配；
 * 菜单项该干什么由调用方注入，这里不直接碰 ui / engine / quitting 这些单例。
 * 依赖方向：main/* -> 本文件 -> electron；本文件不 import 应用服务（只 import 路径与日志类型）。
 */
import { Menu, Tray, nativeImage } from "electron";

import { trayIconPath } from "./app-paths";
import type { MainLogger } from "./logger";

export interface TrayActions {
  readonly showWindow: () => void;
  readonly minimizeWindow: () => void;
  readonly resetPosition: () => void;
  readonly openSettings: () => void;
  /** 用系统资源管理器打开某个目录（失败只记日志）。 */
  readonly openPath: (dir: string) => void;
  readonly copyDiagnostics: () => void;
  readonly exportData: () => void;
  readonly restartEngine: () => void;
  /** 先把「正在退出」标记置上，再 app.quit()；否则关闭窗口会被拦成隐藏。 */
  readonly quit: () => void;
}

export function createTray(
  paths: { readonly dataDir: string; readonly logsDir: string },
  actions: TrayActions,
  logger: MainLogger | null,
): Tray {
  const image = nativeImage.createFromPath(trayIconPath());
  if (image.isEmpty()) {
    logger?.warn("tray.icon_missing", "托盘图标加载失败：" + trayIconPath());
  }
  // 通知区图标显式缩到 16×16：素材是 128×128 的占位图，交给系统缩会糊（T2.2）
  const instance = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }));
  instance.setToolTip("deskpet（右键：显示 / 位置重置 / 设置 / 退出）");
  instance.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主界面", click: actions.showWindow },
      { label: "最小化窗口", click: actions.minimizeWindow },
      {
        label: "位置重置到屏幕中央",
        click: () => {
          actions.resetPosition();
          actions.showWindow();
        },
      },
      { label: "打开设置", click: actions.openSettings },
      // 出问题时用户（和朋友）要能把现场交出来：以前日志与数据目录只能自己去资源管理器翻
      { label: "打开数据目录", click: () => actions.openPath(paths.dataDir) },
      { label: "打开日志目录", click: () => actions.openPath(paths.logsDir) },
      // 比“把日志目录发给对方”低一步：一段文字能直接贴进聊天窗口（M0 止血项）
      { label: "复制诊断信息", click: actions.copyDiagnostics },
      // 换机器 / 重装前先拿到自己的东西：记忆库快照 + 设置 + 角色一包带走（D9）
      { label: "导出数据包…", click: actions.exportData },
      { label: "重启后台引擎", click: actions.restartEngine },
      { type: "separator" },
      { label: "退出", click: actions.quit },
    ]),
  );
  instance.on("click", actions.showWindow);
  return instance;
}
