/**
 * 文件职责：IpcRegistry 的行为测试 —— 注册了什么、dispose 时摘掉什么。
 *
 * 为什么值得测：注册表的存在意义就是「注册与注销不可能对不上」。这条性质没法靠人眼在
 * 1700 行的注册函数里核对，只能在这里用假 ipcMain 断言。
 */

import { describe, expect, it } from "vitest";

import { IpcRegistry, type IpcMainLike } from "../app/main/ipc-registry";
import { integer, object } from "../app/shared/contracts/validate";

/** 假 ipcMain：只记录调用，不碰 Electron。 */
function fakeIpc() {
  const calls: string[] = [];
  const ipc: IpcMainLike = {
    handle(channel) {
      calls.push(`handle:${channel}`);
    },
    on(channel) {
      calls.push(`on:${channel}`);
    },
    removeHandler(channel) {
      calls.push(`removeHandler:${channel}`);
    },
    removeAllListeners(channel) {
      calls.push(`removeAllListeners:${channel}`);
    },
  };
  return { ipc, calls };
}

/** 假 ipcMain（会保存监听函数，便于直接调用）+ 一条登记过形状的通道。 */
function capturingIpc(): {
  ipc: IpcMainLike;
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener as never);
    },
    on() {
      // 本组用例只关心 handle
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    removeAllListeners() {
      // 同上
    },
  };
  return { ipc, handlers };
}

describe("IpcRegistry", () => {
  it("handle 与 on 分别转给 ipcMain，并记录通道名", () => {
    const { ipc, calls } = fakeIpc();
    const registry = new IpcRegistry(ipc);
    registry.handle("a", () => undefined);
    registry.on("b", () => undefined);
    expect(calls).toEqual(["handle:a", "on:b"]);
    expect(registry.channels()).toEqual({ handlers: ["a"], listeners: ["b"] });
  });

  it("dispose 用各自的方式摘掉：handle 走 removeHandler，on 走 removeAllListeners", () => {
    const { ipc, calls } = fakeIpc();
    const registry = new IpcRegistry(ipc);
    registry.handle("a", () => undefined);
    registry.on("b", () => undefined);
    registry.dispose();
    expect(calls.slice(2)).toEqual(["removeHandler:a", "removeAllListeners:b"]);
  });

  it("dispose 之后通道清空，重复 dispose 不会再动 ipcMain", () => {
    const { ipc, calls } = fakeIpc();
    const registry = new IpcRegistry(ipc);
    registry.handle("a", () => undefined);
    registry.dispose();
    const after = calls.length;
    registry.dispose();
    expect(calls.length).toBe(after);
    expect(registry.channels()).toEqual({ handlers: [], listeners: [] });
  });

  it("登记过形状的通道：坏入参在入口被拒，监听函数一次都不会跑", () => {
    const { ipc, handlers } = capturingIpc();
    const seen: unknown[] = [];
    const invalid: string[] = [];
    const registry = new IpcRegistry(ipc, {
      schemas: { demo: object({ id: integer({ min: 1 }) }) },
      onInvalidArgument: (channel) => invalid.push(channel),
    });
    registry.handle("demo", (_event, input) => {
      seen.push(input);
      return "ok";
    });
    const handler = handlers.get("demo");
    expect(handler).toBeDefined();
    if (handler === undefined) {
      return;
    }
    expect(handler({}, { id: 2 })).toBe("ok");
    expect(seen).toEqual([{ id: 2 }]);
    expect(() => handler({}, { id: "2" })).toThrow(/参数不合法（demo）：请求\.id：必须是整数/);
    expect(invalid).toEqual(["demo"]);
    expect(seen).toHaveLength(1);
  });

  it("没登记形状的通道原样放行（闸门是渐进的，不会让老通道一夜之间全拒）", () => {
    const { ipc, handlers } = capturingIpc();
    const registry = new IpcRegistry(ipc, { schemas: {} });
    registry.handle("plain", (_event, input) => input);
    expect(handlers.get("plain")?.({}, { anything: true })).toEqual({ anything: true });
  });

  it("同一通道重复注册两次，dispose 只摘一次（不会误伤别的窗口）", () => {
    const { ipc, calls } = fakeIpc();
    const registry = new IpcRegistry(ipc);
    registry.handle("a", () => undefined);
    registry.handle("a", () => undefined);
    registry.dispose();
    expect(calls.filter((call) => call === "removeHandler:a")).toHaveLength(1);
  });
});
