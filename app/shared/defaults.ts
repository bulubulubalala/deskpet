/**
 * 文件职责：主进程与渲染进程都要读的「共享常量」（D2 契约单一权威的第一步）。
 *
 * 为什么单独一个目录：这些值原本写在 app/main/ipc.ts 里，渲染层只能 import 主进程实现文件才能拿到，
 * 于是 esbuild 会把 ipc.ts 的模块体一起打进渲染层包——分层边界从「物理上」就被破坏了。
 * 现在共享值放这里：两边都 import 它，ipc.ts 只是再导出一次以保持旧路径可用。
 *
 * 依赖方向：app/shared 不 import electron、node 内置模块与任何 app/main、app/renderer 代码。
 */

/**
 * 渲染帧率档位（T2.43）：Live2D 舞台每秒最多重绘几次。
 *
 * 为什么是离散档位：用户实际只需要「省电 / 平衡 / 顺滑」几档，固定档位也好写测试与文档；
 * 120 只在支持高刷的屏幕上才有意义（普通屏会被 ticker 按显示器刷新率压回去）。
 */
export const UI_FPS_OPTIONS = [15, 30, 45, 60, 120] as const;
export type UiFps = (typeof UI_FPS_OPTIONS)[number];

/** 默认档位：与 T2.43 引入设置之前的手感一致（空闲 30、交互 60）。 */
export const UI_FPS_DEFAULT: UiFps = 60;

/** 供给来源：本地引擎、云端接口或 edge 在线合成（§6.13 的双轨 + T2.4 的 edge-tts）。 */
export const PROVIDER_VALUES = ["cloud", "local", "edge"] as const;
export type ProviderValue = (typeof PROVIDER_VALUES)[number];
