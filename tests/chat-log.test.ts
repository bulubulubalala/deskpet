/**
 * 文件职责：聊天记录数据模型的单测（T2.27）——多句合并、错误断轮、裁剪顺序。
 *
 * 气泡动画和滚动在浏览器里验，这里只守「一条回复不该被拆成十几个气泡」这类规则。
 */
import { describe, expect, it } from "vitest";

import { ChatLog } from "../app/renderer/chat-log";

describe("ChatLog", () => {
  it("用户发一句会结束上一轮，角色多句合并成一个气泡", () => {
    const log = new ChatLog();
    log.appendUser("你好");
    const first = log.appendAssistant("我", "小雪");
    const second = log.appendAssistant("在呢。", "小雪");
    expect(first.id).toBe(second.id);
    expect(second.text).toBe("我在呢。");
    expect(log.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
  });

  it("系统错误结束当前角色轮，错误后的台词新建气泡", () => {
    const log = new ChatLog();
    log.appendUser("在吗");
    const first = log.appendAssistant("在。", "小雪");
    log.appendSystem("网络断了", "系统", true);
    const next = log.appendAssistant("刚才说到哪了？", "小雪");
    expect(next.id).not.toBe(first.id);
    expect(log.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "system",
      "assistant",
    ]);
  });

  it("普通系统提示不会打断角色多句合并", () => {
    const log = new ChatLog();
    log.appendUser("你好");
    const first = log.appendAssistant("你", "小雪");
    log.appendSystem("已记录");
    const second = log.appendAssistant("好。", "小雪");
    expect(second.id).toBe(first.id);
  });

  it("超过上限从最旧开始淘汰；删除当前角色气泡后下一句新建", () => {
    const log = new ChatLog({ maxEntries: 3 });
    log.appendUser("1");
    log.appendUser("2");
    log.appendUser("3");
    expect(log.prune()).toEqual([]);
    expect(log.entries.map((entry) => entry.text)).toEqual(["1", "2", "3"]);

    log.appendUser("4");
    expect(log.prune().map((entry) => entry.text)).toEqual(["1"]);
    expect(log.entries.map((entry) => entry.text)).toEqual(["2", "3", "4"]);

    log.appendUser("5");
    expect(log.prune().map((entry) => entry.text)).toEqual(["2"]);
    expect(log.entries.map((entry) => entry.text)).toEqual(["3", "4", "5"]);
  });

  it("系统错误可以带上排查详情，普通提示不带", () => {
    const log = new ChatLog();
    const error = log.appendSystem("模型出错了", "系统", true, { status: 500 }, "DP-LLM-004");
    const notice = log.appendSystem("已切换角色", "系统");

    expect(error.detail).toEqual({ status: 500 });
    expect(error.code).toBe("DP-LLM-004");
    expect(notice.detail).toBeUndefined();
    expect(notice.code).toBeUndefined();
  });

  it("清空后不残留当前轮状态", () => {
    const log = new ChatLog();
    log.appendUser("你好");
    log.appendAssistant("你", "小雪");
    log.clear();
    expect(log.entries).toEqual([]);
    const next = log.appendAssistant("新的一句", "小雪");
    expect(next.text).toBe("新的一句");
  });
});
