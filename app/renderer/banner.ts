/**
 * 文件职责：主窗唯一那条横幅——谁写的、什么时候收、点了去哪里。
 *
 * 为什么单独一个文件：横幅以前没有「主人」，引擎失败与临时报错会互相覆盖
 * （引擎恢复时把「麦克风打不开」一起收掉，或者反过来把失败提示盖成别的报错）。
 * 现在写入必须带 owner，收起只认自己的 owner；引擎失败与「第一次运行没配模型」
 * 各自记得自己写过没有，心跳每 2 秒推一次也不会反复重写 DOM（那会闪、也会抢焦点）。
 * 依赖方向：renderer/banner -> renderer/dom、engine-guide、setup-guide；不碰 IPC，
 * 点击后该开哪个设置页只回一个意图，由入口去调 window.deskpet。
 */
import type { HealthView } from "../shared/contracts/ipc";

import { byId } from "./dom";
import { describeEngineFailure } from "./engine-guide";
import { describeSetupHint } from "./setup-guide";

export type BannerOwner = "engine" | "setup" | "message";

/** 这两类横幅点了都会开设置窗（标题不同），message 类只是报错文本。 */
const BANNER_TITLES: Record<BannerOwner, string> = {
  engine: "点击打开设置",
  setup: "点击打开模型供给设置",
  message: "",
};

let bannerOwner: BannerOwner | null = null;

function writeBanner(message: string, owner: BannerOwner): void {
  const banner = byId("banner");
  if (banner === null) {
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
  banner.classList.toggle("banner-action", owner !== "message");
  banner.title = BANNER_TITLES[owner];
  bannerOwner = owner;
}

/** 临时错误：挂到下一次成功操作或下一条消息为止。 */
export function showBanner(message: string): void {
  writeBanner(message, "message");
}

export function hideBanner(owner: BannerOwner): void {
  if (bannerOwner !== owner) {
    return;
  }
  const banner = byId("banner");
  if (banner !== null) {
    banner.hidden = true;
    banner.textContent = "";
    banner.classList.remove("banner-action");
    banner.title = "";
  }
  bannerOwner = null;
}

/**
 * 点横幅该做什么：引擎失败 → 打开设置；缺模型 → 直接落在「模型供给」页；临时报错 → 什么也不做。
 * 返回意图而不是直接调 api，是为了让这个模块不依赖 window.deskpet（好单测）。
 */
export function bannerAction(): { pane?: "providers" } | null {
  if (bannerOwner === "engine") {
    return {};
  }
  if (bannerOwner === "setup") {
    return { pane: "providers" };
  }
  return null;
}

/**
 * 引擎失败引导（M0）：失败时把原因挂到横幅上并允许点开设置；恢复后自己收起。
 * 同一段失败只写一次 DOM——心跳每 2 秒推一次，反复重写会让横幅闪烁、也会抢走焦点。
 */
let engineFailureShown = false;

export function renderEngineGuide(view: HealthView): void {
  const text = describeEngineFailure(view);
  if (text === null) {
    if (engineFailureShown) {
      engineFailureShown = false;
      hideBanner("engine");
    }
    return;
  }
  if (engineFailureShown) {
    return;
  }
  engineFailureShown = true;
  writeBanner(text, "engine");
}

/**
 * 首次运行引导（M2）：引擎在线但没有可用的对话模型时，横幅告诉用户「去哪、填什么」。
 * 判据来自心跳的 providers，不再单独存一个「是否首次运行」的标记——
 * 配好就自动消失，用户手动改坏又会重新出现，比一次性标记更贴近真实状态。
 */
let setupHintShown = false;

export function renderSetupGuide(view: HealthView): void {
  // 引擎失败时横幅归引擎，缺模型的事等它起来再说
  if (bannerOwner === "engine") {
    return;
  }
  const text = describeSetupHint(view);
  if (text === null) {
    if (setupHintShown) {
      setupHintShown = false;
      hideBanner("setup");
    }
    return;
  }
  // 已经挂着就不用每 2 秒重写；但被临时错误横幅抢走时要抢回来（否则「缺模型」提示就此消失）
  if (setupHintShown && bannerOwner === "setup") {
    return;
  }
  setupHintShown = true;
  writeBanner(text, "setup");
}
