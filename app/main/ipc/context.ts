/**
 * 文件职责：IPC 各域模块共用的三件小事——往渲染层推送、记「用户做了什么」、广播角色变更。
 *
 * 为什么单独一个文件：这三件事原本是 registerIpcHandlers 里的三个闭包，被触摸、界面、
 * 角色包、开发者模式几块共用。拆完模块后它们不能再定义在组合根里（否则每个域都要多传两个参数），
 * 所以抽成一个上下文对象，由组合根创建一次发给各模块。
 * 依赖方向：ipc/* -> 本文件 -> electron + 契约；不反向依赖任何域模块。
 */
import { BrowserWindow } from "electron";

import { IPC_CHANNELS, type CharactersChangedMessage } from "../../shared/contracts/ipc";
import type { IpcHandlerDeps } from "./deps";

/**
 * 生成「推给渲染层」的函数；窗口没了就静默丢弃。
 * 单独导出是因为会话编排（T1.6b）也要推事件与音频，而它不持有 ipcMain。
 */
export function rendererPusher(
  getWindow: () => BrowserWindow | null,
): (channel: string, payload: unknown) => void {
  return (channel, payload) => {
    const window = getWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    window.webContents.send(channel, payload);
  };
}

export interface IpcContext {
  /** 往主窗推一条单向消息。 */
  readonly push: (channel: string, payload: unknown) => void;
  /** 只有在主动陪伴或活动记录开关打开时才落盘（避免用户没开还给他记流水账）。 */
  readonly recordActivity: (text: string) => void;
  /** characters/ 变了：所有窗口都要刷新（角色菜单 / 设置窗下拉 / 当前角色 hits）。 */
  readonly broadcastCharactersChanged: (charId: string) => void;
}

export function createIpcContext(deps: IpcHandlerDeps): IpcContext {
  const push = rendererPusher(deps.getWindow);
  const recordActivity = (text: string): void => {
    const companion = deps.ui.getState().companion;
    if (companion.enabled || companion.app_activity_enabled) {
      deps.activity.record(text);
    }
  };
  const broadcastCharactersChanged = (charId: string): void => {
    const message: CharactersChangedMessage = { char_id: charId };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.charactersChanged, message);
      }
    }
  };
  return { push, recordActivity, broadcastCharactersChanged };
}
