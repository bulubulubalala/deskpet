/**
 * 文件职责：契约层的运行时校验工具（零依赖，渲染层与主进程都能用）。
 *
 * 为什么需要它：类型在编译后就不存在了，而 IPC 的入参来自另一个进程——渲染层传错一个字段
 * （拼错名字、传了字符串而不是数字），主进程要到深处（查库、写盘、算坐标）才炸，报错信息
 * 还指不到真正的入口。这里把「这个值长什么样」写成可执行的一小段，主进程在通道入口跑一遍，
 * 坏数据当场被拒，错误信息里带字段路径。
 *
 * 为什么不用 zod：本项目的依赖集合刻意保持极小（主进程只打包 electron 一个运行时依赖），
 * 而这里需要的只是「标量 + 对象 + 数组 + 枚举」四类组合。手写 200 行换掉一个第三方包，
 * 免掉版本漂移、免掉离线构建要联网装包，规则也仍然集中在本文件一处。
 *
 * 设计取舍：默认**忽略多余字段**（向前兼容——新版界面多传一个字段不该让旧主进程整条拒绝），
 * 只有显式写 extra: "reject" 才严格。缺省字段（optional）同时接受 undefined 与 null，
 * 因为渲染层习惯用 null 表示「没填」。
 *
 * 依赖方向：app/shared 内部；不 import electron / node 内置模块。
 */

/** 校验失败。path 是出问题的字段路径（如 `request.memory_id`），message 是给人看的一句话。 */
export class ContractViolation extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(path === "" ? message : path + "：" + message);
    this.name = "ContractViolation";
    this.path = path;
  }
}

/** 一个可执行的形状：parse 要么返回收窄后的值，要么抛 ContractViolation。 */
export interface Schema<T> {
  /** 给错误信息用的名字（如「字符串」「记忆 id」），方便人读懂。 */
  readonly label: string;
  parse(value: unknown, path: string): T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Infer<S> = S extends Schema<infer T> ? (any extends T ? any : T) : never;
type RequiredKeys<F> = {
  [K in keyof F]: undefined extends Infer<F[K]> ? never : K;
}[keyof F];
type OptionalKeys<F> = {
  [K in keyof F]: undefined extends Infer<F[K]> ? K : never;
}[keyof F];

/** object() 推断出的形状：必填字段照旧，可选字段（Schema<T | undefined>）变成 `?`。 */
export type ObjectShape<F> = {
  [K in RequiredKeys<F>]: Infer<F[K]>;
} & {
  [K in OptionalKeys<F>]?: Exclude<Infer<F[K]>, undefined>;
};

function fail(path: string, message: string): never {
  throw new ContractViolation(path, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  /** 允许空串（默认允许；写 false 表示至少要 min 个字符）。 */
  readonly label?: string;
}

/** 字符串。默认不限长度，只要求是字符串（空串合法，很多字段用它表示「没填」）。 */
export function string(options: StringOptions = {}): Schema<string> {
  const min = options.min ?? 0;
  const max = options.max;
  return {
    label: options.label ?? "字符串",
    parse(value, path) {
      if (typeof value !== "string") {
        fail(path, "必须是字符串");
      }
      if (value.length < min) {
        fail(path, "不能为空");
      }
      if (max !== undefined && value.length > max) {
        fail(path, "最多 " + String(max) + " 个字符，收到 " + String(value.length));
      }
      if (options.pattern !== undefined && !options.pattern.test(value)) {
        fail(path, "格式不对");
      }
      return value;
    },
  };
}

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly label?: string;
}

function checkRange(value: number, path: string, options: NumberOptions): void {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    fail(path, "必须是有限数字");
  }
  if (options.min !== undefined && value < options.min) {
    fail(path, "不能小于 " + String(options.min));
  }
  if (options.max !== undefined && value > options.max) {
    fail(path, "不能大于 " + String(options.max));
  }
}

/** 整数（JSON 里最常用的是 id 与计数）。 */
export function integer(options: NumberOptions = {}): Schema<number> {
  return {
    label: options.label ?? "整数",
    parse(value, path) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        fail(path, "必须是整数");
      }
      checkRange(value, path, options);
      return value;
    },
  };
}

/** 小数（缩放、比例、坐标）。 */
export function decimal(options: NumberOptions = {}): Schema<number> {
  return {
    label: options.label ?? "数字",
    parse(value, path) {
      if (typeof value !== "number") {
        fail(path, "必须是数字");
      }
      checkRange(value, path, options);
      return value;
    },
  };
}

export function boolean(): Schema<boolean> {
  return {
    label: "布尔值",
    parse(value, path) {
      if (typeof value !== "boolean") {
        fail(path, "必须是 true / false");
      }
      return value;
    },
  };
}

/** 固定字面量（判别值）。 */
export function literal<const T extends string | number | boolean>(expected: T): Schema<T> {
  return {
    label: String(expected),
    parse(value, path) {
      if (value !== expected) {
        fail(path, "必须是 " + String(expected));
      }
      return expected;
    },
  };
}

/** 枚举：取值只能来自给定的一组字符串。 */
export function oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  const allowed = new Set<string>(values);
  return {
    label: values.join(" / "),
    parse(value, path) {
      if (typeof value !== "string" || !allowed.has(value)) {
        fail(path, "必须是以下之一：" + values.join("、"));
      }
      return value;
    },
  };
}

