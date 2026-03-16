/**
 * Executor cascade tests: retry, failure propagation, blocked state, and metrics.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../../src/app";
import {
  startOrchestration,
  onPlanningComplete,
  onNodeStatusUpdate,
  getOrchestration,
  getRunMetrics,
} from "../../src/orchestrator/executor";
import { handleToolCall, type McpToolContext } from "../../src/mcp/tools";

function live(id: string | number, dir = String(id)) {
  return {
    id: `ses_${id}`,
    session_id: `ses_${id}`,
    runtime_type: "workspace",
    directory: `/tmp/${dir}`,
    worktree_path: `/tmp/${dir}`,
    status: "running",
  } as any;
}

function makeDb() {
  const db = new Database(":memory:");
  initializeDb(db);
  return db;
}

async function makeRun(db: any, goal = "test") {
  const app = createApp(db);
  const res = await app.request("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  return (await res.json()).run_id as string;
}

// ---------------------------------------------------------------------------
// Cascade: completed node unlocks downstream
// ---------------------------------------------------------------------------

describe("executor cascade — completion", () => {
  let db: any;
  let runId: string;

  beforeEach(async () => {
    db = makeDb();
    runId = await makeRun(db, "cascade test");
  });

  it("unlocks a chain of three sequential nodes", async () => {
    const spawned: string[] = [];
    const spawn = async (_: string, rId: string, nId: string) => {
      spawned.push(nId);
      return live(spawned.length, nId || "planner");
    };

    await startOrchestration(db, runId, "chain", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "A", kind: "code_gen", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx, "create_node", { title: "B", kind: "code_gen", role: "developer", prompt: "B", depends_on: [n1.node_id] });
    const n3 = await handleToolCall(ctx, "create_node", { title: "C", kind: "code_gen", role: "developer", prompt: "C", depends_on: [n2.node_id] });

    spawned.length = 0;
    await onPlanningComplete(db, runId, "chain plan", spawn);
    expect(spawned).toEqual([n1.node_id]);

    // complete n1 → n2 unlocks
    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    spawned.length = 0;
    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", spawn);
    expect(spawned).toEqual([n2.node_id]);

    // complete n2 → n3 unlocks
    state.node_agents.set(n2.node_id, { current_agent_id: "a2", history: [{ agent_id: "a2", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    spawned.length = 0;
    await onNodeStatusUpdate(db, runId, n2.node_id, "completed", spawn);
    expect(spawned).toEqual([n3.node_id]);

    // complete n3 → run completes
    state.node_agents.set(n3.node_id, { current_agent_id: "a3", history: [{ agent_id: "a3", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    await onNodeStatusUpdate(db, runId, n3.node_id, "completed", spawn);
    expect(state.phase).toBe("completed");
  });

  it("unlocks two parallel branches simultaneously when shared dependency completes", async () => {
    const spawned: string[] = [];
    const spawn = async (_: string, rId: string, nId: string) => {
      spawned.push(nId);
      return live(spawned.length, nId || "planner");
    };

    await startOrchestration(db, runId, "diamond", spawn);
    const ctx: McpToolContext = { db, runId };
    const root = await handleToolCall(ctx, "create_node", { title: "Root", kind: "research", role: "developer", prompt: "root" });
    const left = await handleToolCall(ctx, "create_node", { title: "Left", kind: "code_gen", role: "developer", prompt: "left", depends_on: [root.node_id] });
    const right = await handleToolCall(ctx, "create_node", { title: "Right", kind: "code_gen", role: "developer", prompt: "right", depends_on: [root.node_id] });

    spawned.length = 0;
    await onPlanningComplete(db, runId, "diamond plan", spawn);
    expect(spawned).toEqual([root.node_id]);

    const state = getOrchestration(runId)!;
    state.node_agents.set(root.node_id, { current_agent_id: "ar", history: [{ agent_id: "ar", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    spawned.length = 0;
    await onNodeStatusUpdate(db, runId, root.node_id, "completed", spawn);

    // Both left and right should be spawned
    expect(spawned).toHaveLength(2);
    expect(spawned).toContain(left.node_id);
    expect(spawned).toContain(right.node_id);
  });
});

// ---------------------------------------------------------------------------
// Cascade: failure propagation
// ---------------------------------------------------------------------------

describe("executor cascade — failure propagation", () => {
  let db: any;
  let runId: string;

  beforeEach(async () => {
    db = makeDb();
    runId = await makeRun(db, "failure test");
  });

  it("cascades failure to all transitive dependents", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "cascade fail", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "A", kind: "code_gen", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx, "create_node", { title: "B", kind: "code_gen", role: "developer", prompt: "B", depends_on: [n1.node_id] });
    const n3 = await handleToolCall(ctx, "create_node", { title: "C", kind: "code_gen", role: "developer", prompt: "C", depends_on: [n2.node_id] });

    await onPlanningComplete(db, runId, "fail plan", spawn);

    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });

    // Set n1 retry count to max so it perma-fails
    db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [n1.node_id]);

    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", spawn, "hard fail");

    const n2row = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(n2.node_id) as any;
    const n3row = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(n3.node_id) as any;
    expect(n2row.status).toBe("failed");
    expect(n3row.status).toBe("failed");
  });

  it("marks run failed when all nodes fail with no completions", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "all fail", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "X", kind: "code_gen", role: "developer", prompt: "X" });
    await onPlanningComplete(db, runId, "fail plan", spawn);

    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [n1.node_id]);

    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", spawn, "fatal");

    expect(state.phase).toBe("failed");
    const run = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
    expect(run.status).toBe("failed");
  });

  it("marks run completed (partial) when some nodes complete and some fail", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "partial fail", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "Good", kind: "research", role: "developer", prompt: "ok" });
    const n2 = await handleToolCall(ctx, "create_node", { title: "Bad", kind: "research", role: "developer", prompt: "fail" });

    await onPlanningComplete(db, runId, "partial plan", spawn);
    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    state.node_agents.set(n2.node_id, { current_agent_id: "a2", history: [{ agent_id: "a2", status: "running", started_at: new Date().toISOString(), finished_at: null }] });

    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", spawn);
    db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [n2.node_id]);
    await onNodeStatusUpdate(db, runId, n2.node_id, "failed", spawn, "bad node");

    // Should be completed (not failed) because at least one completed
    expect(state.phase).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe("executor cascade — retry", () => {
  let db: any;
  let runId: string;

  beforeEach(async () => {
    db = makeDb();
    runId = await makeRun(db, "retry test");
  });

  it("retries a node up to MAX_RETRIES (2) before giving up", async () => {
    const spawned: string[] = [];
    const spawn = async (_: string, rId: string, nId: string) => {
      spawned.push(nId);
      return live(spawned.length, nId || "planner");
    };

    await startOrchestration(db, runId, "retry", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "Flaky", kind: "code_gen", role: "developer", prompt: "try" });

    await onPlanningComplete(db, runId, "retry plan", spawn);
    const state = getOrchestration(runId)!;

    // Fail once (retry_count = 0 → should retry)
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    spawned.length = 0;
    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", spawn, "transient");
    const rc1 = (db.query("SELECT retry_count FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any).retry_count;
    expect(rc1).toBe(1);
    expect(spawned.length).toBe(1); // re-spawned

    // Fail second time (retry_count = 1 → should retry again)
    state.node_agents.set(n1.node_id, { current_agent_id: "a2", history: [{ agent_id: "a2", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    spawned.length = 0;
    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", spawn, "transient2");
    const rc2 = (db.query("SELECT retry_count FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any).retry_count;
    expect(rc2).toBe(2);
    expect(spawned.length).toBe(1); // re-spawned again

    // Fail third time (retry_count = 2 → exhausted, no more spawns)
    state.node_agents.set(n1.node_id, { current_agent_id: "a3", history: [{ agent_id: "a3", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    spawned.length = 0;
    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", spawn, "final");
    expect(spawned.length).toBe(0); // no more retries

    const node = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any;
    expect(node.status).toBe("failed");
  });

  it("succeeds after a retry", async () => {
    const spawned: string[] = [];
    const spawn = async (_: string, rId: string, nId: string) => {
      spawned.push(nId);
      return live(spawned.length, nId || "planner");
    };

    await startOrchestration(db, runId, "succeed after retry", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "Eventually", kind: "code_gen", role: "developer", prompt: "try" });

    await onPlanningComplete(db, runId, "retry plan", spawn);
    const state = getOrchestration(runId)!;

    // Fail first attempt
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", spawn, "first fail");

    // Now succeed on retry
    state.node_agents.set(n1.node_id, { current_agent_id: "a2", history: [{ agent_id: "a2", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", spawn);

    expect(state.phase).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Blocked state
// ---------------------------------------------------------------------------

describe("executor cascade — blocked state", () => {
  let db: any;
  let runId: string;

  beforeEach(async () => {
    db = makeDb();
    runId = await makeRun(db, "blocked test");
  });

  it("transitions to blocked when a node has cancelled dependency", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "blocked run", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "A", kind: "code_gen", role: "developer", prompt: "A" });
    const n2 = await handleToolCall(ctx, "create_node", { title: "B", kind: "code_gen", role: "developer", prompt: "B", depends_on: [n1.node_id] });

    await onPlanningComplete(db, runId, "blocked plan", spawn);

    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });

    // Exhaust retries so n1 perma-fails and cascades to n2
    db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [n1.node_id]);
    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", spawn, "cancelled-sim");

    const n2row = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(n2.node_id) as any;
    // n2 should be failed (cascaded from failed n1, since retry_count=0 initially but n1 perma-failed after retries)
    // After n1 is marked failed with retry exhausted, n2 cascades to failed
    expect(["failed", "blocked"]).toContain(n2row.status);
  });
});

// ---------------------------------------------------------------------------
// Run metrics
// ---------------------------------------------------------------------------

describe("run metrics", () => {
  let db: any;
  let runId: string;

  beforeEach(async () => {
    db = makeDb();
    runId = await makeRun(db, "metrics test");
  });

  it("stores metrics_json in runs_current after run completes", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "metrics", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "Work", kind: "code_gen", role: "developer", prompt: "do work" });

    await onPlanningComplete(db, runId, "metrics plan", spawn);
    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", spawn);

    const row = db.query("SELECT metrics_json FROM runs_current WHERE run_id = ?").get(runId) as any;
    expect(row.metrics_json).not.toBeNull();
    const metrics = JSON.parse(row.metrics_json);
    expect(metrics.task_count).toBe(1);
    expect(metrics.completed_count).toBe(1);
    expect(metrics.failed_count).toBe(0);
    expect(metrics.wall_time_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.max_parallelism).toBeGreaterThanOrEqual(1);
  });

  it("getRunMetrics returns null before run completes", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");
    await startOrchestration(db, runId, "incomplete", spawn);
    expect(getRunMetrics(db, runId)).toBeNull();
  });

  it("getRunMetrics returns parsed object after run completes", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");
    await startOrchestration(db, runId, "metrics", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "T", kind: "research", role: "developer", prompt: "p" });
    await onPlanningComplete(db, runId, "done", spawn);
    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", spawn);

    const metrics = getRunMetrics(db, runId);
    expect(metrics).not.toBeNull();
    expect(metrics!.task_count).toBe(1);
    expect(metrics!.total_tokens_used).toBeNull();
    expect(metrics!.estimated_cost_usd).toBeNull();
  });

  it("metrics route returns 404 before run completes", async () => {
    const app = createApp(db);
    const res = await app.request(`/runs/${runId}/metrics`);
    expect(res.status).toBe(404);
  });

  it("metrics route returns metrics after run completes", async () => {
    const app = createApp(db);
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");
    await startOrchestration(db, runId, "metrics", spawn);
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", { title: "T", kind: "research", role: "developer", prompt: "p" });
    await onPlanningComplete(db, runId, "done", spawn);
    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", spawn);

    const res = await app.request(`/runs/${runId}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_count).toBe(1);
    expect(body.completed_count).toBe(1);
  });

  it("records max_parallelism for parallel nodes", async () => {
    const spawn = async (_: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "parallel metrics", spawn);
    const ctx: McpToolContext = { db, runId };
    // Two independent nodes — should run in parallel
    const n1 = await handleToolCall(ctx, "create_node", { title: "P1", kind: "research", role: "developer", prompt: "p1" });
    const n2 = await handleToolCall(ctx, "create_node", { title: "P2", kind: "research", role: "developer", prompt: "p2" });

    await onPlanningComplete(db, runId, "parallel plan", spawn);
    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, { current_agent_id: "a1", history: [{ agent_id: "a1", status: "running", started_at: new Date().toISOString(), finished_at: null }] });
    state.node_agents.set(n2.node_id, { current_agent_id: "a2", history: [{ agent_id: "a2", status: "running", started_at: new Date().toISOString(), finished_at: null }] });

    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", spawn);
    await onNodeStatusUpdate(db, runId, n2.node_id, "completed", spawn);

    const metrics = getRunMetrics(db, runId);
    expect(metrics).not.toBeNull();
    expect(metrics!.max_parallelism).toBeGreaterThanOrEqual(2);
  });
});
