/**
 * 文件职责：Live2D 形象舞台的占位实现（M3 落地，D7/D10）。
 *
 * 为什么现在就留一个类：Stage 抽象层的价值就是「换实现不改上层」。工厂按 appearance.stage
 * 选实现，Live2D 真身未就绪时 isAvailable() 返回 false，工厂据此回退 PNG；等 M3 把 Cubism
 * 模型加载与口型 / 动作接上，只需要把 create() 换成真实现，index.ts 一行不用动。
 * 依赖方向：renderer 内部；只 import type。
 */
import type { TouchRegion } from "../main/ipc";
import type { StagePlan } from "./stage-appearance";
import type { StageAdapter, StageSize } from "./stage";

export class Live2dStage implements StageAdapter {
  readonly kind = "live2d";

  /** 真实现落地前恒为 false：工厂因此永远走 PNG 回退（D10）。 */
  static isAvailable(): boolean {
    return false;
  }

  /**
   * M3 的真实现：加载 Cubism 模型、在 mount 里建 canvas、接口型与动作。
   * 现在把参数用进错误信息就够了——工厂在 isAvailable() 为假时不会调到这里。
   */
  static create(mount: HTMLElement, charId: string, plan: StagePlan): StageAdapter {
    throw new Error(
      `Live2D 舞台尚未实现（M3）：char_id=${charId}，mount=${mount.tagName}，stage=${plan.kind}`,
    );
  }

  metrics(): StageSize | null {
    return null;
  }

  containsPoint(): boolean {
    return false;
  }

  regionAt(): TouchRegion | null {
    return null;
  }

  pulse(): void {}

  setExpression(): void {}

  playAct(): void {}

  destroy(): void {}
}
