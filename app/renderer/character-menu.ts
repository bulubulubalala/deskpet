/**
 * 文件职责：聊天条上的角色菜单（T2.7）——列出角色包、标出当前角色、给出编辑入口。
 *
 * 为什么单独一个文件：菜单只跟「当前是谁 + 有哪些角色」有关，和聊天 / 语音 / 舞台都不相干；
 * 主窗脚本原先在这里混着 activeCharId、chatStream、触摸状态，改一处要读两百行。
 * 依赖方向：本文件 -> window.deskpet（preload 白名单）+ ./dom；不 import main、不碰舞台。
 */
import type { CharacterSummary } from "../shared/contracts/ipc";
import type { DeskpetApi } from "../preload/api";
import { byId } from "./dom";

export interface CharacterMenuDeps {
  readonly api: DeskpetApi;
  /** 当前角色 id（没有可用角色时为 null）：菜单据此打勾、决定编辑入口能不能点。 */
  readonly getActiveId: () => string | null;
  readonly getActiveName: () => string;
  /** 用户点了某个角色：由调用方负责切角色（清聊天记录、重建立绘）。 */
  readonly onSelect: (character: CharacterSummary) => void;
  /** 菜单被打开时通知外面（另一个弹层要收起，避免互相遮挡）。 */
  readonly onOpen: () => void;
}

/** 角色选择弹层：上半部分列角色，下半部分是角色相关的编辑入口（T2.7）。 */
export class CharacterMenu {
  private readonly deps: CharacterMenuDeps;

  constructor(deps: CharacterMenuDeps) {
    this.deps = deps;
  }

  render(characters: readonly CharacterSummary[]): void {
    const popup = byId("char-popup");
    if (popup === null) {
      return;
    }
    popup.replaceChildren();
    const scroll = document.createElement("div");
    scroll.className = "popup-scroll";

    if (characters.length === 0) {
      const empty = document.createElement("p");
      empty.className = "popup-empty";
      empty.textContent = "还没有角色包：先用下面的「新建角色包…」。";
      scroll.append(empty);
    } else {
      for (const character of characters) {
        const item = document.createElement("button");
        item.type = "button";
        item.className =
          character.char_id === this.deps.getActiveId() ? "popup-item current" : "popup-item";
        item.dataset.charId = character.char_id;
        item.textContent = character.display_name;
        item.title = character.char_id;
        if (character.char_id === this.deps.getActiveId()) {
          const check = document.createElement("span");
          check.className = "popup-check";
          check.textContent = "✓";
          item.append(check);
        }
        item.addEventListener("click", () => {
          this.deps.onSelect(character);
        });
        scroll.append(item);
      }
    }
    popup.append(scroll);

    const separator = document.createElement("div");
    separator.className = "popup-sep";
    popup.append(separator);

    const currentId = this.deps.getActiveId();
    const cardAction = this.action(
      "编辑角色卡 / 人设…",
      () => {
        const charId = this.deps.getActiveId();
        if (charId !== null) {
          void this.deps.api.pack.openEditor({ mode: "card", char_id: charId });
        }
      },
      currentId === null,
    );
    cardAction.dataset.needsChar = "1";
    popup.append(cardAction);

    const partsAction = this.action(
      "编辑立绘部位框…",
      () => {
        const charId = this.deps.getActiveId();
        if (charId !== null) {
          void this.deps.api.pack.openEditor({ mode: "edit", char_id: charId });
        }
      },
      currentId === null,
    );
    partsAction.dataset.needsChar = "1";
    popup.append(partsAction);

    popup.append(
      this.action("新建角色包…", () => {
        void this.deps.api.pack.openEditor({ mode: "create" });
      }),
    );
  }

  /** 选中角色 / 外部切换后，把菜单里的当前项与勾选标记同步（T2.7）。 */
  markCurrent(): void {
    const popup = byId("char-popup");
    if (popup === null) {
      return;
    }
    const activeId = this.deps.getActiveId();
    for (const item of Array.from(
      popup.querySelectorAll<HTMLElement>(".popup-item[data-char-id]"),
    )) {
      const current = item.dataset.charId === activeId;
      item.classList.toggle("current", current);
      const check = item.querySelector<HTMLElement>(".popup-check");
      if (current && check === null) {
        const mark = document.createElement("span");
        mark.className = "popup-check";
        mark.textContent = "✓";
        item.append(mark);
      } else if (!current && check !== null) {
        check.remove();
      }
    }
    for (const button of Array.from(
      popup.querySelectorAll<HTMLButtonElement>(".popup-action[data-needs-char]"),
    )) {
      button.disabled = activeId === null;
    }
    const button = byId("char-button");
    if (button !== null) {
      button.title = activeId === null ? "切换角色" : "角色：" + this.deps.getActiveName();
    }
  }

  hide(): void {
    const popup = byId("char-popup");
    if (popup !== null) {
      popup.hidden = true;
    }
  }

  /** 点「角色」按钮：开 / 关菜单；开的时候通知外面收起别的弹层。 */
  toggle(): void {
    const popup = byId("char-popup");
    if (popup === null) {
      return;
    }
    popup.hidden = !popup.hidden;
    if (!popup.hidden) {
      this.deps.onOpen();
    }
  }

  /** 菜单里的一个动作项：点完先收菜单，再打开编辑器 / 设置。 */
  private action(label: string, run: () => void, disabled = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "popup-item popup-action";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", () => {
      this.hide();
      run();
    });
    return button;
  }
}
