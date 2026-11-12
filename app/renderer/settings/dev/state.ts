/**
 * 文件职责：开发者面板共享的那点状态——开关、当前看的角色、原文分页游标、切页回调。
 *
 * 为什么单独一个文件：原文 / 注入预览 / 可编辑事实三页都要读它，谁都不该拥有它；
 * 放这里以后，三页之间不用互相 import。
 * 依赖方向：renderer/settings 内部；禁止 import main 的实现模块。
 */

import type { MemoryMessageItem } from "../../../shared/contracts/ipc";
import { getMemoryCharId } from "../memory";

/** 连点版本号进入 / 退出开发者模式：20 次，间隔超过 1 s 就归零（用户 m09622 第 4 条）。 */
export const DEV_TAP_TARGET_COUNT = 20;
export const DEV_TAP_RESET_MS = 1000;

/** 原文页一页取多少条；比记忆列表大一些，翻「更早」的次数少点。 */
export const DEV_RAW_PAGE_SIZE = 50;

export interface DevState {
  tapCount: number;
  tapLastAt: number;
  enabled: boolean;
  /** 开发者模式自己选的角色；与记忆面板的下拉分开，避免两边互相改。 */
  charId: string | null;
  rawItems: MemoryMessageItem[];
  rawBefore: number | null;
  rawHasMore: boolean;
}

export const devState: DevState = {
  tapCount: 0,
  tapLastAt: 0,
  enabled: false,
  charId: null,
  rawItems: [],
  rawBefore: null,
  rawHasMore: false,
};

/**
 * 切页由设置窗主入口注入：本模块只关心「打开开发者模式时该显示 dev 页」，
 * 不直接操作导航 DOM（导航归 settings.ts，页签归属一处）。
 */
let selectPaneRef: (name: string) => void = () => {};

export function setSelectPane(fn: (name: string) => void): void {
  selectPaneRef = fn;
}

export function selectPane(name: string): void {
  selectPaneRef(name);
}

/** 开发者模式在看的角色：优先自己选的，还没选就跟着记忆面板那个。 */
export function currentDevChar(): string | null {
  return devState.charId ?? getMemoryCharId();
}
