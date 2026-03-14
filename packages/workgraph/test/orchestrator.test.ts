import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";
import {
  startOrchestration,
  startExecution,
  onPlanningComplete,
  onPlannerStopped,
  onNodeStatusUpdate,
  findReadyNodes,
  getOrchestration,
} from "../src/orchestrator/executor";
import { handleToolCall, type McpToolContext } from "../src/mcp/tools";
import type { OrchestratorRunState, NodeAgentHistory } from "../src/orchestrator/types";
import { getWorkGraph, resetWorkGraph } from "../src/orchestrator/workgraph-bridge";

function live(id: string | number, dir = String(id)) {
  return {
    id: `ses_${id}`,
    session_id: `ses_${id}`,
    runtime_type: "workspace",
    directory: `/tmp/${dir}`,
    worktree_path: `/tmp/${dir}`,
    status: "running",
  } as any
}

// ── findReadyNodes Tests ──

describe("findReadyNodes", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, size_bytes INTEGER NOT NULL
      );
    `);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Ready nodes test" }),
    });
    runId = (await res.json()).run_id;
  });

  it("should return nodes with no dependencies", () => {
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n1", runId, "developer", "code_gen", "Task 1", "pending", 0]);
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n2", runId, "developer", "code_gen", "Task 2", "pending", 0]);

    const ready = findReadyNodes(db, runId);
    expect(ready).toContain("n1");
    expect(ready).toContain("n2");
  });

  it("should not return nodes with unmet dependencies", () => {
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n1", runId, "developer", "code_gen", "Task 1", "pending", 0]);
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n2", runId, "developer", "code_gen", "Task 2", "pending", 0]);
    db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      ["e1", runId, "n1", "n2", "depends_on"]);

    const ready = findReadyNodes(db, runId);
    expect(ready).toContain("n1");
    expect(ready).not.toContain("n2");
  });

  it("should return nodes after dependencies complete", () => {
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n1", runId, "developer", "code_gen", "Task 1", "completed", 0]);
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n2", runId, "developer", "code_gen", "Task 2", "pending", 0]);
    db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      ["e1", runId, "n1", "n2", "depends_on"]);

    const ready = findReadyNodes(db, runId);
    expect(ready).toContain("n2");
  });

  it("should cascade failure from failed dependencies", () => {
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n1", runId, "developer", "code_gen", "Task 1", "failed", 0]);
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n2", runId, "developer", "code_gen", "Task 2", "pending", 0]);
    db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      ["e1", runId, "n1", "n2", "depends_on"]);

    const ready = findReadyNodes(db, runId);
    expect(ready).not.toContain("n2");

    // n2 should now be marked failed
    const node = db.query("SELECT status FROM nodes_current WHERE node_id = 'n2'").get() as any;
    expect(node.status).toBe("failed");
  });

  it("should not return active or completed nodes", () => {
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n1", runId, "developer", "code_gen", "Task 1", "active", 0]);
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["n2", runId, "developer", "code_gen", "Task 2", "completed", 0]);

    const ready = findReadyNodes(db, runId);
    expect(ready).toHaveLength(0);
  });
});

// ── onPlanningComplete Tests ──

describe("onPlanningComplete", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, size_bytes INTEGER NOT NULL
      );
    `);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Planning complete test" }),
    });
    runId = (await res.json()).run_id;
  });

  it("should spawn agents for ready nodes after planning", async () => {
    // First, start orchestration to register state
    const spawnedAgents: Array<{ prompt: string; nodeId: string }> = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      spawnedAgents.push({ prompt, nodeId: nId });
      return live(spawnedAgents.length, nId || `planner-${spawnedAgents.length}`);
    };

    await startOrchestration(db, runId, "test", mockSpawn);

    // Build graph via MCP tools
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Task 1", kind: "code_gen", role: "developer", prompt: "Do task 1",
    });
    const n2 = await handleToolCall(ctx, "create_node", {
      title: "Task 2", kind: "code_gen", role: "developer", prompt: "Do task 2",
      depends_on: [n1.node_id],
    });

    // Reset spawn tracking (startOrchestration already spawned the planner)
    spawnedAgents.length = 0;

    // Trigger planning complete
    await onPlanningComplete(db, runId, "Test plan", mockSpawn);

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("executing");

    // Only n1 should be spawned (n2 depends on n1)
    expect(spawnedAgents).toHaveLength(1);
    expect(spawnedAgents[0].nodeId).toBe(n1.node_id);
  });

  it("guides the planner toward cohesive nodes that can parallelize internally", async () => {
    const calls: string[] = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      calls.push(prompt);
      return live(calls.length, nId || `planner-${calls.length}`);
    };

    await startOrchestration(db, runId, "Review this codebase", mockSpawn);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Prefer fewer cohesive tasks when one capable executor can decompose or parallelize the internal work with its own harness.");
    expect(calls[0]).toContain("Do not create broad specialist buckets like API/UI/tests/infra just for coverage.");
    expect(calls[0]).toContain("When a node can internally decompose or parallelize, say that explicitly in its prompt and ask for one consolidated output for the node.");
  });

  it("should complete immediately if no nodes exist", async () => {
    const mockSpawn = async () => live(1, "planner");
    await startOrchestration(db, runId, "empty", mockSpawn);

    await onPlanningComplete(db, runId, "Empty plan", mockSpawn);

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("completed");
  });

  it("should stop at planned when auto_execute is disabled", async () => {
    const spawnedAgents: Array<{ nodeId: string }> = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      spawnedAgents.push({ nodeId: nId });
      return live(spawnedAgents.length, nId || `planner-${spawnedAgents.length}`);
    };

    await startOrchestration(
      db,
      runId,
      "plan only",
      mockSpawn,
      undefined,
      { auto_execute: false },
    );

    const ctx: McpToolContext = { db, runId };
    await handleToolCall(ctx, "create_node", {
      title: "Task 1",
      kind: "code_gen",
      role: "developer",
      prompt: "Do task 1",
    });

    spawnedAgents.length = 0;

    await onPlanningComplete(db, runId, "Plan ready", mockSpawn);

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("planned");
    expect(state.result).toBe("Plan ready");
    expect(spawnedAgents).toHaveLength(0);

    const run = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
    expect(run.status).toBe("planned");
  });

  it("does not create a running node attempt when launch is not attachable", async () => {
    const mockSpawn = async (prompt: string, rId: string, nId: string) =>
      nId ? ({ id: "legacy_agent", status: "running" } as any) : live("planner", "planner");

    await startOrchestration(db, runId, "bad launch", mockSpawn);

    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Task 1",
      kind: "code_gen",
      role: "developer",
      prompt: "Do task 1",
    });

    await onPlanningComplete(db, runId, "Plan ready", mockSpawn);

    const node = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any;
    const attempt = db.query("SELECT attempt_id FROM attempts_current WHERE node_id = ?").get(n1.node_id) as any;
    expect(node.status).toBe("pending");
    expect(attempt).toBeNull();
  });

  it("tells task agents they may parallelize internally within one node", async () => {
    const calls: Array<{ prompt: string; nodeId: string }> = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      calls.push({ prompt, nodeId: nId });
      return live(calls.length, nId || `planner-${calls.length}`);
    };

    await startOrchestration(db, runId, "parallelize inside node", mockSpawn);

    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Review auth flows",
      kind: "review",
      role: "code_reviewer",
      prompt: "Review the auth flows and return one consolidated report.",
    });

    calls.length = 0;
    await onPlanningComplete(db, runId, "Plan ready", mockSpawn);

    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe(n1.node_id);
    expect(calls[0].prompt).toContain("you may decompose and parallelize them internally using your own harness");
    expect(calls[0].prompt).toContain("return one consolidated result for this node");
  });

  it("should fail the run when the planner agent exits before finish_planning", async () => {
    await startOrchestration(db, runId, "planner fail", async () => live("fail", "planner"));
    await onPlannerStopped(db, runId, "ses_fail", "Auth failed");

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("Auth failed");

    const run = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
    expect(run.status).toBe("failed");
  });
});