/** 枚举（数字版）：帧率档位这类「只能取几个值」的数值。 */
export function oneOfNumbers<const T extends readonly number[]>(values: T): Schema<T[number]> {
  const allowed = new Set<number>(values);
  return {
    label: values.join(" / "),
    parse(value, path) {
      if (typeof value !== "number" || !allowed.has(value)) {
        fail(path, "必须是以下之一：" + values.join("、"));
      }
      return value;
    },
  };
}

/** 数组。max 用于挡住「一次传十万条」这种把主进程拖死的输入。 */
export function arrayOf<T>(
  item: Schema<T>,
  options: { readonly max?: number; readonly label?: string } = {},
): Schema<T[]> {
  const max = options.max;
  return {
    label: options.label ?? item.label + "[]",
    parse(value, path) {
      if (!Array.isArray(value)) {
        fail(path, "必须是数组");
      }
      if (max !== undefined && value.length > max) {
        fail(path, "最多 " + String(max) + " 项，收到 " + String(value.length));
      }
      return value.map((entry, index) => item.parse(entry, path + "[" + String(index) + "]"));
    },
  };
}

/** 定长数字向量（坐标 [x, y]、矩形 [x, y, w, h]）。 */
export function vector(
  size: number,
  options: { readonly min?: number; readonly max?: number; readonly label?: string } = {},
): Schema<number[]> {
  // exactOptionalPropertyTypes 下不能把 undefined 显式写进可选字段，按有值才带的方式组装
  const item = decimal({
    ...(options.min === undefined ? {} : { min: options.min }),
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  return {
    label: options.label ?? size + " 个数字",
    parse(value, path) {
      if (!Array.isArray(value) || value.length !== size) {
        fail(path, "必须是 " + String(size) + " 个数字");
      }
      return value.map((entry, index) => item.parse(entry, path + "[" + String(index) + "]"));
    },
  };
}

/** 键值表（形状由值决定，键名不限）。 */
export function recordOf<T>(value: Schema<T>): Schema<Record<string, T>> {
  return {
    label: "{ " + value.label + " }",
    parse(raw, path) {
      if (!isPlainObject(raw)) {
        fail(path, "必须是对象");
      }
      const out: Record<string, T> = {};
      for (const [key, entry] of Object.entries(raw)) {
        out[key] = value.parse(entry, path === "" ? key : path + "." + key);
      }
      return out;
    },
  };
}

/** 对象。字段清单写全，缺省字段用 optional() 包一层。 */
export function object<F extends Record<string, Schema<unknown>>>(
  fields: F,
  options: { readonly extra?: "allow" | "reject"; readonly label?: string } = {},
): Schema<ObjectShape<F>> {
  const extra = options.extra ?? "allow";
  return {
    label: options.label ?? "对象",
    parse(raw, path) {
      if (!isPlainObject(raw)) {
        fail(path, "必须是对象");
      }
      // 声明过的字段照形状校验；没声明的字段原样带过去（向前兼容：旧主进程 + 新界面
      // 不该互相拒绝，也不该把界面上真发来的东西静默吃掉）。
      const out: Record<string, unknown> = extra === "reject" ? {} : { ...raw };
      for (const [key, field] of Object.entries(fields)) {
        const childPath = path === "" ? key : path + "." + key;
        const parsed = field.parse(raw[key], childPath);
        if (parsed === undefined) {
          delete out[key];
        } else {
          out[key] = parsed;
        }
      }
      if (extra === "reject") {
        for (const key of Object.keys(raw)) {
          if (!(key in fields)) {
            fail(path === "" ? key : path + "." + key, "不认识的字段");
          }
        }
      }
      return out as ObjectShape<F>;
    },
  };
}

/** 可选字段：undefined 与 null 都当作「没填」，都通过。 */
export function optional<T>(schema: Schema<T>): Schema<T | undefined> {
  return {
    label: schema.label + "（可缺省）",
    parse(value, path) {
      if (value === undefined || value === null) {
        return undefined;
      }
      return schema.parse(value, path);
    },
  };
}

/** 允许 null（业务上明确用 null 表示「只读 / 不分档」的字段）。 */
export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return {
    label: schema.label + "（可为 null）",
    parse(value, path) {
      if (value === null) {
        return null;
      }
      return schema.parse(value, path);
    },
  };
}

/** 二选一（很少用；多数场合 optional / nullable 就够）。 */
export function either<A, B>(left: Schema<A>, right: Schema<B>): Schema<A | B> {
  return {
    label: left.label + " 或 " + right.label,
    parse(value, path) {
      try {
        return left.parse(value, path);
      } catch {
        return right.parse(value, path);
      }
    },
  };
}

/** 什么都不敢断言（只在确实无法列出字段时使用）。 */
export function anything(): Schema<unknown> {
  return {
    label: "任意值",
    parse(value) {
      return value;
    },
  };
}

/** 这条通道不接受任何入参（传了就是界面在乱调）。 */
export function none(): Schema<undefined> {
  return {
    label: "无参数",
    parse(value, path) {
      if (value !== undefined) {
        fail(path === "" ? "参数" : path, "不需要参数");
      }
      return undefined;
    },
  };
}
