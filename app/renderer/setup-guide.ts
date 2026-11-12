/**
 * 文件职责：首次运行引导的「说什么」——判断桌宠现在缺哪一块配置，并给出一句能照着做的话（纯函数）。
 *
 * 为什么单独一个模块：判据来自心跳（providers[].configured），句子要能被单测钉住。
 * 放在 index.ts 里就只能靠真机手点，而这段文案正是新手第一次见到桌宠时唯一的路标。
 * 依赖方向：renderer 内部纯函数，不碰 DOM、不 import electron。
 * 谁调用：app/renderer/index.ts 的 renderSetupGuide。
 */

/** 心跳里的单条供给（与 app/main/ipc.ts 的 ProviderHealth 同构，这里只取用到的字段）。 */
export interface ProviderHealthLike {
  readonly capability: string;
  readonly configured: boolean;
  readonly name?: string;
  readonly detail?: string;
}

export interface SetupGuideView {
  readonly state: string;
  readonly providers?: readonly ProviderHealthLike[] | null;
}

/** 引导的目标页：模型供给（设置窗的 data-pane）。 */
export const SETUP_PANE = "providers";

/**
 * 该不该提示「还缺对话模型」。
 *
 * 只在引擎 online 时提示：引擎没起来时横幅被引擎失败原因占着，两个一起说等于什么都没说。
 * 只有 llm 这一面会打扰用户——ASR/TTS 是可选能力，不配也能打字聊天，缺了不该拦路。
 */
export function describeSetupHint(view: SetupGuideView): string | null {
  if (view.state !== "online") {
    return null;
  }
  const providers = view.providers ?? [];
  const llm = providers.find((provider) => provider.capability === "llm");
  if (llm === undefined) {
    return "还没配置对话模型，桌宠现在只会说预设台词。点这里选供给方、填地址与 Key，保存后立刻生效。";
  }
  if (llm.configured) {
    return null;
  }
  const name = (llm.name ?? "").trim();
  if (name === "") {
    return "对话模型还没配好。点这里补齐地址与 Key，保存后立刻生效。";
  }
  return `对话模型「${name}」还没配好。点这里补齐地址与 Key，保存后立刻生效。`;
}