// ── onNodeStatusUpdate Tests ──

describe("onNodeStatusUpdate", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, size_bytes INTEGER NOT NULL
      );
    `);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Node status test" }),
    });
    runId = (await res.json()).run_id;
  });

  it("should cascade to downstream nodes when a node completes", async () => {
    const spawnedAgents: Array<{ nodeId: string }> = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      spawnedAgents.push({ nodeId: nId });
      return live(spawnedAgents.length, nId || `planner-${spawnedAgents.length}`);
    };

    await startOrchestration(db, runId, "test", mockSpawn);

    // Build graph: n1 -> n2
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "First", kind: "code_gen", role: "developer", prompt: "First task",
    });
    const n2 = await handleToolCall(ctx, "create_node", {
      title: "Second", kind: "code_gen", role: "developer", prompt: "Second task",
      depends_on: [n1.node_id],
    });

    // Start execution
    spawnedAgents.length = 0;
    await onPlanningComplete(db, runId, "Cascade test", mockSpawn);

    expect(spawnedAgents).toHaveLength(1);
    expect(spawnedAgents[0].nodeId).toBe(n1.node_id);

    // Mark n1 as active in state so onNodeStatusUpdate can find it
    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    });

    // Complete n1 — should cascade and spawn n2
    spawnedAgents.length = 0;
    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", mockSpawn);

    expect(spawnedAgents).toHaveLength(1);
    expect(spawnedAgents[0].nodeId).toBe(n2.node_id);
  });

  it("should mark run completed when all nodes finish", async () => {
    const mockSpawn = async (prompt: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "test", mockSpawn);

    // Create single node
    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Only task", kind: "code_gen", role: "developer", prompt: "Do it",
    });

    await onPlanningComplete(db, runId, "One task", mockSpawn);

    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    });

    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", mockSpawn);

    expect(state.phase).toBe("completed");
    const run = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
    expect(run.status).toBe("completed");
  });

  it("should retry failed nodes up to MAX_RETRIES", async () => {
    const spawnedAgents: string[] = [];
    const mockSpawn = async (prompt: string, rId: string, nId: string) => {
      spawnedAgents.push(nId);
      return live(spawnedAgents.length, nId || `planner-${spawnedAgents.length}`);
    };

    await startOrchestration(db, runId, "test", mockSpawn);

    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Flaky task", kind: "code_gen", role: "developer", prompt: "May fail",
    });

    await onPlanningComplete(db, runId, "Retry test", mockSpawn);

    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    });

    // First failure — should retry
    spawnedAgents.length = 0;
    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", mockSpawn, "Transient error");

    const retryCount = (db.query("SELECT retry_count FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any).retry_count;
    expect(retryCount).toBe(1);
    expect(spawnedAgents).toHaveLength(1); // retried
  });

  it("should mark node failed after max retries exhausted", async () => {
    const mockSpawn = async (prompt: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "test", mockSpawn);

    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Doomed task", kind: "code_gen", role: "developer", prompt: "Will fail",
    });

    // Set retry_count to max (2) — next failure should be final
    db.run("UPDATE nodes_current SET retry_count = 2, status = 'active' WHERE node_id = ?", [n1.node_id]);

    await onPlanningComplete(db, runId, "Max retry test", mockSpawn);

    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    });

    await onNodeStatusUpdate(db, runId, n1.node_id, "failed", mockSpawn, "Final failure");

    const node = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(n1.node_id) as any;
    expect(node.status).toBe("failed");
  });

  it("should aggregate result from scratchpad entries on completion", async () => {
    const mockSpawn = async (prompt: string, rId: string, nId: string) => live(nId || "planner", nId || "planner");

    await startOrchestration(db, runId, "test", mockSpawn);

    const ctx: McpToolContext = { db, runId };
    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Only task", kind: "code_gen", role: "developer", prompt: "Do it",
    });

    // Add scratchpad result
    db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["sp_result", runId, n1.node_id, "Built the API successfully", new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 30]
    );

    await onPlanningComplete(db, runId, "Result test", mockSpawn);

    const state = getOrchestration(runId)!;
    state.node_agents.set(n1.node_id, {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: new Date().toISOString(), finished_at: null }],
    });

    await onNodeStatusUpdate(db, runId, n1.node_id, "completed", mockSpawn);

    expect(state.phase).toBe("completed");
    expect(state.result).toContain("Built the API successfully");
  });
});

describe("source-backed execution", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    resetWorkGraph();
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, size_bytes INTEGER NOT NULL
      );
    `);
  });

  it("returns the source to planned when a ready-slice run completes with work remaining", async () => {
    const sourceId = "src_test";
    const runId = "run_slice";
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO sources_current (source_id, goal, kind, title, content, source_path, status, plan_run_id, last_run_id, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [sourceId, "Execute ready work", "spec", "Spec", "Do the work", null, "planned", null, null, null, now, now],
    );
    db.run("INSERT INTO runs_current (run_id, goal, status, source_id) VALUES (?, ?, ?, ?)", [
      runId,
      "Execute ready work",
      "active",
      sourceId,
    ]);
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["node_ready", runId, "developer", "code_gen", "Task A", "pending", 0],
    );

    const wg = getWorkGraph();
    const a = wg.create({ sourceId, title: "Task A" });
    const b = wg.create({ sourceId, title: "Task B" });
    wg.addDep(a.id, b.id);

    await startExecution(
      db,
      runId,
      "Execute ready work",
      async () => live(1, "node_ready"),
      new Map([["node_ready", a.id]]),
    );

    const state = getOrchestration(runId)!;
    state.node_agents.set("node_ready", {
      current_agent_id: "agent_1",
      history: [{ agent_id: "agent_1", status: "running", started_at: now, finished_at: null }],
    });

    await onNodeStatusUpdate(
      db,
      runId,
      "node_ready",
      "completed",
      async () => live(2, "node_ready"),
    );

    const source = db
      .query("SELECT status, last_run_id FROM sources_current WHERE source_id = ?")
      .get(sourceId) as any;
    expect(source.status).toBe("planned");
    expect(source.last_run_id).toBe(runId);
    expect(wg.get(a.id)?.status).toBe("done");
    expect(wg.get(b.id)?.status).toBe("open");
  });
});

