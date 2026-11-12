/**
 * 文件职责：设置窗「记忆」面板的装配层——角色下拉框、主窗角色变化、对外导出的四件事，
 * 以及把各页面（列表 / 语义索引 / 时间线 / 日记 / 关系与待办 / 图谱）各自的接线挂上去。
 *
 * 为什么拆成一个目录：这块原先 1397 行、七个页面挤在一个闭包里，改日记要读语义索引的代码；
 * 现在每页一个文件，共享的只有 ./state 里的「当前角色」与时间格式。
 * 依赖方向：本文件 -> ./list、./embedding、./timeline、./diary、./relations、./graph、./backups；不 import main。
 */

import type { CharacterSummary } from "../../../shared/contracts/ipc";
import { api, byId, showBanner } from "../dom";
import { initBackupPane } from "./backups";
import { initDiaryPane } from "./diary";
import { initEmbeddingPane } from "./embedding";
import { initGraphPane } from "./graph";
import { initMemoryListPane, refreshMemories } from "./list";
import { initRelationsPane } from "./relations";
import { memoryPaneState } from "./state";
import { initTimelinePane } from "./timeline";

export { MEMORY_KIND_LABELS, formatMemoryTime } from "./state";
export { refreshMemories } from "./list";

/** 填角色下拉框并记住当前角色；默认选主窗正在用的那个（§6.11 的同一份状态）。 */
export async function loadMemoryCharacters(current: string | null): Promise<void> {
  const select = byId("memory-char");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  let characters: readonly CharacterSummary[] = [];
  try {
    characters = await api.characters.list();
  } catch (error: unknown) {
    showBanner("读取角色列表失败：" + String(error));
  }
  select.replaceChildren();
  for (const character of characters) {
    const option = document.createElement("option");
    option.value = character.char_id;
    option.textContent = character.display_name + "（" + character.char_id + "）";
    select.append(option);
  }
  const ids = characters.map((character) => character.char_id);
  const preferred = current !== null && ids.includes(current) ? current : (ids[0] ?? null);
  memoryPaneState.charId = preferred;
  if (preferred !== null) {
    select.value = preferred;
  }
  // onchange 而不是 addEventListener：角色列表刷新时会重进这个函数，addEventListener 会越挂越多
  select.onchange = () => {
    memoryPaneState.charId = select.value;
    memoryPaneState.follows = false;
    void refreshMemories();
  };
  devCharacterHook?.(preferred, characters);
  await refreshMemories();
}

/** 开发者面板注入的钩子：角色列表刷新后由它重建自己的下拉框（避免记忆模块反过来操作开发者的 DOM）。 */
export type DevCharacterHook = (
  preferred: string | null,
  characters: readonly CharacterSummary[],
) => void;

let devCharacterHook: DevCharacterHook | null = null;

export function setDevCharacterHook(hook: DevCharacterHook | null): void {
  devCharacterHook = hook;
}

/** 记忆面板当前选中的角色（开发者面板在没自选时沿用它）。 */
export function getMemoryCharId(): string | null {
  return memoryPaneState.charId;
}

/** 主窗换了角色：跟随模式下列表跟着换；用户手动选过就不再抢。 */
export function handleMainCharChanged(charId: string | null): void {
  if (charId === memoryPaneState.currentCharId) {
    return;
  }
  memoryPaneState.currentCharId = charId;
  if (memoryPaneState.follows && charId !== null) {
    void loadMemoryCharacters(charId);
  }
}

export interface MemoryPaneOptions {
  /** 主窗当前角色；null = 还没有角色。 */
  readonly currentChar: string | null;
}

/** 记忆面板的接线：按钮、模型进度、角色变更广播都在这里挂一次，main 只负责调用它。 */
/** 记忆面板的接线：角色下拉框与角色变更广播在这里，各页面自己的按钮由各自的 init 挂。 */
export function initMemoryPane(options: MemoryPaneOptions): void {
  memoryPaneState.currentCharId = options.currentChar;
  // 记忆面板：先填角色下拉框，再拉那个角色的记忆（默认主窗正在用的角色）
  void loadMemoryCharacters(options.currentChar);
  initMemoryListPane();
  initEmbeddingPane();
  initTimelinePane();
  initDiaryPane();
  initRelationsPane();
  initGraphPane();
  initBackupPane();
  // 角色包编辑器保存后主进程会广播（T2.3-D）：两个角色下拉立刻多出新角色
  api.characters.onChanged(() => {
    void loadMemoryCharacters(memoryPaneState.currentCharId ?? memoryPaneState.charId);
  });
}
