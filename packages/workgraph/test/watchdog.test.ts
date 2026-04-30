import { describe, it, expect } from "vitest";
import { Watchdog } from "../src/orchestrator/core/services/watchdog";

describe("Watchdog", () => {
  it("should use default config when none provided", () => {
    const watchdog = new Watchdog();
    const config = watchdog.getConfig();
    expect(config.noProgressTimeoutMs).toBe(120_000);
    expect(config.checkIntervalMs).toBe(10_000);
  });

  it("should use custom config when provided", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 60_000, checkIntervalMs: 5_000 });
    const config = watchdog.getConfig();
    expect(config.noProgressTimeoutMs).toBe(60_000);
    expect(config.checkIntervalMs).toBe(5_000);
  });

  it("should record activity for a node", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    watchdog.recordActivity("node-1", "running");

    // Check immediately, should not be stalled
    const stalled = watchdog.checkStalled();
    expect(stalled).toHaveLength(0);
  });

  it("should detect stalled nodes when timeout exceeded", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    const baseTime = 1000000;

    watchdog.recordActivity("node-1", "running");

    // Check well after timeout using explicit now
    const stalled = watchdog.checkStalled(Date.now() + 2000);
    expect(stalled).toHaveLength(1);
    expect(stalled[0].nodeId).toBe("node-1");
    expect(stalled[0].stalledForMs).toBeGreaterThanOrEqual(1000);
  });

  it("should not report completed nodes as stalled", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    watchdog.recordActivity("node-1", "completed");

    const stalled = watchdog.checkStalled(Date.now() + 5000);
    expect(stalled).toHaveLength(0);
  });

  it("should not report failed nodes as stalled", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    watchdog.recordActivity("node-1", "failed");

    const stalled = watchdog.checkStalled(Date.now() + 5000);
    expect(stalled).toHaveLength(0);
  });

  it("should escalate with retry action when stalled within 2x timeout", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    const stalledNodes = [{ nodeId: "node-1", stalledForMs: 1500 }]; // 1.5x timeout

    const actions = watchdog.escalate(stalledNodes);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("watchdog_escalated");
    expect(actions[0].nodeId).toBe("node-1");
    expect(actions[0].action).toBe("retry");
  });

  it("should escalate with kill action when stalled beyond 2x timeout", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    const stalledNodes = [{ nodeId: "node-1", stalledForMs: 2500 }]; // 2.5x timeout

    const actions = watchdog.escalate(stalledNodes);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("kill");
  });

  it("should remove a node from tracking", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    watchdog.recordActivity("node-1", "running");
    watchdog.removeNode("node-1");

    const stalled = watchdog.checkStalled(Date.now() + 5000);
    expect(stalled).toHaveLength(0);
  });

  it("should handle multiple nodes with mixed statuses", () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 1000 });
    const now = Date.now();

    watchdog.recordActivity("node-1", "running");
    watchdog.recordActivity("node-2", "completed");
    watchdog.recordActivity("node-3", "running");

    const stalled = watchdog.checkStalled(now + 2000);
    expect(stalled).toHaveLength(2);
    const stalledIds = stalled.map(s => s.nodeId).sort();
    expect(stalledIds).toEqual(["node-1", "node-3"]);
  });
});
