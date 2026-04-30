/**
 * E2E test: individual task execution (no planning phase).
 *
 * Tests startExecution directly — skips the planner and runs pre-built graphs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDb } from "../../src/app";
import { startExecution, getOrchestration, getRunMetrics } from "../../src/orchestrator/executor";
import { handleToolCall } from "../../src/mcp/tools";
import { MockAgent } from "../helpers/mock-agent";
import { openSqliteExecutionStore } from "../../src/sdk/execution-store";
import { openSqliteEventStore } from "../../src/orchestrator/core/services/event-store-sqlite";

function makeDb() {
  const db = new Database(":memory:");
  initializeDb(db);
  return db;
}

function makeStore(db: any) {
  const eventStore = openSqliteEventStore(db);
  return openSqliteExecutionStore(db, eventStore);
}

function makeRunWithNodes(
  db: any,
  goal: string,
  nodeSpecs: Array<{ title: string; kind: string; role?: string; prompt?: string; depends_on?: string[] }>,
): { runId: string; nodeIds: string[] } {
  const runId = `run_ind_${Math.random().toString(36).slice(2)}`;
  db.run("INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [runId, goal, "active", new Date().toISOString(), new Date().toISOString()]);

  const nodeIds: string[] = [];
  const nodeIdMap = new Map<number, string>();

  for (let i = 0; i < nodeSpecs.length; i++) {
    const spec = nodeSpecs[i];
    const nodeId = `node_ind_${i}_${Math.random().toString(36).slice(2)}`;
    nodeIds.push(nodeId);
    nodeIdMap.set(i, nodeId);
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count, node_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [nodeId, runId, spec.role ?? "developer", spec.kind, spec.title, "pending", 0, "task"]);
    const prompt = spec.prompt ?? `Execute: ${spec.title}`;
    db.run("INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [`sp_${nodeId}`, runId, nodeId, prompt, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), prompt.length]);
  }

  // Add edges (resolve by title)
  for (let i = 0; i < nodeSpecs.length; i++) {
    const spec = nodeSpecs[i];
    if (spec.depends_on) {
      for (const depTitle of spec.depends_on) {
        const depIdx = nodeSpecs.findIndex((s) => s.title === depTitle);
        if (depIdx >= 0) {
          const edgeId = `edge_${i}_${depIdx}`;
          db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
            [edgeId, runId, nodeIdMap.get(depIdx), nodeIdMap.get(i), "depends_on"]);
        }
      }
    }
  }

  return { runId, nodeIds };
}

function waitForPhase(db: any, runId: string, phase: string, maxMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const state = getOrchestration(runId);
      if (state?.phase === phase) { resolve(); return; }
      const row = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
      if (row?.status === phase) { resolve(); return; }
      if (Date.now() - start > maxMs) {
        reject(new Error(`Timed out waiting for "${phase}" (current: "${state?.phase ?? row?.status}")`));
        return;
      }
      setTimeout(check, 20);
    };
    setTimeout(check, 5);
  });
}

// ---------------------------------------------------------------------------
// startExecution: single node
// ---------------------------------------------------------------------------

describe("individual-task: single node", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("executes a single pending node and completes", async () => {
    const { runId, nodeIds } = makeRunWithNodes(db, "single node test", [
      { title: "Do the thing", kind: "research", role: "developer", prompt: "research it" },
    ]);

    const agent = new MockAgent(db, makeStore(db), openSqliteEventStore(db));
    agent.addScript({ match: {}, status: "completed" });

    await startExecution(makeStore(db), runId, "single node test", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("completed");

    const node = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(nodeIds[0]) as any;
    expect(node.status).toBe("completed");
  });

  it("records metrics for single node run", async () => {
    const { runId } = makeRunWithNodes(db, "metrics test", [
      { title: "Single task", kind: "research", role: "developer", prompt: "do it" },
    ]);

    const agent = new MockAgent(db, makeStore(db), openSqliteEventStore(db));
    agent.addScript({ match: {}, status: "completed" });

    await startExecution(makeStore(db), runId, "metrics test", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const metrics = getRunMetrics(makeStore(db), runId);
    expect(metrics).not.toBeNull();
    expect(metrics!.task_count).toBe(1);
    expect(metrics!.completed_count).toBe(1);
    expect(metrics!.wall_time_ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// startExecution: sequential chain
// ---------------------------------------------------------------------------

describe("individual-task: sequential chain", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("executes a 3-node chain in order", async () => {
    const { runId, nodeIds } = makeRunWithNodes(db, "chain", [
      { title: "Step 1", kind: "research", role: "developer" },
      { title: "Step 2", kind: "research", role: "developer", depends_on: ["Step 1"] },
      { title: "Step 3", kind: "research", role: "developer", depends_on: ["Step 2"] },
    ]);

    const agent = new MockAgent(db, makeStore(db), openSqliteEventStore(db));
    agent.addScript({ match: {}, status: "completed" });

    await startExecution(makeStore(db), runId, "chain", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    for (const nodeId of nodeIds) {
      const node = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(nodeId) as any;
      expect(node.status).toBe("completed");
    }
  });
});

// ---------------------------------------------------------------------------
// startExecution: node work item mapping
// ---------------------------------------------------------------------------

describe("individual-task: node_work_items mapping", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("respects provided node_work_items map", async () => {
    const { runId, nodeIds } = makeRunWithNodes(db, "mapped", [
      { title: "Mapped task", kind: "research", role: "developer" },
    ]);

    const itemMap = new Map([[nodeIds[0], "work_item_abc"]]);
    const agent = new MockAgent(db, makeStore(db), openSqliteEventStore(db));
    agent.addScript({ match: {}, status: "completed" });

    const state = await startExecution(makeStore(db), runId, "mapped", agent.spawnFn(), { node_work_items: itemMap });
    expect(state.node_work_items!.get(nodeIds[0])).toBe("work_item_abc");

    await waitForPhase(db, runId, "completed");
  });
});

// ---------------------------------------------------------------------------
// startExecution: parallel nodes
// ---------------------------------------------------------------------------

describe("individual-task: parallel nodes", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("completes 4 parallel nodes", async () => {
    const { runId, nodeIds } = makeRunWithNodes(db, "parallel", [
      { title: "A", kind: "research", role: "developer" },
      { title: "B", kind: "research", role: "developer" },
      { title: "C", kind: "research", role: "developer" },
      { title: "D", kind: "research", role: "developer" },
    ]);

    const agent = new MockAgent(db, makeStore(db), openSqliteEventStore(db));
    agent.addScript({ match: {}, status: "completed" });

    await startExecution(makeStore(db), runId, "parallel", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    for (const nodeId of nodeIds) {
      const node = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(nodeId) as any;
      expect(node.status).toBe("completed");
    }

    const metrics = getRunMetrics(makeStore(db), runId);
    expect(metrics!.max_parallelism).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// startExecution: agent writes scratchpad
// ---------------------------------------------------------------------------

describe("individual-task: scratchpad integration", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("preserves scratchpad output from completed agent", async () => {
    const { runId, nodeIds } = makeRunWithNodes(db, "scratchpad test", [
      { title: "Research", kind: "research", role: "developer", prompt: "find things" },
    ]);

    const agent = new MockAgent(db, makeStore(db), openSqliteEventStore(db));
    agent.addScript({
      match: {},
      tools: [{ name: "write_scratchpad", args: { content: "Key finding: the answer is 42" } }],
      status: "completed",
    });

    await startExecution(makeStore(db), runId, "scratchpad test", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const entries = db.query("SELECT content FROM scratchpad_entries WHERE run_id = ?").all(runId) as any[];
    const contents = entries.map((e: any) => e.content);
    expect(contents.some((c: string) => c.includes("the answer is 42"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// startExecution: empty run (no nodes)
// ---------------------------------------------------------------------------

describe("individual-task: empty run", () => {
  it("completes immediately with no nodes", async () => {
    const db = makeDb();
    const runId = `run_empty_${Math.random().toString(36).slice(2)}`;
    db.run("INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [runId, "empty", "active", new Date().toISOString(), new Date().toISOString()]);

    const agent = new MockAgent(db, makeStore(db), openSqliteEventStore(db));
    const state = await startExecution(makeStore(db), runId, "empty", agent.spawnFn());

    expect(state.phase).toBe("completed");
  });
});
