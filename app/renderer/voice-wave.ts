/**
 * 文件职责：语音模式下那排电平柱——把麦克风 RMS 画成高度。
 *
 * 为什么单独一个文件：这纯粹是展示，输入来自音频层回调（每秒几十次），
 * 用 requestAnimationFrame 合并更新；留在入口文件里只会让它继续变胖。
 * 依赖方向：renderer/voice-wave -> renderer/dom；不碰 IPC、不碰音频设备。
 */
import { byId } from "./dom";

/** 语音面板的柱子数量；只在 voice 模式显示。 */
const VOICE_WAVE_BARS = 12;

let voiceWaveLevel = 0;
let voiceWaveFrame: number | null = null;

export function initVoiceWave(): void {
  const wave = byId("voice-wave");
  if (wave === null) {
    return;
  }
  wave.replaceChildren();
  for (let i = 0; i < VOICE_WAVE_BARS; i += 1) {
    const bar = document.createElement("span");
    bar.style.transform = "scaleY(0.18)";
    wave.append(bar);
  }
}

/** 把麦克风 RMS 映射成波形柱高；用 rAF 合并 native 的高频回调。 */
export function updateVoiceWave(level: number): void {
  voiceWaveLevel = Number.isFinite(level) ? Math.max(0, level) : 0;
  if (voiceWaveFrame !== null) {
    return;
  }
  voiceWaveFrame = window.requestAnimationFrame(() => {
    voiceWaveFrame = null;
    const wave = byId("voice-wave");
    if (wave === null || wave.hidden) {
      return;
    }
    const normalized = Math.min(1, voiceWaveLevel / 0.12);
    const bars = wave.children;
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      if (!(bar instanceof HTMLElement)) {
        continue;
      }
      const shape = 0.35 + 0.65 * Math.abs(Math.sin((i + 1) * 1.7));
      const scale = 0.18 + normalized * shape;
      bar.style.transform = "scaleY(" + scale.toFixed(3) + ")";
    }
  });
}
