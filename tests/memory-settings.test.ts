/**
 * 文件职责：单测 app/main/memory-settings.ts —— 行为记忆总开关的 .env 映射（T2.1c）。
 *
 * 为什么值得单独测：开关的默认值必须与 sidecar/config.py 的 _bool_flag 完全一致。
 * 这里一旦把「没配」读成关，用户第一次打开设置窗看到的就是「行为记忆已关闭」，
 * 而实际运行里它是开的——界面上说的和引擎做的对不上，是最难排查的一类问题。
 * 依赖方向：tests -> app/main/memory-settings.ts（不 import electron、不碰磁盘）。
 */
import { describe, expect, it } from "vitest";

import {
  behaviorEnvUpdate,
  MEMORY_BEHAVIOR_KEY,
  parseBehaviorEnabled,
} from "../app/main/memory-settings";

describe("parseBehaviorEnabled", () => {
  it("键不存在或为空串时按 sidecar 的默认值当成开着", () => {
    expect(MEMORY_BEHAVIOR_KEY).toBe("DESKPET_MEMORY_BEHAVIOR_ENABLED");
    expect(parseBehaviorEnabled({})).toBe(true);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "" })).toBe(true);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "   " })).toBe(true);
  });

  it("真写法的四种拼写都算开", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: value })).toBe(true);
    }
  });

  it("假写法的四种拼写都算关", () => {
    for (const value of ["0", "false", "no", "off"]) {
      expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: value })).toBe(false);
    }
  });

  it("大小写与首尾空白不影响判断", () => {
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "  FALSE " })).toBe(false);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "On" })).toBe(true);
  });

  it("非法值不在这里报错，退回默认值", () => {
    // sidecar 启动时 _bool_flag 会直接抛错；界面上再报一次只会把用户绕晕
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "也许" })).toBe(true);
    expect(parseBehaviorEnabled({ [MEMORY_BEHAVIOR_KEY]: "2" })).toBe(true);
  });
});

describe("behaviorEnvUpdate", () => {
  it("写回 true / false 两个词，不写 1 / 0", () => {
    expect(behaviorEnvUpdate(true)).toEqual({ [MEMORY_BEHAVIOR_KEY]: "true" });
    expect(behaviorEnvUpdate(false)).toEqual({ [MEMORY_BEHAVIOR_KEY]: "false" });
  });

  it("写回的值能被自己读回来（往返一致）", () => {
    const enabled = parseBehaviorEnabled(behaviorEnvUpdate(true));
    const disabled = parseBehaviorEnabled(behaviorEnvUpdate(false));
    expect(enabled).toBe(true);
    expect(disabled).toBe(false);
  });
});
