/**
 * 文件职责：聊天两条通道（发送 / 取消）。
 *
 * 为什么单独一个文件：聊天是「主进程只做转发」的典型，语义都在 chat-turns；
 * 这里只保留模式检查这件必须发生在入口的事（抢话筒由 chatTurns.send 内部完成）。
 */
import {
  IPC_CHANNELS,
  type ChatCancelResponse,
  type ChatSendRequest,
  type ChatSendResponse,
} from "../../shared/contracts/ipc";
import type { IpcRegistry } from "../ipc-registry";
import type { IpcHandlerDeps } from "./deps";

export function registerChatHandlers(registry: IpcRegistry, deps: IpcHandlerDeps): void {
  registry.handle(
    IPC_CHANNELS.chatSend,
    async (_event, request: ChatSendRequest): Promise<ChatSendResponse> => {
      if (deps.turn.getMode() !== "text") {
        return {
          accepted: false,
          session_id: request.session_id,
          reason: "当前不是文字模式；先切到「文字」再发送",
        };
      }
      // chatTurns.send 内部会先 cancel 旧轮（T2.6：文字发送与语音开口一样可以抢话筒）
      return await deps.chatTurns.send({
        ...request,
        app_context: deps.activity.recent(),
      });
    },
  );

  registry.handle(IPC_CHANNELS.chatCancel, async (): Promise<ChatCancelResponse> => {
    const active = deps.turn.isBusy();
    await deps.turn.cancelAll();
    return active ? { cancelled: true } : { cancelled: false, reason: "当前没有进行中的回复" };
  });
}
