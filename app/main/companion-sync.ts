/**
 * 文件职责：把「陪伴设置」翻译成两个副作用——屏幕观察的启停，以及观察结果怎么进记忆与在场快照。
 *
 * 为什么单独一个文件：这块逻辑原来嵌在 bootstrap 里，靠 ui / presenceReporter / sidecarClient
 * 三个单例互相 catch，一改设置就可能只改到一半；抽出来以后输入是「一次设置快照」，输出是明确的
 * 几个后端调用，屏幕观察与记忆写入的节流规则也能脱库单测。
 * 依赖方向：main/* -> 本文件 -> ScreenWatcher + 后端接口（由调用方注入）；本文件不 import electron。
 */
import type { ActivityLog } from "./activity-log";
import type { MainLogger } from "./logger";
import { ScreenWatcher, type CapturedFrame, type ScreenObservation } from "./screen-watcher";
import type { CompanionSettings, UiStatePayload } from "../shared/contracts/ipc";

/** 屏幕相关的后端能力：只声明用得到的三个方法，方便测试塞假实现。 */
export interface ScreenObserverBackend {
  ocrScreen(
    image: Buffer,
    appTitle: string,
  ): Promise<{ readonly text: string; readonly confidence: number; readonly engine: string }>;
  captureScreen(
    image: Buffer,
    appTitle: string,
    capturedAt: string,
    model: string,
  ): Promise<ScreenObservation>;
  writeScreenMemory(charId: string, text: string): Promise<boolean>;
}

/** 在场快照的接收方（PresenceReporter）；只用到这两个方法。 */
export interface PresenceSink {
  setScreenObservation(text: string): void;
  report(): Promise<void>;
}

export interface CompanionSyncDeps {
  readonly activity: ActivityLog;
  readonly client: ScreenObserverBackend;
  /** 读当前设置快照；窗口还没建好时返回 undefined。 */
  readonly readState: () => UiStatePayload | undefined;
  /** 在场上报器可能在启动后期才建好，所以用取值函数而不是实例。 */
  readonly presence: () => PresenceSink | null;
  readonly logger: MainLogger;
  readonly capture: () => Promise<CapturedFrame | null>;
  /** 注入时钟，便于测试；默认 Date.now。 */
  readonly now?: () => number;
  /** 同一条观察结果写进记忆的最小间隔，默认 60 秒。 */
  readonly memoryCooldownMs?: number;
  /** OCR 失败后多久不再尝试（期间直接用视觉摘要），默认 5 分钟。 */
  readonly ocrCooldownMs?: number;
}

export interface CompanionSync {
  /** 设置变化时调用（UiController.onStateChanged 也接在这里）。 */
  sync(state: UiStatePayload): void;
  /** 单独看一眼某一帧（截屏热键用），与定时观察走同一套 OCR/摘要降级。 */
  observe(frame: CapturedFrame): Promise<ScreenObservation>;
  /** 退出时停掉定时器。 */
  stop(): void;
}

const DEFAULT_MEMORY_COOLDOWN_MS = 60_000;
const DEFAULT_OCR_COOLDOWN_MS = 5 * 60_000;