// ── MCP update_status / write_scratchpad / read_scratchpads Tests ──

describe("MCP task agent tools", () => {
  let db: InstanceType<typeof Database>;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, size_bytes INTEGER NOT NULL
      );
    `);
    const app = createApp(db);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Task agent tools test" }),
    });
    runId = (await res.json()).run_id;
  });

  it("should write and read scratchpad entries", async () => {
    // Create a node first
    const ctx: McpToolContext = { db, runId };
    const node = await handleToolCall(ctx, "create_node", {
      title: "Task", kind: "code_gen", role: "developer", prompt: "Do task",
    });

    const nodeCtx: McpToolContext = { db, runId, nodeId: node.node_id };

    // Write scratchpad
    const writeResult = await handleToolCall(nodeCtx, "write_scratchpad", {
      content: "Found 3 relevant APIs",
    });
    expect(writeResult).toHaveProperty("scratchpad_id");

    // Read scratchpad
    const readResult = await handleToolCall(nodeCtx, "read_scratchpads", {});
    // Should include original prompt + new entry
    expect(readResult.entries.length).toBeGreaterThanOrEqual(2);
    expect(readResult.entries.some((e: any) => e.content === "Found 3 relevant APIs")).toBe(true);
  });

  it("should read upstream scratchpads for downstream nodes", async () => {
    const ctx: McpToolContext = { db, runId };

    const n1 = await handleToolCall(ctx, "create_node", {
      title: "Upstream", kind: "research", role: "developer", prompt: "Research",
    });
    const n2 = await handleToolCall(ctx, "create_node", {
      title: "Downstream", kind: "code_gen", role: "developer", prompt: "Build",
      depends_on: [n1.node_id],
    });

    // Write extra entry to upstream node
    await handleToolCall({ db, runId, nodeId: n1.node_id }, "write_scratchpad", {
      content: "Upstream findings",
    });

    // Mark upstream as completed
    db.run("UPDATE nodes_current SET status = 'completed' WHERE node_id = ?", [n1.node_id]);

    // Read from downstream context — should see upstream entries
    const readResult = await handleToolCall({ db, runId, nodeId: n2.node_id }, "read_scratchpads", {});

    const contents = readResult.entries.map((e: any) => e.content);
    expect(contents).toContain("Upstream findings");
  });

  it("should update node status via update_status tool", async () => {
    let completedNodeId: string | null = null;
    const ctx: McpToolContext = {
      db,
      runId,
      onNodeCompleted: (rId, nId) => { completedNodeId = nId; },
    };

    const node = await handleToolCall(ctx, "create_node", {
      title: "Task", kind: "code_gen", role: "developer", prompt: "Do task",
    });

    const result = await handleToolCall(ctx, "update_status", {
      node_id: node.node_id,
      status: "completed",
    });

    expect(result).toEqual({ ok: true });
    expect(completedNodeId).toBe(node.node_id);

    const dbNode = db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(node.node_id) as any;
    expect(dbNode.status).toBe("completed");
  });

  it("should get run status via get_run_status tool", async () => {
    const ctx: McpToolContext = { db, runId };

    await handleToolCall(ctx, "create_node", {
      title: "A", kind: "code_gen", role: "developer", prompt: "A",
    });
    await handleToolCall(ctx, "create_node", {
      title: "B", kind: "code_gen", role: "developer", prompt: "B",
    });

    const status = await handleToolCall(ctx, "get_run_status", {});
    expect(status.total_nodes).toBe(2);
    expect(status.pending).toBe(2);
  });
});

// ── Node title tests ──

describe("nodes_current title column", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeDb(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS scratchpad_entries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, size_bytes INTEGER NOT NULL
      );
    `);
    app = createApp(db);
  });

  it("should store title when creating a node via API", async () => {
    const runRes = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test" }),
    });
    const run = await runRes.json();

    const nodeRes = await app.request(`/runs/${run.run_id}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "code_gen", role: "developer", title: "Setup DB Schema" }),
    });

    expect(nodeRes.status).toBe(201);
    const node = await nodeRes.json();
    expect(node.title).toBe("Setup DB Schema");

    const dbNode = db.query("SELECT title FROM nodes_current WHERE node_id = ?").get(node.node_id) as any;
    expect(dbNode.title).toBe("Setup DB Schema");
  });

  it("should store title via MCP create_node tool", async () => {
    db.run("INSERT INTO runs_current (run_id, goal, status) VALUES (?, ?, ?)", ["run_test", "test", "active"]);

    const ctx: McpToolContext = { db, runId: "run_test" };
    const result = await handleToolCall(ctx, "create_node", {
      title: "Build API",
      kind: "code_gen",
      role: "developer",
      prompt: "Build it",
    });

    const node = db.query("SELECT title FROM nodes_current WHERE node_id = ?").get(result.node_id) as any;
    expect(node.title).toBe("Build API");
  });
});
