/**
 * 文件职责：通过 contextBridge 把 DeskpetApi 挂到 window.deskpet（需求 §6.10）。
 *
 * 为什么只暴露这一层：contextIsolation 打开时渲染层拿不到 ipcRenderer，
 * 白名单方法必须在这里显式转发，渲染层无法自己拼 channel 名去 invoke 别的接口。
 * 依赖方向：preload -> electron（contextBridge / ipcRenderer）+ ./api（类型）+ ../main/ipc（通道常量）。
 * 谁调用：Electron 在页面加载前自动执行（webPreferences.preload 指向打包后的 dist/preload/index.js）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { HealthView } from "../main/engine";
import { IPC_CHANNELS, type AppInfo } from "../main/ipc";
import type { DeskpetApi } from "./api";

const api: DeskpetApi = {
  health: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.healthGet) as Promise<HealthView>,
    onChanged: (listener) => {
      const wrapped = (_event: IpcRendererEvent, view: HealthView): void => {
        listener(view);
      };
      ipcRenderer.on(IPC_CHANNELS.healthChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.healthChanged, wrapped);
      };
    },
  },
  sidecar: {
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.sidecarRestart) as Promise<HealthView>,
  },
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo) as Promise<AppInfo>,
  },
};

contextBridge.exposeInMainWorld("deskpet", api);
