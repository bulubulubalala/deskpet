import { describe, expect, it } from "vitest";

import {
  ContractViolation,
  arrayOf,
  boolean,
  decimal,
  either,
  integer,
  literal,
  none,
  nullable,
  object,
  oneOf,
  oneOfNumbers,
  optional,
  recordOf,
  string,
  vector,
} from "../app/shared/contracts/validate";

describe("validate 工具", () => {
  it("字符串：类型、长度、正则逐条说清楚", () => {
    const schema = string({ min: 1, max: 4 });
    expect(schema.parse("ab", "t")).toBe("ab");
    expect(() => schema.parse(1, "t")).toThrow(/t：必须是字符串/);
    expect(() => schema.parse("", "t")).toThrow(/不能为空/);
    expect(() => schema.parse("abcde", "t")).toThrow(/最多 4 个字符/);
    expect(() => string({ pattern: /^[a-z]+$/ }).parse("AB", "t")).toThrow(/格式不对/);
  });

  it("数字：整数、小数与范围", () => {
    expect(integer({ min: 1 }).parse(3, "t")).toBe(3);
    expect(() => integer().parse(1.5, "t")).toThrow(/必须是整数/);
    expect(() => integer({ min: 1 }).parse(0, "t")).toThrow(/不能小于 1/);
    expect(decimal({ max: 2 }).parse(1.5, "t")).toBe(1.5);
    expect(() => decimal().parse(Number.POSITIVE_INFINITY, "t")).toThrow(/有限数字/);
  });

  it("枚举、字面量与布尔", () => {
    expect(oneOf(["a", "b"] as const).parse("b", "t")).toBe("b");
    expect(() => oneOf(["a", "b"] as const).parse("c", "t")).toThrow(/必须是以下之一：a、b/);
    expect(oneOfNumbers([15, 30] as const).parse(30, "t")).toBe(30);
    expect(() => oneOfNumbers([15, 30] as const).parse(60, "t")).toThrow(/必须是以下之一/);
    expect(literal("x").parse("x", "t")).toBe("x");
    expect(() => boolean().parse("true", "t")).toThrow(/必须是 true \/ false/);
  });

  it("对象：缺省字段、多余字段默认放过、reject 模式拦下", () => {
    const schema = object({ id: integer(), name: optional(string()) });
    expect(schema.parse({ id: 1 }, "r")).toEqual({ id: 1 });
    // name: null 被 optional 折成「没填」；没声明的 extra 原样带过去
    expect(schema.parse({ id: 1, name: null, extra: true }, "r")).toEqual({ id: 1, extra: true });
    expect(() => schema.parse({}, "r")).toThrow(/r.id：必须是整数/);
    const strict = object({ id: integer() }, { extra: "reject" });
    expect(() => strict.parse({ id: 1, oops: 2 }, "r")).toThrow(/r.oops：不认识的字段/);
  });

  it("数组、向量与键值表", () => {
    const list = arrayOf(integer({ min: 0 }), { max: 2 });
    expect(list.parse([0, 1], "t")).toEqual([0, 1]);
    expect(() => list.parse([0, 1, 2], "t")).toThrow(/最多 2 项/);
    expect(() => list.parse([1, -1], "t")).toThrow(/t\[1\]：不能小于 0/);
    expect(vector(2, { min: 0, max: 1 }).parse([0.5, 1], "t")).toEqual([0.5, 1]);
    expect(() => vector(2).parse([0.5], "t")).toThrow(/必须是 2 个数字/);
    expect(recordOf(string()).parse({ a: "x" }, "t")).toEqual({ a: "x" });
  });

  it("optional 把 null 与 undefined 都当没填，nullable 只认 null", () => {
    expect(optional(integer()).parse(undefined, "t")).toBeUndefined();
    expect(optional(integer()).parse(null, "t")).toBeUndefined();
    expect(nullable(boolean()).parse(null, "t")).toBeNull();
    expect(() => nullable(boolean()).parse(undefined, "t")).toThrow(/必须是 true \/ false/);
  });

  it("either 依次尝试；none 只接受没有参数", () => {
    expect(either(string(), integer()).parse(3, "t")).toBe(3);
    expect(() => either(string(), integer()).parse(true, "t")).toThrow(ContractViolation);
    expect(none().parse(undefined, "t")).toBeUndefined();
    expect(() => none().parse({}, "t")).toThrow(/不需要参数/);
  });
});
