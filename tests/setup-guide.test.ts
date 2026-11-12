import { describe, expect, it } from "vitest";

import { describeSetupHint, SETUP_PANE } from "../app/renderer/setup-guide";

/** 造一份最小的心跳视图；providers 省略表示 sidecar 还没报供给。 */
function view(
  state: string,
  providers?: readonly { capability: string; configured: boolean; name?: string }[],
): { state: string; providers?: readonly { capability: string; configured: boolean }[] } {
  return providers === undefined ? { state } : { state, providers };
}

describe("describeSetupHint", () => {
  it("引擎没上线时不抢横幅（失败原因优先）", () => {
    expect(
      describeSetupHint(view("failed", [{ capability: "llm", configured: false }])),
    ).toBeNull();
    expect(describeSetupHint(view("starting"))).toBeNull();
  });

  it("模型已配好就不再烦人", () => {
    expect(describeSetupHint(view("online", [{ capability: "llm", configured: true }]))).toBeNull();
  });

  it("心跳里没有供给条目时给通用引导", () => {
    const text = describeSetupHint(view("online"));
    expect(text).toContain("还没配置对话模型");
    expect(text).toContain("保存后立刻生效");
  });

  it("只有 ASR/TTS 缺时不提示（不配也能打字）", () => {
    expect(
      describeSetupHint(
        view("online", [
          { capability: "llm", configured: true },
          { capability: "asr", configured: false },
          { capability: "tts", configured: false },
        ]),
      ),
    ).toBeNull();
  });

  it("llm 未配好时带上供给方名字", () => {
    const text = describeSetupHint(
      view("online", [{ capability: "llm", configured: false, name: "cloud" }]),
    );
    expect(text).toContain("「cloud」");
    expect(text).toContain("补齐地址与 Key");
  });

  it("供给方名字是空白时退回通用说法", () => {
    const text = describeSetupHint(
      view("online", [{ capability: "llm", configured: false, name: "  " }]),
    );
    expect(text).toBe("对话模型还没配好。点这里补齐地址与 Key，保存后立刻生效。");
  });

  it("供给条目连名字字段都没有时也不崩", () => {
    const text = describeSetupHint(view("online", [{ capability: "llm", configured: false }]));
    expect(text).toBe("对话模型还没配好。点这里补齐地址与 Key，保存后立刻生效。");
  });

  it("引导落在模型供给页", () => {
    expect(SETUP_PANE).toBe("providers");
  });
});
