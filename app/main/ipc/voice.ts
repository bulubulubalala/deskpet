/**
 * 文件职责：语音输入侧的五件事——麦克风状态、系统设置入口、原生采集、WS 上行、打断。
 *
 * 为什么单独一个文件：语音的业务语义（什么时候算「在听」、什么时候出字）已经在 sidecar 的
 * WS 流水线里（D1），主进程这边只剩「把渲染层报到的事实转给谁」，正好是一个小模块。
 * 依赖方向：ipc/* -> 本文件 -> voice-socket / native-mic / media-permissions；不碰 sidecar 客户端。
 */
import { shell } from "electron";

import {
  IPC_CHANNELS,
  type NativeMicStartResponse,
  type VoiceAudioChunk,
  type VoiceBeginRequest,
  type VoiceEndRequest,
} from "../../shared/contracts/ipc";
import { microphoneAccessStatus } from "../media-permissions";
import type { IpcRegistry } from "../ipc-registry";
import type { IpcHandlerDeps } from "./deps";

export function registerVoiceHandlers(registry: IpcRegistry, deps: IpcHandlerDeps): void {
  // 语音全双工（P2）：渲染层只报「开始 / 音频块 / 说完 / 打断」，其余都交给 sidecar 的 WS 流水线
  registry.handle(IPC_CHANNELS.voiceMicStatus, () => ({
    status: microphoneAccessStatus(),
  }));

  registry.handle(IPC_CHANNELS.voiceOpenMicSettings, async (): Promise<void> => {
    await shell.openExternal("ms-settings:privacy-microphone");
  });

  registry.handle(IPC_CHANNELS.voiceOpenSoundSettings, async (): Promise<void> => {
    await shell.openExternal("ms-settings:sound");
  });

  registry.handle(IPC_CHANNELS.voiceNativeStart, async (): Promise<NativeMicStartResponse> => {
    if (deps.nativeMic === null) {
      return { ok: false, error: "原生麦克风未装配" };
    }
    return deps.nativeMic.start();
  });

  registry.handle(IPC_CHANNELS.voiceNativeStop, async (): Promise<void> => {
    await deps.nativeMic?.stop();
  });

  registry.on(IPC_CHANNELS.voiceBegin, (_event, request: VoiceBeginRequest): void => {
    if (deps.turn.getMode() !== "voice") {
      return;
    }
    void (async (): Promise<void> => {
      await deps.turn.startVoice();
      deps.voiceSocket.begin(request);
    })();
  });

  registry.on(IPC_CHANNELS.voiceAudio, (_event, chunk: VoiceAudioChunk): void => {
    if (deps.turn.getMode() !== "voice") {
      return;
    }
    deps.voiceSocket.sendAudio(chunk.pcm);
  });

  registry.on(IPC_CHANNELS.voiceEnd, (_event, request: VoiceEndRequest): void => {
    if (deps.turn.getMode() !== "voice") {
      return;
    }
    deps.voiceSocket.end(request);
  });

  registry.on(IPC_CHANNELS.voiceCancel, (): void => {
    // 状态由 sidecar 自己报（cancelling → idle），这里只发取消
    void deps.turn.cancelAll();
  });
}
