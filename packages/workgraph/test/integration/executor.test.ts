/**
 * Integration tests for the orchestrator executor.
 *
 * Boundary strategy:
 *   - `db`           → FakeDb (in-memory, SQL-shaped stub)
 *   - `spawnAgentFn` → makeSpawn (records calls, returns valid agent shape)
 *   - `../db/helpers`→ mocked module (file not on this branch)
 *
 * No real SQLite. No planner agent. Tests exercise orchestrator logic end-to-end
 * across the real executor code paths.
 */

import { describe, it, expect, mock } from "bun:test";
import { FakeDb, makeSpawn, makeFailingSpawn, nextRunId } from "../helpers/fake-db";

const {
  findReadyNodes,
  onNodeStatusUpdate,
  onPlanningComplete,
  onPlannerStopped,
  cancelOrchestration,
  startOrchestration,
  startExecution,
  getOrchestration,
} = await import("../../src/orchestrator/executor");

// ---------------------------------------------------------------------------
// findReadyNodes — dependency resolution
// ---------------------------------------------------------------------------

describe("findReadyNodes — dependency resolution", () => {
  it("empty graph returns no ready nodes", () => {
    const db = new FakeDb();
    expect(findReadyNodes(db, "run_x")).toEqual([]);
  });

  it("pending node with no dependencies is ready", () => {
    const db = new FakeDb().addNode("a", "pending");
    expect(findReadyNodes(db, "run_x")).toEqual(["a"]);
  });

  it("active node is not returned as ready", () => {
    const db = new FakeDb().addNode("a", "active");
    expect(findReadyNodes(db, "run_x")).toEqual([]);
  });

  it("completed node is not returned as ready", () => {
    const db = new FakeDb().addNode("a", "completed");
    expect(findReadyNodes(db, "run_x")).toEqual([]);
  });

  it("pending node whose dependency is completed is ready", () => {
    const db = new FakeDb()
      .addNode("a", "completed")
      .addNode("b", "pending")
      .addEdge("a", "b");
    expect(findReadyNodes(db, "run_x")).toEqual(["b"]);
  });

  it("pending node whose dependency is still pending is not ready", () => {
    const db = new FakeDb()
      .addNode("a", "pending")
      .addNode("b", "pending")
      .addEdge("a", "b");
    expect(findReadyNodes(db, "run_x")).toEqual(["a"]);
  });

  it("pending node whose dependency is active is not ready", () => {
    const db = new FakeDb()
      .addNode("a", "active")
      .addNode("b", "pending")
      .addEdge("a", "b");
    expect(findReadyNodes(db, "run_x")).toEqual([]);
  });

  it("pending node whose dependency failed is cascade-failed", () => {
    const db = new FakeDb()
      .addNode("a", "failed")
      .addNode("b", "pending")
      .addEdge("a", "b");
    findReadyNodes(db, "run_x");
    expect(db.nodeStatus("b")).toBe("failed");
  });

  it("cascade failure propagates transitively through a chain", () => {
    const db = new FakeDb()
      .addNode("a", "failed")
      .addNode("b", "pending")
      .addNode("c", "pending")
      .addEdge("a", "b")
      .addEdge("b", "c");
    // First call cascades a→b
    findReadyNodes(db, "run_x");
    // b is now failed, second call cascades b→c
    findReadyNodes(db, "run_x");
    expect(db.nodeStatus("b")).toBe("failed");
    expect(db.nodeStatus("c")).toBe("failed");
  });

  it("pending node whose dependency is cancelled becomes blocked", () => {
    const db = new FakeDb()
      .addNode("a", "cancelled")
      .addNode("b", "pending")
      .addEdge("a", "b");
    findReadyNodes(db, "run_x");
    expect(db.nodeStatus("b")).toBe("blocked");
  });

  it("mission node is auto-completed and excluded from ready list", () => {
    const db = new FakeDb().addNode("m", "pending", { node_type: "mission" });
    const ready = findReadyNodes(db, "run_x");
    expect(ready).not.toContain("m");
    expect(db.nodeStatus("m")).toBe("completed");
  });

  it("mission node completing unblocks its dependents", () => {
    const db = new FakeDb()
      .addNode("m", "pending", { node_type: "mission" })
      .addNode("child", "pending")
      .addEdge("m", "child");
    const ready = findReadyNodes(db, "run_x");
    expect(ready).toContain("child");
    expect(db.nodeStatus("m")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// onPlanningComplete — phase transitions
// ---------------------------------------------------------------------------

describe("onPlanningComplete — phase transitions", () => {
  it("unknown run does not throw", async () => {
    const db = new FakeDb();
    await expect(
      onPlanningComplete(db, "no_such_run", "plan", makeSpawn()),
    ).resolves.toBeUndefined();
  });

  it("auto_execute=false transitions to planned without spawning agents", async () => {
    const spawn = makeSpawn();
    const runId = nextRunId();
    // startOrchestration sets phase=planning; fake spawn for planner
    await startOrchestration(db_noop(), runId, "goal", makeSpawn(), { auto_execute: false });
    const db = new FakeDb().addNode("a", "pending");
    await onPlanningComplete(db, runId, "plan done", spawn);
    expect(getOrchestration(runId)?.phase).toBe("planned");
    expect(spawn.callCount).toBe(0);
  });

  it("auto_execute=true with no nodes completes the run immediately", async () => {
    const runId = nextRunId();
    await startOrchestration(db_noop(), runId, "goal", makeSpawn(), { auto_execute: true });
    const db = new FakeDb(); // no nodes
    await onPlanningComplete(db, runId, "plan done", makeSpawn());
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });

  it("auto_execute=true with ready nodes spawns task agents", async () => {
    const runId = nextRunId();
    await startOrchestration(db_noop(), runId, "goal", makeSpawn(), { auto_execute: true });
    const spawn = makeSpawn();
    const db = new FakeDb().addNode("a", "pending").addNode("b", "pending");
    await onPlanningComplete(db, runId, "plan done", spawn);
    expect(spawn.callCount).toBe(2);
    expect(db.nodeStatus("a")).toBe("active");
    expect(db.nodeStatus("b")).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// onNodeStatusUpdate — retry, cascade, completion
// ---------------------------------------------------------------------------

describe("onNodeStatusUpdate — retry logic", () => {
  it("unknown run does not throw", async () => {
    const db = new FakeDb();
    await expect(
      onNodeStatusUpdate(db, "no_such_run", "n1", "completed", makeSpawn()),
    ).resolves.toBeUndefined();
  });

  it("node completion triggers agent spawn for newly ready dependents", async () => {
    const runId = nextRunId();
    // 'a' starts active (already running) so startExecution doesn't re-spawn it;
    // 'b' is blocked on 'a' completing, so nothing is spawned at startup.
    const db = new FakeDb()
      .addNode("a", "active")
      .addNode("b", "pending")
      .addEdge("a", "b");
    await startExecution(db, runId, "goal", makeSpawn());
    const spawn = makeSpawn();
    await onNodeStatusUpdate(db, runId, "a", "completed", spawn);
    expect(db.nodeStatus("a")).toBe("completed");
    expect(spawn.callCount).toBe(1);
    expect(spawn.calls[0].nodeId).toBe("b");
  });

  it("failed node below max retries is re-spawned", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "active");
    await startExecution(db, runId, "goal", makeSpawn());
    db.nodes.get("a")!.status = "active";
    const spawn = makeSpawn();
    await onNodeStatusUpdate(db, runId, "a", "failed", spawn);
    expect(db.retryCount("a")).toBe(1);
    expect(spawn.callCount).toBe(1); // re-spawned
  });

  it("failed node that exhausts retries is permanently marked failed", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "active", { retry_count: 2 });
    await startExecution(db, runId, "goal", makeSpawn());
    db.nodes.get("a")!.status = "active";
    db.nodes.get("a")!.retry_count = 2; // already at max
    const spawn = makeSpawn();
    await onNodeStatusUpdate(db, runId, "a", "failed", spawn);
    expect(db.nodeStatus("a")).toBe("failed");
    expect(spawn.callCount).toBe(0); // no retry spawn
  });

  it("onNodeFailed hook fires when retries are exhausted", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "active", { retry_count: 2 });
    const onNodeFailed = mock(() => {});
    await startExecution(db, runId, "goal", makeSpawn(), { hooks: { onNodeFailed } });
    db.nodes.get("a")!.status = "active";
    db.nodes.get("a")!.retry_count = 2;
    await onNodeStatusUpdate(db, runId, "a", "failed", makeSpawn());
    expect(onNodeFailed).toHaveBeenCalledWith(runId, "a");
  });
});

describe("onNodeStatusUpdate — run completion", () => {
  it("last node completing transitions run to completed", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending");
    await startExecution(db, runId, "goal", makeSpawn());
    db.nodes.get("a")!.status = "active";
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });

  it("onRunCompleted hook fires when run completes", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending");
    const onRunCompleted = mock(async () => {});
    await startExecution(db, runId, "goal", makeSpawn(), { hooks: { onRunCompleted } });
    db.nodes.get("a")!.status = "active";
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());
    expect(onRunCompleted).toHaveBeenCalledWith(runId);
  });

  it("all nodes failing transitions run to failed", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "active", { retry_count: 2 });
    await startExecution(db, runId, "goal", makeSpawn());
    db.nodes.get("a")!.status = "active";
    db.nodes.get("a")!.retry_count = 2;
    await onNodeStatusUpdate(db, runId, "a", "failed", makeSpawn());
    expect(getOrchestration(runId)?.phase).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// cancelOrchestration
// ---------------------------------------------------------------------------

describe("cancelOrchestration", () => {
  it("sets phase to cancelled and fires onRunCancelled hook", async () => {
    const runId = nextRunId();
    // Node starts active so startExecution doesn't try to spawn it (it's not pending).
    // The run stays in "executing" phase, ready to be cancelled.
    const db = new FakeDb().addNode("a", "active");
    const onRunCancelled = mock(() => {});
    const state = await startExecution(db, runId, "goal", makeSpawn(), {
      hooks: { onRunCancelled },
    });
    expect(state.phase).toBe("executing");
    cancelOrchestration(state, db, () => {});
    expect(state.phase).toBe("cancelled");
    expect(onRunCancelled).toHaveBeenCalledWith(runId);
  });

  it("invokes killFn for each active agent", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending").addNode("b", "pending");
    const spawn = makeSpawn();
    const state = await startExecution(db, runId, "goal", spawn);
    // two agents should be tracked in state.node_agents
    const killFn = mock(() => {});
    cancelOrchestration(state, db, killFn);
    expect(killFn.mock.calls.length).toBe(2);
  });

  it("does not throw when there are no active agents", async () => {
    const runId = nextRunId();
    const db = new FakeDb(); // no nodes → run completes immediately
    const state = await startExecution(db, runId, "goal", makeSpawn());
    expect(() => cancelOrchestration(state, db, () => {})).not.toThrow();
  });

  it("is a no-op when run is already in a terminal phase", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending");
    const onRunCancelled = mock(() => {});
    const state = await startExecution(db, runId, "goal", makeSpawn(), {
      hooks: { onRunCancelled },
    });
    // Let run complete naturally
    db.nodes.get("a")!.status = "active";
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());
    expect(state.phase).toBe("completed");
    // Now cancel — should be a no-op
    cancelOrchestration(state, db, () => {});
    expect(state.phase).toBe("completed"); // not overwritten
    expect(onRunCancelled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startOrchestration — planner spawn failure
// ---------------------------------------------------------------------------

describe("startOrchestration — planner spawn failure", () => {
  it("spawn failure transitions run to failed phase", async () => {
    const runId = nextRunId();
    const db = new FakeDb();
    await startOrchestration(db, runId, "goal", makeFailingSpawn("network error"));
    expect(getOrchestration(runId)?.phase).toBe("failed");
    expect(getOrchestration(runId)?.error).toMatch(/network error/);
  });
});

// ---------------------------------------------------------------------------
// onPlannerStopped — planner crash / timeout during planning phase
// ---------------------------------------------------------------------------

describe("onPlannerStopped — planner crash during planning", () => {
  it("transitions run to failed when planner session matches", async () => {
    const runId = nextRunId();
    await startOrchestration(db_noop(), runId, "goal", makeSpawn());
    const state = getOrchestration(runId);
    expect(state?.phase).toBe("planning");
    const result = await onPlannerStopped(
      db_noop(), runId, state!.planner_agent_id!, "Planner timed out",
    );
    expect(result).toBe(true);
    expect(getOrchestration(runId)?.phase).toBe("failed");
    expect(getOrchestration(runId)?.error).toMatch(/timed out/);
  });

  it("is a no-op when session id does not match the planner", async () => {
    const runId = nextRunId();
    await startOrchestration(db_noop(), runId, "goal", makeSpawn());
    const result = await onPlannerStopped(db_noop(), runId, "wrong_session", "error");
    expect(result).toBe(false);
    expect(getOrchestration(runId)?.phase).toBe("planning");
  });

  it("is a no-op for a run not in planning phase", async () => {
    const runId = nextRunId();
    const db = new FakeDb();
    await startOrchestration(db_noop(), runId, "goal", makeSpawn());
    await onPlanningComplete(db, runId, "done", makeSpawn()); // → executing/completed
    const result = await onPlannerStopped(db, runId, "any_session", "late error");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Internal helper — no-op db for orchestrations Map setup calls
// ---------------------------------------------------------------------------

function db_noop(): any {
  return new FakeDb();
}
