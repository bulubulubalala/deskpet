/**
 * 文件职责：定义 window.deskpet 的形状（renderer 能看到的全部能力）。
 *
 * 为什么单独一个文件：这是渲染层与主进程之间的类型契约；renderer 只 import 这里的类型，
 * 具体实现留在 index.ts（contextBridge 只能在那里调用）。
 * 依赖方向：preload -> ../main/ipc（通道常量）与 ../main/engine（只 import type，编译后不留代码）。
 */
import type { HealthView } from "../main/engine";
import type { AppInfo } from "../main/ipc";

/** 暴露给渲染层的 API；字段名与 ipc.ts 的通道一一对应。 */
export interface DeskpetApi {
  readonly health: {
    /** 主动拉一次心跳快照（界面刚加载时用）。 */
    get(): Promise<HealthView>;
    /** 订阅心跳推送；返回值是退订函数。 */
    onChanged(listener: (view: HealthView) => void): () => void;
  };
  readonly sidecar: {
    /** 手动重启 sidecar（不替用户修语音引擎，D14）。 */
    restart(): Promise<HealthView>;
  };
  readonly app: {
    getInfo(): Promise<AppInfo>;
  };
}
