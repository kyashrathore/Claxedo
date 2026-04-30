/**
 * Executor contract tests — covers functions not exercised in executor.test.ts.
 */

import { vi, describe, it, expect } from "vitest";
import { FakeDb, makeSpawn, nextRunId } from "../helpers/fake-db";

const {
  getRunMetrics,
  getAllOrchestrations,
  getRunMetadata,
  onSessionStopped,
  cancelNodeExecution,
  cancelOrchestration,
  reconcileExecution,
  startExecution,
  onNodeStatusUpdate,
  getOrchestration,
} = await import("../../src/orchestrator/executor");

// ---------------------------------------------------------------------------
// getRunMetrics
// ---------------------------------------------------------------------------

describe("getRunMetrics", () => {
  it("returns null when no metrics are stored", () => {
    const db = new FakeDb(); // metricsJson defaults to null
    expect(getRunMetrics(db, "no_such_run")).toBeNull();
  });

  it("returns null when metrics_json is null", () => {
    const db = new FakeDb(); // metricsJson defaults to null
    expect(getRunMetrics(db, "run_1")).toBeNull();
  });

  it("returns null when metrics_json is malformed JSON", () => {
    const db = new FakeDb();
    db.metricsJson = "{ bad json }";
    expect(getRunMetrics(db, "run_1")).toBeNull();
  });

  it("returns parsed metrics when metrics_json is valid", () => {
    const metrics = {
      wall_time_ms: 5000,
      task_count: 3,
      completed_count: 2,
      failed_count: 1,
      max_parallelism: 2,
      avg_parallelism: 1.5,
      total_tokens_used: null,
      estimated_cost_usd: null,
    };
    const db = new FakeDb();
    db.metricsJson = JSON.stringify(metrics);
    expect(getRunMetrics(db, "run_1")).toEqual(metrics);
  });
});

// ---------------------------------------------------------------------------
// getAllOrchestrations
// ---------------------------------------------------------------------------