export function createCompanionSync(deps: CompanionSyncDeps): CompanionSync {
  let screenWatcher: ScreenWatcher | null = null;
  let lastCompanion: CompanionSettings | null = null;
  let lastMemoryAt = 0;
  let lastMemorySummary = "";
  let ocrUnavailableUntil = 0;
  const now = deps.now ?? Date.now;
  const memoryCooldownMs = deps.memoryCooldownMs ?? DEFAULT_MEMORY_COOLDOWN_MS;
  const ocrCooldownMs = deps.ocrCooldownMs ?? DEFAULT_OCR_COOLDOWN_MS;

  /** 优先本地 OCR（不出网）；OCR 挂了就退回视觉摘要，并记下冷却时间避免每轮都失败一次。 */
  const observeScreenFrame = async (frame: CapturedFrame): Promise<ScreenObservation> => {
    const companion = deps.readState()?.companion;
    if (companion?.ocr_enabled === true && now() >= ocrUnavailableUntil) {
      try {
        const ocr = await deps.client.ocrScreen(frame.jpeg, frame.appTitle);
        return {
          summary: ocr.text,
          interesting: ocr.text.trim() !== "",
          confidence: ocr.confidence,
          visionModel: ocr.engine,
          capturedAt: new Date().toISOString(),
        };
      } catch (error: unknown) {
        ocrUnavailableUntil = now() + ocrCooldownMs;
        deps.logger.warn("screen.ocr_failed", "本地 OCR 不可用，先退回视觉摘要", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return await deps.client.captureScreen(
      frame.jpeg,
      frame.appTitle,
      new Date().toISOString(),
      deps.readState()?.companion.vision_model ?? "",
    );
  };

  const sync = (state: UiStatePayload): void => {
    const companion = state.companion;
    const previous = lastCompanion;
    if (previous === null || previous.enabled !== companion.enabled) {
      if (previous !== null) {
        deps.activity.clear();
        deps.activity.record(
          companion.enabled ? "用户重新开启了主动陪伴。" : "用户关闭了主动陪伴，希望暂时不被打扰。",
        );
      }
    } else if (!companion.enabled) {
      const labels: readonly (readonly [keyof CompanionSettings, string])[] = [
        ["screen_enabled", "屏幕观察"],
        ["proactive_enabled", "主动开口"],
        ["observe_memory", "观察记忆"],
        ["app_activity_enabled", "应用动态"],
      ];
      for (const [key, label] of labels) {
        if (previous[key] !== companion[key]) {
          deps.activity.record(
            "用户" + (companion[key] === true ? "重新允许了" : "关闭了") + label + "。",
          );
        }
      }
    }
    lastCompanion = companion;
    // 屏幕观察要两个开关同时为真：用户允许看屏幕 + 明确同意过（同意是显式的，退出即失效）
    const shouldWatch = companion.screen_enabled && companion.vision_consented;
    if (!shouldWatch) {
      screenWatcher?.stop();
      return;
    }
    if (screenWatcher === null) {
      screenWatcher = new ScreenWatcher({
        capture: deps.capture,
        observe: observeScreenFrame,
        enabled: () => {
          const current = deps.readState()?.companion;
          return current !== undefined && current.screen_enabled && current.vision_consented;
        },
        intervalMs: () => (deps.readState()?.companion.screen_interval_s ?? 5) * 1000,
        onObservation: (observation) => {
          const current = deps.readState();
          if (current === undefined || !current.companion.screen_enabled) {
            return;
          }
          const charId = current.char_id ?? "";
          if (
            current.companion.observe_memory &&
            charId !== "" &&
            observation.summary !== lastMemorySummary &&
            now() - lastMemoryAt > memoryCooldownMs
          ) {
            lastMemoryAt = now();
            lastMemorySummary = observation.summary;
            void deps.client
              .writeScreenMemory(charId, observation.summary)
              .catch((error: unknown) => {
                deps.logger.debug(
                  "screen.memory_failed",
                  "屏幕观察没能写入记忆：" +
                    (error instanceof Error ? error.message : String(error)),
                );
              });
          }
          if (observation.summary.trim() !== "") {
            const presence = deps.presence();
            presence?.setScreenObservation(observation.summary);
            void presence?.report();
          }
        },
        onError: (error) => {
          deps.logger.warn(
            "screen.observe_failed",
            "屏幕识图失败，下一轮继续尝试：" +
              (error instanceof Error ? error.message : String(error)),
          );
        },
        logger: deps.logger,
      });
    }
    screenWatcher.start();
  };

  return {
    sync,
    observe: observeScreenFrame,
    stop: () => {
      screenWatcher?.stop();
      screenWatcher = null;
    },
  };
}
