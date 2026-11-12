/**
 * 文件职责：IPC 注册表——所有通道都从这里进、从这里出（D2 的第一步）。
 *
 * 为什么需要它：v0.2.0 里每条通道都手工写 `ipcMain.handle(...)`，注销再手工抄一遍到
 * 清理闭包里。两张表靠人脑保持一致的结果是「漏了 6 条」——这类 bug 只在第二次打开设置窗
 * 时才现形，而且报错信息完全指不到原因。注册表把「注册」与「注销」变成同一个动作的两端：
 * 注册时登记，dispose 时按登记表摘掉，中间没有人工环节。
 *
 * 为什么依赖注入而不直接 import electron：注册逻辑要能单测（`tests/ipc-registry.test.ts`
 * 用假 ipcMain 跑），Electron 在 Node 里 import 进来就跑不起来。
 *
 * 依赖方向：main -> ./ipc-registry（本文件）；不 import electron 的运行时，只 import 类型。
 */

import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

import { ContractViolation, type Schema } from "../shared/contracts/validate";

/**
 * 处理函数签名。与 Electron 原生一致（第一个参数是 event，其余参数是 payload），
 * 这样从 `ipcMain.handle` 迁过来只改一个词，不用动每条通道的正文。
 *
 * 为什么用 `any[]` 而不是 `unknown[]`：Electron 自己的声明就是 `any[]`，改成 unknown
 * 会让「把 `ipcMain` 传给注册表」这一句类型不兼容，等于逼迫每个调用点插入断言。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventHandler = (event: IpcMainEvent, ...args: any[]) => void;

/** `ipcMain` 里本模块真正用到的那几个方法（便于测试替身）。 */
export interface IpcMainLike {
  handle(channel: string, listener: InvokeHandler): void;
  on(channel: string, listener: EventHandler): void;
  removeHandler(channel: string): void;
  removeAllListeners(channel: string): void;
}

/**
 * 通道注册表。
 *
 * 用法：
 * ```
 * const registry = new IpcRegistry(ipcMain);
 * registry.handle(IPC_CHANNELS.chatSend, async (_event, request: ChatSendRequest) => ...);
 * registry.on(IPC_CHANNELS.voiceAudio, (_event, chunk: VoiceAudioChunk) => ...);
 * return () => registry.dispose();
 * ```
 * 处理函数签名与 Electron 原生一致（第一个参数是 event），这样从 `ipcMain.handle` 迁移过来
 * 只改一个词，不用动每条通道的正文。
 */
export interface IpcRegistryOptions {
  /**
   * 通道 → 入参形状（见 app/shared/contracts/ipc-schemas.ts）。
   * 没登记形状的通道照旧放行：先把闸门建起来，覆盖范围再逐条补。
   */
  readonly schemas?: Readonly<Record<string, Schema<unknown>>>;
  /** 拒掉一次调用时的回调（组合根用来记一条 warn，含字段路径，便于定位是哪个界面传错了）。 */
  readonly onInvalidArgument?: (channel: string, error: ContractViolation) => void;
}

export class IpcRegistry {
  readonly #handlers = new Set<string>();
  readonly #listeners = new Set<string>();

  constructor(
    private readonly ipc: IpcMainLike,
    private readonly options: IpcRegistryOptions = {},
  ) {}

  /** 注册一个请求-响应通道（相当于 `ipcMain.handle`），入参先过一遍形状校验。 */
  handle(channel: string, listener: InvokeHandler): void {
    this.ipc.handle(channel, this.#checked(channel, listener));
    this.#handlers.add(channel);
  }

  /**
   * 包一层入参校验。
   *
   * 只在登记过形状的通道上生效；校验失败抛一条带字段路径的 Error（渲染层的 invoke 会把它
   * 原样包进 rejected promise），坏数据不会穿到查库 / 写盘那一层。
   */
  #checked(channel: string, listener: InvokeHandler): InvokeHandler {
    const schema = this.options.schemas?.[channel];
    if (schema === undefined) {
      return listener;
    }
    return (event, ...args) => {
      let input: unknown;
      try {
        input = schema.parse(args[0], "请求");
      } catch (error) {
        if (error instanceof ContractViolation) {
          this.options.onInvalidArgument?.(channel, error);
          throw new Error("参数不合法（" + channel + "）：" + error.message);
        }
        throw error;
      }
      return listener(event, input);
    };
  }

  /** 注册一个单向事件通道（相当于 `ipcMain.on`）。 */
  on(channel: string, listener: EventHandler): void {
    this.ipc.on(channel, listener);
    this.#listeners.add(channel);
  }

  /** 已注册的通道一览（测试与诊断用；顺带让「注册了什么」可被断言）。 */
  channels(): { handlers: string[]; listeners: string[] } {
    return { handlers: [...this.#handlers], listeners: [...this.#listeners] };
  }

  /**
   * 摘掉本注册表登记过的全部通道，可重复调用。
   *
   * 为什么按类型分开摘：`removeHandler` 摘不掉 `on` 的监听、`removeAllListeners` 会连
   * 本进程内部挂的其它监听一起清掉，混用是上一个版本的另一处隐患。
   */
  dispose(): void {
    for (const channel of this.#handlers) {
      this.ipc.removeHandler(channel);
    }
    for (const channel of this.#listeners) {
      this.ipc.removeAllListeners(channel);
    }
    this.#handlers.clear();
    this.#listeners.clear();
  }
}
