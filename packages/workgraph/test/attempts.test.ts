import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDb } from "../src/db/schema";
import { sqlite } from "../src/sqlite";
import { openSqliteEventStore } from "../src/substrate/event-store-sqlite";
import { openSqliteExecutionStore, type IExecutionStore } from "../src/sdk/execution-store";
import {
  startAttempts,
  onAttemptStatusUpdate,
  onSessionStopped,
  onPlannerStopped,
  cancelAttempt,
  reconcileAttempts,
  resetAttemptState,
  type SpawnAgentFn,
} from "../src/sdk/attempts";
import { initWorkGraph, getWorkGraph, resetWorkGraph } from "../src/model/registry";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let raw: InstanceType<typeof Database>;
let store: IExecutionStore;
let spawned: Array<{ prompt: string; runId: string; nodeId: string }>;

function makeSpawn(overrides?: { fail?: boolean; worktree?: boolean }): SpawnAgentFn {
  return async (prompt, runId, nodeId) => {
    if (overrides?.fail) throw new Error("spawn refused");
    spawned.push({ prompt, runId, nodeId });
    return {
      id: `agent_${spawned.length}`,
      session_id: `ses_${nodeId}`,
      runtime_type: "workspace",
      directory: "/tmp/x",
      worktree_path: overrides?.worktree === false ? null : `/tmp/x/wt-${nodeId}`,
    };
  };
}

function db() {
  return sqlite(raw);
}

function seedRun(runId: string, nodes: Array<{ id: string; status?: string; type?: string; title?: string; itemId?: string }>) {
  db().run("INSERT INTO runs_current (run_id, goal, status) VALUES (?, ?, ?)", [runId, "test goal", "executing"]);
  for (const n of nodes) {
    db().run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, node_type, status, retry_count) VALUES (?, ?, 'developer', 'task', ?, ?, ?, 0)",
      [n.id, runId, n.title ?? n.id, n.type ?? "task", n.status ?? "pending"],
    );
    if (n.itemId) {
      db().run("INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)", [runId, n.id, n.itemId]);
    }
  }
}

function nodeStatus(nodeId: string): string {
  return (db().query("SELECT status FROM nodes_current WHERE node_id = ?").get(nodeId) as any).status;
}

function runStatus(runId: string): string {
  return (db().query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any).status;
}

beforeEach(() => {
  raw = new Database(":memory:");
  initializeDb(raw);
  const d = sqlite(raw);
  store = openSqliteExecutionStore(d, openSqliteEventStore(raw));
  spawned = [];
  resetAttemptState();
  resetWorkGraph();
  initWorkGraph(); // in-memory item store
});

afterEach(() => {
  resetWorkGraph();
  raw.close();
});

// ---------------------------------------------------------------------------
// Attempt state machine
// ---------------------------------------------------------------------------

