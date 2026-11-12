/**
 * 文件职责：界面自身的状态与窗口行为——形态读写、设置窗 / 陪伴窗入口、指针与尺寸、拖动、最小化。
 *
 * 为什么单独一个文件：这些都是「renderer 报事实、main 做决定」的通道（§6.11 / T2.2），
 * 语义只有一条：把界面状态收敛到 ui-controller 这一份。和业务域没有耦合。
 * 依赖方向：ipc/* -> 本文件 -> ui-controller；不直接碰 BrowserWindow。
 */
import {
  IPC_CHANNELS,
  type SettingsOpenRequest,
  type UiCursorTrackMessage,
  type UiDragMessage,
  type UiMetricsMessage,
  type UiPointerMessage,
  type UiStatePatch,
  type UiStatePayload,
} from "../../shared/contracts/ipc";
import type { IpcRegistry } from "../ipc-registry";
import type { IpcContext } from "./context";
import type { IpcHandlerDeps } from "./deps";

export function registerUiHandlers(
  registry: IpcRegistry,
  deps: IpcHandlerDeps,
  ctx: IpcContext,
): void {
  // 界面形态（T1.12a）：状态存在主进程，主窗与设置窗都从同一份读
  registry.handle(IPC_CHANNELS.uiGetState, (): UiStatePayload => deps.ui.getState());

  registry.handle(
    IPC_CHANNELS.uiSetState,
    async (_event, patch: UiStatePatch): Promise<UiStatePayload> => {
      const before = deps.ui.getState();
      const next = await deps.ui.setState(patch);
      // 语音输出开关同时作用于主进程的合成链（文字聊天走这里；语音轮由 WS 自己带过去）
      if (typeof patch.tts_enabled === "boolean") {
        deps.chatTurns.setTtsEnabled(patch.tts_enabled);
        if (before.tts_enabled !== patch.tts_enabled) {
          ctx.recordActivity(patch.tts_enabled ? "用户打开了语音输出。" : "用户关闭了语音输出。");
        }
      }
      if (
        typeof patch.always_on_top === "boolean" &&
        before.always_on_top !== patch.always_on_top
      ) {
        ctx.recordActivity(
          patch.always_on_top ? "用户把窗口设为置顶。" : "用户把窗口设为只在桌面显示。",
        );
      }
      if (
        patch.char_id !== undefined &&
        patch.char_id !== null &&
        before.char_id !== next.char_id
      ) {
        ctx.recordActivity("用户切换了角色。");
      }
      return next;
    },
  );

  registry.handle(IPC_CHANNELS.settingsOpen, (_event, request: SettingsOpenRequest = {}): void => {
    ctx.recordActivity("用户打开了设置。");
    deps.ui.openSettings(request.pane);
  });

  registry.handle(IPC_CHANNELS.companionOpen, (): void => {
    ctx.recordActivity("用户打开了主动陪伴设置。");
    deps.openCompanion();
  });

  // 指针进出一律走单向消息：renderer 只报事实，开关穿透由主进程决定（§6.11）
  registry.on(IPC_CHANNELS.uiPointer, (_event, message: UiPointerMessage): void => {
    deps.ui.setPointerInside(message.inside);
  });

  // 立绘包围盒与聊天条高度同样是「renderer 报事实、main 决定窗口」：尺寸 = 素材包围盒 × 缩放 + 聊天条
  registry.on(IPC_CHANNELS.uiMetrics, (_event, message: UiMetricsMessage): void => {
    deps.ui.noteMetrics(message);
  });

  // 全桌面鼠标追踪（T2.27）：渲染层只在 Live2D 舞台存在时打开；PNG 回退 / 舞台销毁时关闭。
  registry.on(IPC_CHANNELS.uiCursorTrack, (_event, message: UiCursorTrackMessage): void => {
    deps.setCursorTracking(message.enabled === true);
  });

  // JS 拖动同样是「renderer 报事实」：它只报开始 / 结束，位置由 main 读系统光标算（T2.2）
  registry.on(IPC_CHANNELS.uiMinimize, (): void => {
    ctx.recordActivity("用户把主窗收进了托盘。");
    deps.ui.minimize();
  });

  registry.on(IPC_CHANNELS.uiDrag, (_event, message: UiDragMessage): void => {
    if (message.action === "end") {
      deps.ui.endDrag();
      return;
    }
    deps.ui.beginDrag();
  });
}
