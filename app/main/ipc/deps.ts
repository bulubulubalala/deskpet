/**
 * 文件职责：IPC 各域模块共享的依赖清单（registerIpcHandlers 的入参形状）。
 *
 * 为什么单独一个文件：拆成 app/main/ipc/* 之后，每个域模块都要声明「我需要什么」。
 * 依赖清单只放这一处，组合根与各模块看到的是同一份，不会各自复制一份再慢慢漂移。
 * 依赖方向：ipc/*（各域）与 ipc-handlers（组合根）-> 本文件；本文件只 import 类型，不产生运行时依赖。
 */
import type { BrowserWindow } from "electron";

import type { PackOpenEditorRequest } from "../../shared/contracts/ipc";
import type { ActivityLog } from "../activity-log";
import type { ChatTurns } from "../chat-turns";
import type { SidecarEngine } from "../engine";
import type { MainLogger } from "../logger";
import type { ModelManager } from "../model-manager";
import type { NativeMicCapture } from "../native-mic";
import type { SettingsStore } from "../settings-store";
import type { SidecarClient } from "../sidecar-client";
import type { TurnCoordinator } from "../turn-coordinator";
import type { UpdateChecker } from "../update-check";
import type { UiController } from "../ui-controller";
import type { VoiceSocketClient } from "../voice-socket";

export interface IpcHandlerDeps {
  readonly engine: SidecarEngine;
  /** 文字轮：把一句话发进 /ws/voice，并把 sidecar 的事件翻成 chatEvent（D1 第二期）。 */
  readonly chatTurns: ChatTurns;
  /** 语音 / 文字 / 触摸共用的单一话筒（T2.6）：模式、phase、取消都从这里过。 */
  readonly turn: TurnCoordinator;
  readonly ui: UiController;
  readonly logger: MainLogger;
  /** 供给探测要打到 sidecar /providers/test；端点由心跳同步（T1.14b）。 */
  readonly client: SidecarClient;
  /** 语音全双工长连接（P2）：音频上行 / 事件下行都经它。 */
  readonly voiceSocket: VoiceSocketClient;
  /** Chromium 麦克风不可用时，由 sidecar helper 做 Windows 原生采集。 */
  readonly nativeMic: NativeMicCapture | null;
  /** characters/ 根目录：立绘与 hits.json 都从这里读（T2.3-C2）。 */
  readonly charactersDir: string;
  /** 数据目录（data/）：备份在它的 backups/ 子目录里，界面可让用户在资源管理器里打开。 */
  readonly dataDir: string;
  /** 设置仓库（data/settings.json）：配置的唯一真相源；密钥只在这条链路上流动，永不回传渲染层。 */
  readonly settings: SettingsStore;
  /** 开发者模式开关的落盘路径（data/dev.json，T2.3-B1）；只控制界面显隐，不是安全边界。 */
  readonly devFile: string;
  /** 打开角色包编辑器窗口（T2.3-D）；mode=edit 时只编辑当前角色的部位（T2.5）。 */
  readonly openCompanion: () => void;
  readonly activity: ActivityLog;
  readonly models: ModelManager;
  readonly openPackEditor: (request: PackOpenEditorRequest) => void;
  /** 推送用；窗口可能不存在或正在关闭，取到的可能是 null 或已销毁的实例。 */
  readonly getWindow: () => BrowserWindow | null;
  /** 开关全桌面鼠标追踪（T2.27）：只有 Live2D 舞台存在时渲染层才会打开。 */
  readonly setCursorTracking: (enabled: boolean) => void;
  /** 手动「检查更新」：只在用户点按钮时问一次远端（D6）。 */
  readonly updates: UpdateChecker;
}