describe("flat attempt engine", () => {
  it("spawns one agent per pending node, no ordering", async () => {
    seedRun("run_1", [{ id: "n1" }, { id: "n2" }, { id: "n3" }]);
    await startAttempts(store, "run_1", "goal", makeSpawn());
    expect(spawned.map((s) => s.nodeId).sort()).toEqual(["n1", "n2", "n3"]);
    expect(nodeStatus("n1")).toBe("active");
    expect(runStatus("run_1")).toBe("executing");
  });

  it("completes mission nodes instantly without spawning", async () => {
    seedRun("run_m", [{ id: "m1", type: "mission" }, { id: "n1" }]);
    await startAttempts(store, "run_m", "goal", makeSpawn());
    expect(nodeStatus("m1")).toBe("completed");
    expect(spawned.map((s) => s.nodeId)).toEqual(["n1"]);
  });

  it("mission-only runs complete instead of stranding as executing", async () => {
    seedRun("run_mo", [{ id: "m1", type: "mission" }, { id: "m2", type: "mission" }]);
    await startAttempts(store, "run_mo", "goal", makeSpawn());
    expect(nodeStatus("m1")).toBe("completed");
    expect(nodeStatus("m2")).toBe("completed");
    expect(spawned).toHaveLength(0);
    expect(runStatus("run_mo")).toBe("completed");
  });

  it("active → completed finishes the run when all nodes are terminal", async () => {
    seedRun("run_2", [{ id: "n1" }]);
    await startAttempts(store, "run_2", "goal", makeSpawn());
    await onAttemptStatusUpdate(store, "run_2", "n1", "completed", makeSpawn());
    expect(nodeStatus("n1")).toBe("completed");
    expect(runStatus("run_2")).toBe("completed");
  });

  it("rejects illegal transitions: completed nodes cannot fail or re-complete", async () => {
    seedRun("run_3", [{ id: "n1" }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_3", "goal", spawn);
    await onAttemptStatusUpdate(store, "run_3", "n1", "completed", spawn);
    await onAttemptStatusUpdate(store, "run_3", "n1", "failed", spawn, "late failure");
    expect(nodeStatus("n1")).toBe("completed");
    expect(runStatus("run_3")).toBe("completed");
  });

  it("rejects status updates for pending (never-started) nodes", async () => {
    seedRun("run_4", [{ id: "n1", status: "pending" }]);
    await onAttemptStatusUpdate(store, "run_4", "n1", "completed", makeSpawn());
    expect(nodeStatus("n1")).toBe("pending");
  });

  it("retries a failed node once, then marks it failed", async () => {
    seedRun("run_5", [{ id: "n1" }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_5", "goal", spawn);
    expect(spawned.length).toBe(1);
    await onAttemptStatusUpdate(store, "run_5", "n1", "failed", spawn, "first failure");
    expect(spawned.length).toBe(2); // retried
    expect(nodeStatus("n1")).toBe("active");
    await onAttemptStatusUpdate(store, "run_5", "n1", "failed", spawn, "second failure");
    expect(spawned.length).toBe(2); // no third attempt
    expect(nodeStatus("n1")).toBe("failed");
    expect(runStatus("run_5")).toBe("failed");
  });

  it("run with mixed outcomes completes (not fails)", async () => {
    seedRun("run_6", [{ id: "n1" }, { id: "n2" }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_6", "goal", spawn);
    await onAttemptStatusUpdate(store, "run_6", "n1", "completed", spawn);
    await onAttemptStatusUpdate(store, "run_6", "n2", "failed", spawn, "e1");
    await onAttemptStatusUpdate(store, "run_6", "n2", "failed", spawn, "e2");
    expect(runStatus("run_6")).toBe("completed");
  });

  it("failed spawn reverts the node to pending", async () => {
    seedRun("run_7", [{ id: "n1" }]);
    await startAttempts(store, "run_7", "goal", makeSpawn({ fail: true }));
    expect(nodeStatus("n1")).toBe("pending");
  });

  it("isolated kinds require a worktree", async () => {
    seedRun("run_8", [{ id: "n1" }]);
    await startAttempts(store, "run_8", "goal", makeSpawn({ worktree: false }));
    expect(nodeStatus("n1")).toBe("pending"); // spawn rejected, reverted
  });

  it("cancelAttempt marks the node cancelled; run completes around it", async () => {
    seedRun("run_9", [{ id: "n1" }, { id: "n2" }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_9", "goal", spawn);
    cancelAttempt(store, "run_9", "n1", "archived");
    expect(nodeStatus("n1")).toBe("cancelled");
    await onAttemptStatusUpdate(store, "run_9", "n2", "completed", spawn);
    expect(runStatus("run_9")).toBe("completed");
  });

  it("blocked nodes park the run instead of completing it", async () => {
    seedRun("run_b", [{ id: "n1" }, { id: "nb", status: "blocked" }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_b", "goal", spawn);
    expect(spawned.map((s) => s.nodeId)).toEqual(["n1"]); // blocked never spawns
    await onAttemptStatusUpdate(store, "run_b", "n1", "completed", spawn);
    expect(runStatus("run_b")).toBe("blocked");
  });

  it("onSessionStopped fails the open attempt; unknown sessions return false", async () => {
    seedRun("run_s", [{ id: "n1" }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_s", "goal", spawn);
    expect(await onSessionStopped(store, "run_s", "n1", "ses_wrong", spawn, "boom")).toBe(false);
    expect(await onSessionStopped(store, "run_s", "n1", "ses_n1", spawn, "boom")).toBe(true);
    // one retry happened
    expect(spawned.length).toBe(2);
  });

  it("reconcileAttempts respawns pending nodes and leaves terminal runs alone", async () => {
    seedRun("run_r", [{ id: "n1", status: "pending" }]);
    await reconcileAttempts(store, "run_r", makeSpawn());
    expect(spawned.map((s) => s.nodeId)).toEqual(["n1"]);

    db().run("UPDATE runs_current SET status = 'completed' WHERE run_id = ?", ["run_r2"]);
    await reconcileAttempts(store, "run_r2", makeSpawn()); // nonexistent → no-op
    expect(spawned.length).toBe(1);
  });

  it("onPlannerStopped is a deprecated no-op returning false", async () => {
    expect(await onPlannerStopped(store, "run_x", "ses_x", "err")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item sync: node lifecycle reflects onto the linked work item
// ---------------------------------------------------------------------------

describe("item status sync", () => {
  it("open → in_progress on spawn, → done on completion", async () => {
    const wg = getWorkGraph();
    const item = wg.create({ title: "Fix the bug", nodeType: "task", labels: ["task"] });
    expect(item.status).toBe("open");

    seedRun("run_i", [{ id: "n1", itemId: item.id }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_i", "goal", spawn);
    expect(getWorkGraph().get(item.id)?.status).toBe("in_progress");

    await onAttemptStatusUpdate(store, "run_i", "n1", "completed", spawn);
    expect(getWorkGraph().get(item.id)?.status).toBe("done");
  });

  it("failure leaves the item retryable (not done)", async () => {
    const wg = getWorkGraph();
    const item = wg.create({ title: "Flaky work", nodeType: "task", labels: ["task"] });
    seedRun("run_f", [{ id: "n1", itemId: item.id }]);
    const spawn = makeSpawn();
    await startAttempts(store, "run_f", "goal", spawn);
    await onAttemptStatusUpdate(store, "run_f", "n1", "failed", spawn, "e1");
    await onAttemptStatusUpdate(store, "run_f", "n1", "failed", spawn, "e2");
    const status = getWorkGraph().get(item.id)?.status;
    expect(status).not.toBe("done");
  });

  it("failed spawn reverts the linked item back to open", async () => {
    const wg = getWorkGraph();
    const item = wg.create({ title: "Unspawnable work", nodeType: "task", labels: ["task"] });
    seedRun("run_fs", [{ id: "n1", itemId: item.id }]);
    await startAttempts(store, "run_fs", "goal", makeSpawn({ fail: true }));
    expect(nodeStatus("n1")).toBe("pending");
    expect(getWorkGraph().get(item.id)?.status).toBe("open");
  });
});
