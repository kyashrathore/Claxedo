/**
 * Unit tests for IExecutionStore / SqliteExecutionStore (via openSqliteExecutionStore).
 *
 * Each test uses a real in-memory SQLite DB so we exercise actual SQL.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDb } from "../../src/db/schema";
import { openSqliteEventStore } from "../../src/orchestrator/core/services/event-store-sqlite";
import { openSqliteExecutionStore, type IExecutionStore } from "../../src/sdk/execution-store";
import type { OrchestratorRunState } from "../../src/orchestrator/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  const db = new Database(":memory:");
  initializeDb(db);
  const eventStore = openSqliteEventStore(db);
  const store = openSqliteExecutionStore(db, eventStore);
  // Pre-seed a run row so run-level queries work
  db.run(
    "INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["run_x", "test goal", "active", new Date().toISOString(), new Date().toISOString()],
  );
  return { db, store, eventStore };
}

function addNode(db: Database, runId: string, nodeId: string, status = "pending") {
  db.run(
    `INSERT OR IGNORE INTO nodes_current
       (node_id, run_id, role, kind, title, node_type, status, retry_count, runtime_type, runtime_type_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nodeId, runId, "developer", "research", nodeId, "task", status, 0, "task", null],
  );
}

function addEdge(db: Database, runId: string, sourceId: string, targetId: string) {
  db.run(
    "INSERT OR IGNORE INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
    [`edge_${sourceId}_${targetId}`, runId, sourceId, targetId, "depends_on"],
  );
}

// ---------------------------------------------------------------------------
// getRun
// ---------------------------------------------------------------------------

describe("IExecutionStore: getRun", () => {
  it("returns null for unknown runId", () => {
    const { store } = makeStore();
    expect(store.getRun("run_nope")).toBeNull();
  });

  it("returns RunSnapshot for known run", () => {
    const { store } = makeStore();
    const snap = store.getRun("run_x");
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("active");
    expect(typeof snap!.created_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// updateRunStatus
// ---------------------------------------------------------------------------

describe("IExecutionStore: updateRunStatus", () => {
  it("updates the status column", () => {
    const { store } = makeStore();
    store.updateRunStatus("run_x", "completed");
    expect(store.getRun("run_x")!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// upsertRunExec / getRunDirectory
// ---------------------------------------------------------------------------

describe("IExecutionStore: upsertRunExec", () => {
  it("inserts exec row on first call", () => {
    const { store } = makeStore();
    store.upsertRunExec("run_x", { directory: "/tmp/run_x", runtimeType: "workspace" });
    expect(store.getRunDirectory("run_x")).toBe("/tmp/run_x");
  });

  it("second call updates session_id but preserves directory via COALESCE", () => {
    const { store } = makeStore();
    store.upsertRunExec("run_x", { directory: "/tmp/orig", runtimeType: "workspace" });
    store.upsertRunExec("run_x", { sessionId: "sess_abc" });
    // directory kept from first upsert via COALESCE
    expect(store.getRunDirectory("run_x")).toBe("/tmp/orig");
  });

  it("getRunDirectory returns null when no exec row exists", () => {
    const { store } = makeStore();
    expect(store.getRunDirectory("run_x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRunSourceId / getRunSource
// ---------------------------------------------------------------------------

describe("IExecutionStore: source queries", () => {
  it("getRunSourceId returns null when no source_id", () => {
    const { store } = makeStore();
    expect(store.getRunSourceId("run_x")).toBeNull();
  });

  it("getRunSource returns null when no source row", () => {
    const { store } = makeStore();
    expect(store.getRunSource("run_x")).toBeNull();
  });

  it("getRunSource returns PlannerSourceRow when source row exists", () => {
    const { db, store } = makeStore();
    db.run(
      "INSERT INTO run_sources_current (run_id, kind, title, content, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["run_x", "markdown", "My Doc", "# hello", null, new Date().toISOString()],
    );
    const src = store.getRunSource("run_x");
    expect(src).not.toBeNull();
    expect(src!.kind).toBe("markdown");
    expect(src!.title).toBe("My Doc");
  });
});

// ---------------------------------------------------------------------------
// updateSource
// ---------------------------------------------------------------------------

describe("IExecutionStore: updateSource", () => {
  it("is a no-op when sourceId is null", () => {
    const { store } = makeStore();
    expect(() => store.updateSource(null, "completed")).not.toThrow();
  });

  it("updates status and can set optional fields", () => {
    const { db, store } = makeStore();
    const now = new Date().toISOString();
    db.run(
      "INSERT OR IGNORE INTO sources_current (source_id, goal, kind, title, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["src_1", "my goal", "markdown", "T", "body", "pending", now, now],
    );
    store.updateSource("src_1", "completed", { error: null, planRunId: "run_plan" });
    const row = db.query("SELECT * FROM sources_current WHERE source_id = ?").get("src_1") as any;
    expect(row.status).toBe("completed");
    expect(row.plan_run_id).toBe("run_plan");
  });
});

// ---------------------------------------------------------------------------
// getNode / getNodesForRun / getEdgesForRun
// ---------------------------------------------------------------------------

describe("IExecutionStore: node queries", () => {
  it("getNode returns null for unknown nodeId", () => {
    const { store } = makeStore();
    expect(store.getNode("node_nope")).toBeNull();
  });

  it("getNode returns NodeSnapshot for known node", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_a");
    const node = store.getNode("node_a");
    expect(node).not.toBeNull();
    expect(node!.node_id).toBe("node_a");
    expect(node!.status).toBe("pending");
  });

  it("getNodesForRun returns empty for run with no nodes", () => {
    const { store } = makeStore();
    expect(store.getNodesForRun("run_x")).toHaveLength(0);
  });

  it("getNodesForRun returns all nodes for run", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_a");
    addNode(db, "run_x", "node_b");
    expect(store.getNodesForRun("run_x")).toHaveLength(2);
  });

  it("getEdgesForRun returns empty for run with no edges", () => {
    const { store } = makeStore();
    expect(store.getEdgesForRun("run_x")).toHaveLength(0);
  });

  it("getEdgesForRun returns edges after insertion", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "n1");
    addNode(db, "run_x", "n2");
    addEdge(db, "run_x", "n1", "n2");
    const edges = store.getEdgesForRun("run_x");
    expect(edges).toHaveLength(1);
    expect(edges[0].source_id).toBe("n1");
    expect(edges[0].target_id).toBe("n2");
  });
});

// ---------------------------------------------------------------------------
// updateNodeStatus / incrementNodeRetry
// ---------------------------------------------------------------------------

describe("IExecutionStore: node mutations", () => {
  it("updateNodeStatus changes node status", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_u");
    store.updateNodeStatus("run_x", "node_u", "completed");
    expect(store.getNode("node_u")!.status).toBe("completed");
  });

  it("incrementNodeRetry increments retry_count by 1 each call", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_r");
    store.incrementNodeRetry("node_r");
    store.incrementNodeRetry("node_r");
    expect(store.getNode("node_r")!.retry_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getDependentsOf
// ---------------------------------------------------------------------------

describe("IExecutionStore: getDependentsOf", () => {
  it("returns empty for leaf node", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "leaf");
    expect(store.getDependentsOf("run_x", "leaf")).toHaveLength(0);
  });

  it("returns correct target_id + status pairs", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "src_node");
    addNode(db, "run_x", "dep_node", "pending");
    addEdge(db, "run_x", "src_node", "dep_node");
    const deps = store.getDependentsOf("run_x", "src_node");
    expect(deps).toHaveLength(1);
    expect(deps[0].target_id).toBe("dep_node");
    expect(deps[0].status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// getScratchpad
// ---------------------------------------------------------------------------

describe("IExecutionStore: getScratchpad", () => {
  it("returns null when no scratchpad entry exists", () => {
    const { store } = makeStore();
    expect(store.getScratchpad("run_x", "node_sp")).toBeNull();
  });

  it("returns first content by created_at ASC", () => {
    const { db, store } = makeStore();
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["sp_1", "run_x", "node_sp", "first entry", now, now, 11],
    );
    expect(store.getScratchpad("run_x", "node_sp")).toBe("first entry");
  });
});

// ---------------------------------------------------------------------------
// createAttempt / finishAttempt / findOpenAttemptId
// ---------------------------------------------------------------------------

describe("IExecutionStore: attempts", () => {
  it("findOpenAttemptId returns null when no attempts", () => {
    const { store } = makeStore();
    expect(store.findOpenAttemptId("run_x", "node_a", "sess_1")).toBeNull();
  });

  it("createAttempt + findOpenAttemptId returns the attempt by session_id", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_a");
    store.createAttempt({
      runId: "run_x",
      nodeId: "node_a",
      status: "running",
      runtimeType: "task",
      sessionId: "sess_1",
    });
    const id = store.findOpenAttemptId("run_x", "node_a", "sess_1");
    expect(id).not.toBeNull();
    expect(id).toMatch(/^att_/);
  });

  it("findOpenAttemptId returns null after finishAttempt", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_fin");
    store.createAttempt({
      runId: "run_x",
      nodeId: "node_fin",
      status: "running",
      runtimeType: "task",
      sessionId: "sess_fin",
    });
    store.finishAttempt("run_x", "node_fin", "completed");
    expect(store.findOpenAttemptId("run_x", "node_fin", "sess_fin")).toBeNull();
  });

  it("finishAttempt is a no-op when no open attempt", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_noop");
    expect(() => store.finishAttempt("run_x", "node_noop", "completed")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hasBlockers
// ---------------------------------------------------------------------------

describe("IExecutionStore: hasBlockers", () => {
  it("returns false for run with no blockers", () => {
    const { store } = makeStore();
    expect(store.hasBlockers("run_x")).toBe(false);
  });

  it("returns true when a blocker row targets a pending node", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_blocked", "blocked");
    db.run(
      "INSERT OR IGNORE INTO run_blockers_current (run_id, work_item_id, target_node_id, title) VALUES (?, ?, ?, ?)",
      ["run_x", "item_1", "node_blocked", "waiting for approval"],
    );
    expect(store.hasBlockers("run_x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// finalizeMetrics / getRunMetrics
// ---------------------------------------------------------------------------

describe("IExecutionStore: metrics", () => {
  it("getRunMetrics returns null before finalization", () => {
    const { store } = makeStore();
    expect(store.getRunMetrics("run_x")).toBeNull();
  });

  it("finalizeMetrics computes correct counts and persists them", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "n_done", "completed");
    addNode(db, "run_x", "n_fail", "failed");
    addNode(db, "run_x", "n_pend", "pending");

    const mockState: OrchestratorRunState = {
      phase: "completed",
      nodes: new Map(),
      parallelism: null,
      retryPolicy: { maxRetries: 2 },
    };

    const metrics = store.finalizeMetrics("run_x", mockState);
    expect(metrics.task_count).toBe(3);
    expect(metrics.completed_count).toBe(1);
    expect(metrics.failed_count).toBe(1);

    const retrieved = store.getRunMetrics("run_x");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.task_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// queryRunNodes / getRunGoal
// ---------------------------------------------------------------------------

describe("IExecutionStore: metadata queries", () => {
  it("queryRunNodes returns empty array for run with no nodes", () => {
    const { store } = makeStore();
    expect(store.queryRunNodes("run_x")).toHaveLength(0);
  });

  it("queryRunNodes includes session_id from latest attempt", () => {
    const { db, store } = makeStore();
    addNode(db, "run_x", "node_qs");
    store.createAttempt({
      runId: "run_x",
      nodeId: "node_qs",
      status: "running",
      runtimeType: "task",
      sessionId: "sess_qs",
    });
    const rows = store.queryRunNodes("run_x");
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess_qs");
  });

  it("getRunGoal returns empty string for missing run", () => {
    const { store } = makeStore();
    expect(store.getRunGoal("run_nope")).toBe("");
  });

  it("getRunGoal returns the correct goal", () => {
    const { store } = makeStore();
    expect(store.getRunGoal("run_x")).toBe("test goal");
  });
});

// ---------------------------------------------------------------------------
// emitRunEvent / emitNodeEvent (fire-and-forget: verify events are persisted)
// ---------------------------------------------------------------------------

describe("IExecutionStore: event emission", () => {
  it("emitRunEvent persists an event via the event store", async () => {
    const { store, eventStore } = makeStore();
    store.emitRunEvent("run_x", "test_event", { key: "value" });
    // Give the fire-and-forget promise a tick to resolve
    await new Promise((r) => setTimeout(r, 10));
    const events = await eventStore.getEvents("run_x");
    const ev = events.find((e) => e.type === "test_event");
    expect(ev).toBeDefined();
  });

  it("emitNodeEvent persists a node_status_changed event", async () => {
    const { db, store, eventStore } = makeStore();
    addNode(db, "run_x", "node_emit");
    store.emitNodeEvent("run_x", "node_emit", "completed");
    await new Promise((r) => setTimeout(r, 10));
    const events = await eventStore.getEvents("run_x");
    const ev = events.find((e) => e.type === "node_status_changed");
    expect(ev).toBeDefined();
    const payload = JSON.parse(ev!.payload_json);
    expect(payload.node_id).toBe("node_emit");
    expect(payload.status).toBe("completed");
  });
});