describe("getAllOrchestrations", () => {
  it("includes a freshly started run", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("a", "active");
    await startExecution(db, runId, "goal", makeSpawn());
    const all = getAllOrchestrations();
    expect(all.some((s) => s.run_id === runId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRunMetadata
// ---------------------------------------------------------------------------

describe("getRunMetadata", () => {
  it("returns undefined for a run not in the orchestrations map", () => {
    const db = new FakeDb();
    expect(getRunMetadata(db, "unknown_run_xyz")).toBeUndefined();
  });

  it("returns metadata shape for a known run", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId)
      .addNode("n1", "active", { title: "Task one", kind: "code_gen", role: "developer" })
      .addNode("n2", "completed", { title: "Task two", kind: "research", role: "developer" });
    db.addEdge("n2", "n1");
    await startExecution(db, runId, "my goal", makeSpawn());

    const meta = getRunMetadata(db, runId);
    expect(meta).toBeDefined();
    expect(meta!.goal).toBe("test goal");
    expect(meta!.nodes).toBeInstanceOf(Array);
    expect(meta!.edges).toBeInstanceOf(Array);
    expect(typeof meta!.startTime).toBe("number");
  });

  it("maps node statuses to metadata status values", async () => {
    const runId = nextRunId();
    const nodeData = [
      { node_id: "active_node",    status: "active",    kind: "research", role: "developer", title: "active_node",    session_id: null },
      { node_id: "completed_node", status: "completed", kind: "research", role: "developer", title: "completed_node", session_id: null },
      { node_id: "failed_node",    status: "failed",    kind: "research", role: "developer", title: "failed_node",    session_id: null },
      { node_id: "pending_node",   status: "pending",   kind: "research", role: "developer", title: "pending_node",   session_id: null },
      { node_id: "blocked_node",   status: "blocked",   kind: "research", role: "developer", title: "blocked_node",   session_id: null },
    ];
    const db = new FakeDb(runId);
    for (const n of nodeData) db.addNode(n.node_id, n.status);
    await startExecution(db, runId, "goal", makeSpawn());

    db.customRunNodes = nodeData;

    const meta = getRunMetadata(db, runId);
    expect(meta).toBeDefined();
    const byId = Object.fromEntries(meta!.nodes.map((n) => [n.id, n.status]));
    expect(byId["active_node"]).toBe("running");
    expect(byId["completed_node"]).toBe("completed");
    expect(byId["failed_node"]).toBe("failed");
    expect(byId["pending_node"]).toBe("pending");
    expect(byId["blocked_node"]).toBe("blocked");
  });

  it("endTime is set for completed runs", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("a", "pending");
    await startExecution(db, runId, "goal", makeSpawn());
    db.setNodeStatus("a", "active");
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());

    const meta = getRunMetadata(db, runId);
    expect(meta!.endTime).toBeDefined();
    expect(typeof meta!.endTime).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// onSessionStopped
// ---------------------------------------------------------------------------

describe("onSessionStopped", () => {
  it("returns false when no matching attempt row exists", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("n1", "active");
    await startExecution(db, runId, "goal", makeSpawn());
    // openAttemptId defaults to null — simulates no matching attempt

    const result = await onSessionStopped(db, runId, "n1", "sess_x", makeSpawn(), "crashed");
    expect(result).toBe(false);
  });

  it("returns true and triggers retry for matched session", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("n1", "active");
    await startExecution(db, runId, "goal", makeSpawn());

    db.openAttemptId = "att_session_01";

    const result = await onSessionStopped(db, runId, "n1", "sess_active", makeSpawn(), "agent died");
    expect(result).toBe(true);
    // onSessionStopped → onNodeStatusUpdate("failed") → retry logic re-activates the node
    expect(db.nodeStatus("n1")).toBe("active");
    expect(db.retryCount("n1")).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// cancelNodeExecution
// ---------------------------------------------------------------------------

describe("cancelNodeExecution", () => {
  it("marks the node as cancelled in the DB", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("n1", "active");
    await startExecution(db, runId, "goal", makeSpawn());

    cancelNodeExecution(db, runId, "n1");
    expect(db.nodeStatus("n1")).toBe("cancelled");
  });

  it("does not throw when the run is not in the orchestrations map", () => {
    const db = new FakeDb().addNode("n1", "active");
    expect(() => cancelNodeExecution(db, "nonexistent_run", "n1")).not.toThrow();
  });

  it("clears the current_agent_id in node history", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("n1", "pending");
    const state = await startExecution(db, runId, "goal", makeSpawn());

    expect(state.node_agents.get("n1")).toBeDefined();
    cancelNodeExecution(db, runId, "n1");
    expect(state.node_agents.get("n1")!.current_agent_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcileExecution
// ---------------------------------------------------------------------------

describe("reconcileExecution", () => {
  it("is a no-op for cancelled runs", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("a", "active");
    const state = await startExecution(db, runId, "goal", makeSpawn());
    cancelOrchestration(state, db, () => {});
    expect(state.phase).toBe("cancelled");

    await reconcileExecution(db, runId, makeSpawn());
    expect(state.phase).toBe("cancelled");
  });

  it("is a no-op for completed runs", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("a", "pending");
    const state = await startExecution(db, runId, "goal", makeSpawn());
    db.setNodeStatus("a", "active");
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());
    expect(state.phase).toBe("completed");

    await reconcileExecution(db, runId, makeSpawn());
    expect(state.phase).toBe("completed");
  });

  it("is a no-op for failed runs", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("a", "active", { retry_count: 2 });
    const state = await startExecution(db, runId, "goal", makeSpawn());
    db.setNodeStatus("a", "active");
    db.setNodeRetryCount("a", 2);
    await onNodeStatusUpdate(db, runId, "a", "failed", makeSpawn());
    expect(state.phase).toBe("failed");

    await reconcileExecution(db, runId, makeSpawn());
    expect(state.phase).toBe("failed");
  });

  it("re-enters executing phase and spawns ready nodes", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("a", "active");
    const state = await startExecution(db, runId, "goal", makeSpawn());
    expect(state.phase).toBe("executing");

    db.addNode("b", "pending");
    const spawn = makeSpawn();
    await reconcileExecution(db, runId, spawn);
    expect(spawn.callCount).toBeGreaterThanOrEqual(1);
  });

  it("is a no-op when the run is unknown", async () => {
    const db = new FakeDb();
    await expect(reconcileExecution(db, "never_registered_run", makeSpawn())).resolves.toBeUndefined();
  });

  it("hooks provided to reconcile are applied and fire on run completion", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("a", "pending");
    const state = await startExecution(db, runId, "goal", makeSpawn());
    state.hooks = undefined;

    const onRunCompleted = vi.fn(async () => {});
    // reconcile attaches the hooks; a is active (already spawned at startup)
    await reconcileExecution(db, runId, makeSpawn(), { onRunCompleted });

    // Now complete the node — hook must fire because reconcile attached it
    db.setNodeStatus("a", "active");
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());
    expect(onRunCompleted).toHaveBeenCalledWith(runId);
  });
});
