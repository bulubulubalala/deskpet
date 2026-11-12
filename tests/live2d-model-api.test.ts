/**
 * 文件职责：Live2D 舞台的外部接口小工具——资源 URL、帧间隔、Cubism 参数读写。
 *
 * 为什么值得单测：这些是对着库的私有结构写的适配代码（CubismId 三层句柄、coreModel 参数表），
 * 库一升级最容易在这里静默失效；用假对象测完，真机上「歪头没反应」就不用先怀疑这一层。
 * 依赖方向：tests -> app/renderer/stage-live2d/model-api.ts（不加载 pixi）。
 */
import { describe, expect, it } from "vitest";

import {
  clampDelta,
  modelUrl,
  parameterIndexMap,
  parameterName,
  parameterSnapshot,
  type CubismParameterApi,
} from "../app/renderer/stage-live2d/model-api";

describe("modelUrl", () => {
  it("拼成自定义协议，逐段编码特殊字符", () => {
    expect(modelUrl("snow", "model/model3.json")).toBe(
      "deskpet-asset://character/snow/model/model3.json",
    );
    expect(modelUrl("角色 A", "assets/贴图 1/texture.png")).toBe(
      "deskpet-asset://character/%E8%A7%92%E8%89%B2%20A/assets/%E8%B4%B4%E5%9B%BE%201/texture.png",
    );
  });

  it("多余的斜杠会被丢掉，不会出现空段", () => {
    expect(modelUrl("snow", "/model//model3.json")).toBe(
      "deskpet-asset://character/snow/model/model3.json",
    );
  });
});

describe("clampDelta", () => {
  it("正常帧间隔原样返回，切后台的大缺口按 100ms 算", () => {
    expect(clampDelta(16.7)).toBeCloseTo(16.7, 6);
    expect(clampDelta(1000)).toBe(100);
  });

  it("0、负数、NaN 都退回一帧 16.7ms", () => {
    expect(clampDelta(0)).toBe(16.7);
    expect(clampDelta(-5)).toBe(16.7);
    expect(clampDelta(Number.NaN)).toBe(16.7);
  });
});

describe("parameterName", () => {
  it("认得三层句柄：getString()、.s、以及已经是字符串的情况", () => {
    expect(parameterName("ParamAngleX")).toBe("ParamAngleX");
    expect(parameterName({ s: "ParamAngleY" })).toBe("ParamAngleY");
    expect(parameterName({ getString: () => ({ s: "ParamEyeLOpen" }) })).toBe("ParamEyeLOpen");
  });

  it("遇到 null / 数字 / 死循环结构不会抛，返回空串", () => {
    expect(parameterName(null)).toBe("");
    expect(parameterName(42)).toBe("");
    const loop: Record<string, unknown> = {};
    loop["s"] = loop;
    expect(parameterName(loop)).toBe("");
  });
});

function fakeCore(names: string[]): CubismParameterApi {
  return {
    getParameterCount: () => names.length,
    getParameterId: (index: number) => ({ s: names[index] }),
    getParameterMinimumValue: () => -1,
    getParameterMaximumValue: () => 1,
    getParameterValueByIndex: (index: number) => index / 10,
    addParameterValueByIndex: () => {},
  };
}

describe("parameterSnapshot", () => {
  it("按参数表吐出 id / min / max / value", () => {
    const snapshot = parameterSnapshot({
      internalModel: { coreModel: fakeCore(["ParamAngleX", "ParamEyeLOpen"]) },
    });
    expect(snapshot).toEqual([
      { id: "ParamAngleX", min: -1, max: 1, value: 0 },
      { id: "ParamEyeLOpen", min: -1, max: 1, value: 0.1 },
    ]);
  });

  it("模型没有 coreModel 时返回 null，而不是抛错", () => {
    expect(parameterSnapshot({})).toBeNull();
    expect(parameterSnapshot({ internalModel: {} })).toBeNull();
  });
});

describe("parameterIndexMap", () => {
  it("只收关心的参数名，同名取第一个", () => {
    const core = fakeCore(["ParamAngleX", "ParamAngleX", "ParamBodyAngleZ"]);
    const index = parameterIndexMap(core, ["ParamAngleX", "ParamBodyAngleZ", "ParamMouthOpen"]);
    expect([...index.entries()]).toEqual([
      ["ParamAngleX", 0],
      ["ParamBodyAngleZ", 2],
    ]);
  });

  it("不传名单时收全表，空名字不进表", () => {
    const core = fakeCore(["ParamAngleX", "", "ParamBodyAngleZ"]);
    expect([...parameterIndexMap(core).entries()]).toEqual([
      ["ParamAngleX", 0],
      ["ParamBodyAngleZ", 2],
    ]);
  });
});
