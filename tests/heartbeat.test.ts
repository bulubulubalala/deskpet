/**
 * 文件职责：心跳状态机单测（连续失败判离线、重启预算、成功清零、重启失败即判死）。
 *
 * 为什么这些用例重要：自动重启是本应用唯一的自愈通道，多一次会造成重启风暴，
 * 少一次会让用户对着一个哑掉的窗口说话（需求 §7.2 / §6.7）。
 * 依赖方向：tests -> app/main/heartbeat.ts（纯逻辑，无 IO）。
 */
import { describe, expect, it } from "vitest";

import { HeartbeatMonitor } from "../app/main/heartbeat";

describe("HeartbeatMonitor", () => {
  it("连续 3 次失败才申请重启，前两次不动状态", () => {
    const monitor = new HeartbeatMonitor({ maxFailures: 3, maxRestarts: 3 });
    expect(monitor.recordFailure(1, "连接被拒绝").kind).toBe("none");
    expect(monitor.recordFailure(2, "连接被拒绝").kind).toBe("none");
    // 前两次还保持 online：需求 §7.2 的判据是「连续 3 次无响应」
    expect(monitor.snapshot().state).toBe("starting");
    expect(monitor.recordFailure(3, "连接被拒绝").kind).toBe("restart");
    expect(monitor.snapshot().state).toBe("offline");
    expect(monitor.snapshot().restartsUsed).toBe(1);
  });

  it("重启预算用尽后判死，且不再申请重启", () => {
    const monitor = new HeartbeatMonitor({ maxFailures: 1, maxRestarts: 2 });
    expect(monitor.recordFailure(1, "挂了").kind).toBe("restart");
    expect(monitor.recordFailure(2, "挂了").kind).toBe("restart");
    expect(monitor.recordFailure(3, "挂了").kind).toBe("fatal");
    expect(monitor.snapshot().state).toBe("failed");
    expect(monitor.snapshot().restartsUsed).toBe(2);
    // 判死之后再来多少次都还是 fatal，不会又偷偷重启
    expect(monitor.recordFailure(4, "挂了").kind).toBe("fatal");
  });

  it("一次成功把失败计数与重启预算一起清零", () => {
    const monitor = new HeartbeatMonitor({ maxFailures: 1, maxRestarts: 1 });
    expect(monitor.recordFailure(1, "挂了").kind).toBe("restart");
    monitor.recordSuccess(2);
    const snapshot = monitor.snapshot();
    expect(snapshot.state).toBe("online");
    expect(snapshot.restartsUsed).toBe(0);
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.lastOkAtMs).toBe(2);
    // 预算回来了：下一次失败仍然会尝试重启
    expect(monitor.recordFailure(3, "又挂了").kind).toBe("restart");
  });

  it("重启本身失败直接判死，不把「起不来」当心跳抖动重试", () => {
    const monitor = new HeartbeatMonitor({ maxFailures: 3, maxRestarts: 3 });
    monitor.noteRestarting();
    expect(monitor.snapshot().state).toBe("restarting");
    monitor.noteRestartFailed("sidecar 可执行文件不存在");
    expect(monitor.snapshot().state).toBe("failed");
    expect(monitor.snapshot().lastError).toBe("sidecar 可执行文件不存在");
  });
});
