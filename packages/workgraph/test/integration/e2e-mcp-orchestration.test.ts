/**
 * End-to-end tests for MCP-driven orchestration.
 *
 * These tests simulate the full lifecycle: a planner agent uses MCP tools
 * to build a task graph, the executor cascades execution, and task agents
 * self-report completion via MCP update_status. No real LLM is involved —
 * we call the MCP tools and executor callbacks directly, simulating what
 * the agents would do.
 *
 * Scenarios covered:
 *   1. Happy path: linear chain (A → B → C)
 *   2. Diamond dependency (A → B, A → C, B → D, C → D)
 *   3. Wide parallel graph (many independent tasks)
 *   4. Deep sequential chain (A → B → C → D → E)
 *   5. Failure with retry then success
 *   6. Max retries exhausted → cascading failure
 *   7. Mixed success/failure branches
 *   8. Scratchpad communication between agents
 *   9. Empty plan (zero nodes)
 *  10. Single task plan
 *  11. Cancel mid-execution
 *  12. Graph validation catches cycles
 *  13. Deadlock detection
 *  14. Event audit trail integrity
 *  15. Run status queries at each phase
 *  16. WorkGraph item integration (link, progress, completion)
 *  17. HTTP API e2e (create run → GET status → complete via MCP)
 *  18. Complex real-world graph (architect → parallel devs → reviewer → QA)
 *  19. Artifact creation flow
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../../src/app";
import {
  startOrchestration,
  onPlanningComplete,
  onNodeStatusUpdate,
  findReadyNodes,
  getOrchestration,
  cancelOrchestration,
} from "../../src/orchestrator/executor";
import {
  handleToolCall,
  getToolDefinitions,
  type McpToolContext,
} from "../../src/mcp/tools";
import {
  getWorkGraph,
  resetWorkGraph,
  linkRun,
  getItemForRun,
} from "../../src/orchestrator/workgraph-bridge";
import type { OrchestratorRunState } from "../../src/orchestrator/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up a fresh in-memory DB + run */
async function setupRun(goal = "E2E test") {
  const db = new Database(":memory:");
  initializeDb(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS scratchpad_entries (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL
    );
  `);

  const app = createApp(db);
  const res = await app.request("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  const { run_id: runId } = await res.json();

  return { db, app, runId };
}

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

/** Tracks spawned agents for assertion */
function createAgentTracker() {
  const spawned: Array<{ prompt: string; runId: string; nodeId: string }> = [];
  const spawnFn = async (prompt: string, runId: string, nodeId: string) => {
    spawned.push({ prompt, runId, nodeId });
    return live(spawned.length, nodeId || `planner-${spawned.length}`);
  };
  return { spawned, spawnFn };
}

/** Register run in executor's in-memory map */
async function registerRun(
  db: any,
  runId: string,
  spawnFn: any,
): Promise<OrchestratorRunState> {
  return startOrchestration(db, runId, "test", spawnFn);
}

/** Simulate planner building a graph via MCP tools. Returns node ID map. */
async function buildGraph(
  db: any,
  runId: string,
  tasks: Array<{
    key: string;
    title: string;
    kind: string;
    role: string;
    prompt: string;
    depends_on_keys?: string[];
  }>,
): Promise<Map<string, string>> {
  const ctx: McpToolContext = { db, runId };
  const keyToNodeId = new Map<string, string>();

  for (const task of tasks) {
    const dependsOn = (task.depends_on_keys || []).map((k) => {
      const nid = keyToNodeId.get(k);
      if (!nid) throw new Error(`Unknown dependency key: ${k}`);
      return nid;
    });

    const result = await handleToolCall(ctx, "create_node", {
      title: task.title,
      kind: task.kind,
      role: task.role,
      prompt: task.prompt,
      depends_on: dependsOn.length > 0 ? dependsOn : undefined,
    });

    if (result.error) throw new Error(result.error);
    keyToNodeId.set(task.key, result.node_id);
  }

  return keyToNodeId;
}

/** Wire node_agents in state so onNodeStatusUpdate can find them */
function wireAgents(state: OrchestratorRunState, nodeIds: string[]) {
  for (const nodeId of nodeIds) {
    state.node_agents.set(nodeId, {
      current_agent_id: `agent_${nodeId}`,
      history: [{
        agent_id: `agent_${nodeId}`,
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
      }],
    });
  }
}

/** Complete a node via the executor callback (simulates MCP update_status) */
async function completeNode(
  db: any,
  runId: string,
  nodeId: string,
  spawnFn: any,
) {
  const state = getOrchestration(runId)!;
  wireAgents(state, [nodeId]);
  await onNodeStatusUpdate(db, runId, nodeId, "completed", spawnFn);
}

/** Fail a node via the executor callback */
async function failNode(
  db: any,
  runId: string,
  nodeId: string,
  spawnFn: any,
  error = "Task failed",
) {
  const state = getOrchestration(runId)!;
  wireAgents(state, [nodeId]);
  await onNodeStatusUpdate(db, runId, nodeId, "failed", spawnFn, error);
}

/** Get DB node status */
function nodeStatus(db: any, nodeId: string): string {
  return (db.query("SELECT status FROM nodes_current WHERE node_id = ?").get(nodeId) as any)?.status;
}

/** Get all DB nodes for a run */
function allNodes(db: any, runId: string) {
  return db.query("SELECT * FROM nodes_current WHERE run_id = ?").all(runId) as any[];
}

// ==========================================================================
// TESTS
// ==========================================================================

describe("E2E MCP Orchestration", () => {
  beforeEach(() => {
    resetWorkGraph();
  });

  // ── 1. Happy path: linear chain A → B → C ──

  describe("1. Linear chain (A → B → C)", () => {
    it("should execute tasks sequentially through the full lifecycle", async () => {
      const { db, runId } = await setupRun("Linear chain test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Research", kind: "research", role: "architect", prompt: "Research APIs" },
        { key: "B", title: "Build", kind: "code_gen", role: "developer", prompt: "Build API", depends_on_keys: ["A"] },
        { key: "C", title: "Test", kind: "test", role: "qa", prompt: "Write tests", depends_on_keys: ["B"] },
      ]);

      // Validate graph
      const validation = await handleToolCall({ db, runId }, "validate_graph", {});
      expect(validation.valid).toBe(true);

      // Planning complete → starts execution
      spawned.length = 0;
      await onPlanningComplete(db, runId, "Linear plan", spawnFn);

      // Only A should be spawned (no deps)
      expect(spawned).toHaveLength(1);
      expect(spawned[0].nodeId).toBe(nodes.get("A"));
      expect(nodeStatus(db, nodes.get("A")!)).toBe("active");
      expect(nodeStatus(db, nodes.get("B")!)).toBe("pending");
      expect(nodeStatus(db, nodes.get("C")!)).toBe("pending");

      // Complete A → should spawn B
      spawned.length = 0;
      await completeNode(db, runId, nodes.get("A")!, spawnFn);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].nodeId).toBe(nodes.get("B"));
      expect(nodeStatus(db, nodes.get("B")!)).toBe("active");

      // Complete B → should spawn C
      spawned.length = 0;
      await completeNode(db, runId, nodes.get("B")!, spawnFn);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].nodeId).toBe(nodes.get("C"));

      // Complete C → run completes
      await completeNode(db, runId, nodes.get("C")!, spawnFn);
      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("completed");

      const run = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
      expect(run.status).toBe("completed");
    });
  });

  // ── 2. Diamond dependency graph ──

  describe("2. Diamond graph (A → B+C → D)", () => {
    it("should run B and C in parallel after A, then D after both", async () => {
      const { db, runId } = await setupRun("Diamond test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Plan", kind: "research", role: "architect", prompt: "Plan" },
        { key: "B", title: "Frontend", kind: "code_gen", role: "developer", prompt: "Build UI", depends_on_keys: ["A"] },
        { key: "C", title: "Backend", kind: "code_gen", role: "developer", prompt: "Build API", depends_on_keys: ["A"] },
        { key: "D", title: "Integrate", kind: "review", role: "code_reviewer", prompt: "Review", depends_on_keys: ["B", "C"] },
      ]);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Diamond plan", spawnFn);

      // Only A ready
      expect(spawned).toHaveLength(1);
      expect(spawned[0].nodeId).toBe(nodes.get("A"));

      // Complete A → B and C should both spawn (parallel)
      spawned.length = 0;
      await completeNode(db, runId, nodes.get("A")!, spawnFn);
      expect(spawned).toHaveLength(2);
      const spawnedNodeIds = spawned.map((s) => s.nodeId);
      expect(spawnedNodeIds).toContain(nodes.get("B"));
      expect(spawnedNodeIds).toContain(nodes.get("C"));

      // Complete B only → D should NOT spawn yet (C still pending)
      spawned.length = 0;
      await completeNode(db, runId, nodes.get("B")!, spawnFn);
      expect(spawned).toHaveLength(0);

      // Complete C → D should now spawn
      spawned.length = 0;
      await completeNode(db, runId, nodes.get("C")!, spawnFn);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].nodeId).toBe(nodes.get("D"));

      // Complete D → run done
      await completeNode(db, runId, nodes.get("D")!, spawnFn);
      expect(getOrchestration(runId)!.phase).toBe("completed");
    });
  });

  // ── 3. Wide parallel graph ──

  describe("3. Wide parallel graph (8 independent tasks)", () => {
    it("should spawn all tasks immediately since none have dependencies", async () => {
      const { db, runId } = await setupRun("Parallel test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const tasks = Array.from({ length: 8 }, (_, i) => ({
        key: `T${i}`,
        title: `Task ${i}`,
        kind: "code_gen",
        role: "developer",
        prompt: `Implement feature ${i}`,
      }));

      const nodes = await buildGraph(db, runId, tasks);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Parallel plan", spawnFn);

      // All 8 should be spawned
      expect(spawned).toHaveLength(8);

      // Complete all → run done
      for (const [key, nodeId] of nodes) {
        await completeNode(db, runId, nodeId, spawnFn);
      }

      expect(getOrchestration(runId)!.phase).toBe("completed");
    });
  });

  // ── 4. Deep sequential chain ──

  describe("4. Deep chain (A → B → C → D → E)", () => {
    it("should execute each task only after its predecessor completes", async () => {
      const { db, runId } = await setupRun("Deep chain test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const keys = ["A", "B", "C", "D", "E"];
      const tasks = keys.map((key, i) => ({
        key,
        title: `Step ${key}`,
        kind: "code_gen",
        role: "developer",
        prompt: `Do step ${key}`,
        depends_on_keys: i > 0 ? [keys[i - 1]] : undefined,
      }));

      const nodes = await buildGraph(db, runId, tasks);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Sequential plan", spawnFn);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].nodeId).toBe(nodes.get("A"));

      // Complete each in sequence — each should trigger exactly the next one
      for (let i = 0; i < keys.length; i++) {
        spawned.length = 0;
        await completeNode(db, runId, nodes.get(keys[i])!, spawnFn);

        if (i < keys.length - 1) {
          expect(spawned).toHaveLength(1);
          expect(spawned[0].nodeId).toBe(nodes.get(keys[i + 1]));
        }
      }

      expect(getOrchestration(runId)!.phase).toBe("completed");
    });
  });

  // ── 5. Failure with retry then success ──

  describe("5. Retry on failure then succeed", () => {
    it("should retry a failed node and eventually succeed", async () => {
      const { db, runId } = await setupRun("Retry test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Flaky task", kind: "code_gen", role: "developer", prompt: "May fail" },
      ]);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Retry plan", spawnFn);
      expect(spawned).toHaveLength(1);

      const nodeId = nodes.get("A")!;

      // First attempt fails → should retry (retry_count 0 → 1)
      spawned.length = 0;
      await failNode(db, runId, nodeId, spawnFn, "Transient error");
      const retryCount = (db.query("SELECT retry_count FROM nodes_current WHERE node_id = ?").get(nodeId) as any).retry_count;
      expect(retryCount).toBe(1);
      expect(spawned).toHaveLength(1); // retried

      // Second attempt succeeds
      await completeNode(db, runId, nodeId, spawnFn);
      expect(getOrchestration(runId)!.phase).toBe("completed");
    });
  });

  // ── 6. Max retries exhausted → cascading failure ──

  describe("6. Max retries + cascading failure", () => {
    it("should cascade failure to all downstream nodes", async () => {
      const { db, runId } = await setupRun("Cascade failure test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Root", kind: "code_gen", role: "developer", prompt: "Root" },
        { key: "B", title: "Mid", kind: "code_gen", role: "developer", prompt: "Mid", depends_on_keys: ["A"] },
        { key: "C", title: "Leaf", kind: "test", role: "qa", prompt: "Leaf", depends_on_keys: ["B"] },
      ]);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Cascade plan", spawnFn);

      const nodeA = nodes.get("A")!;
      const nodeB = nodes.get("B")!;
      const nodeC = nodes.get("C")!;

      // Exhaust all retries (MAX_RETRIES = 2): fail 3 times
      // Set retry_count to 2 directly to simulate prior failures
      db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [nodeA]);

      await failNode(db, runId, nodeA, spawnFn, "Permanent failure");

      // A should be failed
      expect(nodeStatus(db, nodeA)).toBe("failed");

      // B and C should also be failed (cascade)
      expect(nodeStatus(db, nodeB)).toBe("failed");
      expect(nodeStatus(db, nodeC)).toBe("failed");

      expect(getOrchestration(runId)!.phase).toBe("failed");
    });
  });

  // ── 7. Mixed success/failure branches ──

  describe("7. Mixed branches (one fails, one succeeds)", () => {
    it("should complete the run with partial success", async () => {
      const { db, runId } = await setupRun("Mixed test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      // A → B (will succeed), A → C (will fail) → D (will cascade fail)
      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Root", kind: "research", role: "architect", prompt: "Plan" },
        { key: "B", title: "Good branch", kind: "code_gen", role: "developer", prompt: "This works" },
        { key: "C", title: "Bad branch", kind: "code_gen", role: "developer", prompt: "This fails", depends_on_keys: ["A"] },
        { key: "D", title: "After bad", kind: "test", role: "qa", prompt: "Blocked", depends_on_keys: ["C"] },
      ]);

      // Add edge A → B manually (buildGraph uses depends_on in create_node)
      await handleToolCall({ db, runId }, "add_edge", {
        source_id: nodes.get("A")!,
        target_id: nodes.get("B")!,
      });

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Mixed plan", spawnFn);

      // Complete A
      await completeNode(db, runId, nodes.get("A")!, spawnFn);

      // B and C are now spawned
      // Complete B
      await completeNode(db, runId, nodes.get("B")!, spawnFn);

      // Fail C (exhaust retries)
      db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [nodes.get("C")!]);
      await failNode(db, runId, nodes.get("C")!, spawnFn, "Permanent error");

      // D should cascade fail, B is completed, A is completed
      expect(nodeStatus(db, nodes.get("B")!)).toBe("completed");
      expect(nodeStatus(db, nodes.get("C")!)).toBe("failed");
      expect(nodeStatus(db, nodes.get("D")!)).toBe("failed");

      // Run should be completed (some succeeded, some failed, but all terminal)
      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("completed");
      expect(state.result).toBeTruthy();
    });
  });

  // ── 8. Scratchpad communication between agents ──

  describe("8. Scratchpad communication", () => {
    it("should allow downstream agents to read upstream scratchpad entries", async () => {
      const { db, runId } = await setupRun("Scratchpad test");
      const { spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "researcher", title: "Research", kind: "research", role: "architect", prompt: "Research best practices" },
        { key: "builder", title: "Build", kind: "code_gen", role: "developer", prompt: "Implement", depends_on_keys: ["researcher"] },
      ]);

      await onPlanningComplete(db, runId, "Scratchpad plan", spawnFn);

      const researcherId = nodes.get("researcher")!;
      const builderId = nodes.get("builder")!;

      // Researcher writes findings to scratchpad
      const writeResult = await handleToolCall(
        { db, runId, nodeId: researcherId },
        "write_scratchpad",
        { content: "Use REST for public APIs and gRPC for internal services" },
      );
      expect(writeResult.scratchpad_id).toBeTruthy();

      // Write another entry
      await handleToolCall(
        { db, runId, nodeId: researcherId },
        "write_scratchpad",
        { content: "Use PostgreSQL for relational data, Redis for caching" },
      );

      // Complete researcher
      await completeNode(db, runId, researcherId, spawnFn);

      // Builder reads scratchpads — should see upstream (researcher) entries
      const readResult = await handleToolCall(
        { db, runId, nodeId: builderId },
        "read_scratchpads",
        {},
      );

      const contents = readResult.entries.map((e: any) => e.content);
      expect(contents).toContain("Use REST for public APIs and gRPC for internal services");
      expect(contents).toContain("Use PostgreSQL for relational data, Redis for caching");
      // Should also contain builder's own prompt
      expect(contents.some((c: string) => c.includes("Implement"))).toBe(true);
    });

    it("should NOT expose scratchpad from incomplete upstream nodes", async () => {
      const { db, runId } = await setupRun("Incomplete upstream test");
      const { spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Upstream", kind: "research", role: "developer", prompt: "Research" },
        { key: "B", title: "Downstream", kind: "code_gen", role: "developer", prompt: "Build", depends_on_keys: ["A"] },
      ]);

      // Write to upstream WITHOUT completing it
      await handleToolCall(
        { db, runId, nodeId: nodes.get("A")! },
        "write_scratchpad",
        { content: "Incomplete draft" },
      );

      // Downstream reads — should NOT see upstream entries (upstream not completed)
      const readResult = await handleToolCall(
        { db, runId, nodeId: nodes.get("B")! },
        "read_scratchpads",
        {},
      );

      const contents = readResult.entries.map((e: any) => e.content);
      expect(contents).not.toContain("Incomplete draft");
    });
  });

  // ── 9. Empty plan ──

  describe("9. Empty plan (no nodes)", () => {
    it("should complete immediately", async () => {
      const { db, runId } = await setupRun("Empty plan test");
      const { spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      // No nodes created — finish planning
      await onPlanningComplete(db, runId, "Nothing to do", spawnFn);

      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("completed");
      expect(state.result).toBe("Nothing to do");
    });
  });

  // ── 10. Single task plan ──

  describe("10. Single task plan", () => {
    it("should execute one task and complete", async () => {
      const { db, runId } = await setupRun("Single task test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "only", title: "The Only Task", kind: "code_gen", role: "developer", prompt: "Do everything" },
      ]);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "One task plan", spawnFn);
      expect(spawned).toHaveLength(1);

      // Add a scratchpad result before completing
      await handleToolCall(
        { db, runId, nodeId: nodes.get("only")! },
        "write_scratchpad",
        { content: "Implementation complete: built REST API with 5 endpoints" },
      );

      await completeNode(db, runId, nodes.get("only")!, spawnFn);

      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("completed");
      expect(state.result).toContain("Implementation complete");
    });
  });

  // ── 11. Cancel mid-execution ──

  describe("11. Cancel mid-execution", () => {
    it("should cancel active agents and mark run cancelled", async () => {
      const { db, runId } = await setupRun("Cancel test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Task A", kind: "code_gen", role: "developer", prompt: "A" },
        { key: "B", title: "Task B", kind: "code_gen", role: "developer", prompt: "B" },
      ]);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Cancel plan", spawnFn);
      expect(spawned).toHaveLength(2); // Both independent

      const state = getOrchestration(runId)!;
      wireAgents(state, [nodes.get("A")!, nodes.get("B")!]);

      const killed: string[] = [];
      cancelOrchestration(state, db, (agentId) => killed.push(agentId));

      expect(state.phase).toBe("cancelled");
      expect(killed).toHaveLength(2);
    });
  });

  // ── 12. Graph validation catches cycles ──

  describe("12. Cycle detection", () => {
    it("should prevent cyclic edges via add_edge", async () => {
      const { db, runId } = await setupRun("Cycle test");
      const ctx: McpToolContext = { db, runId };

      const n1 = await handleToolCall(ctx, "create_node", {
        title: "A", kind: "code_gen", role: "developer", prompt: "A",
      });
      const n2 = await handleToolCall(ctx, "create_node", {
        title: "B", kind: "code_gen", role: "developer", prompt: "B",
      });
      const n3 = await handleToolCall(ctx, "create_node", {
        title: "C", kind: "code_gen", role: "developer", prompt: "C",
      });

      await handleToolCall(ctx, "add_edge", { source_id: n1.node_id, target_id: n2.node_id });
      await handleToolCall(ctx, "add_edge", { source_id: n2.node_id, target_id: n3.node_id });

      // This would create A→B→C→A (cycle)
      const result = await handleToolCall(ctx, "add_edge", {
        source_id: n3.node_id,
        target_id: n1.node_id,
      });
      expect(result.error).toContain("cycle");

      // validate_graph should still show valid (the cycle edge was rejected)
      const validation = await handleToolCall(ctx, "validate_graph", {});
      expect(validation.valid).toBe(true);
    });

    it("should detect existing cycles via validate_graph", async () => {
      const { db, runId } = await setupRun("Existing cycle test");

      // Inject cycle directly into DB (bypassing add_edge guard)
      db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["cyc_a", runId, "developer", "code_gen", "A", "pending", 0]);
      db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["cyc_b", runId, "developer", "code_gen", "B", "pending", 0]);
      db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
        ["ce1", runId, "cyc_a", "cyc_b", "depends_on"]);
      db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
        ["ce2", runId, "cyc_b", "cyc_a", "depends_on"]);

      const result = await handleToolCall({ db, runId }, "validate_graph", {});
      expect(result.valid).toBe(false);
      expect(result.issues.some((i: string) => i.includes("cycle"))).toBe(true);
    });
  });

  // ── 13. Deadlock detection ──

  describe("13. Deadlock detection", () => {
    it("should detect deadlock when all nodes are blocked", async () => {
      const { db, runId } = await setupRun("Deadlock test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      // Create two mutually dependent nodes (injected directly to bypass cycle check)
      db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["dl_a", runId, "developer", "code_gen", "A", "pending", 0]);
      db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["dl_b", runId, "developer", "code_gen", "B", "pending", 0]);
      db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
        ["dl_e1", runId, "dl_a", "dl_b", "depends_on"]);
      db.run("INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
        ["dl_e2", runId, "dl_b", "dl_a", "depends_on"]);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Deadlock plan", spawnFn);

      // No nodes can be ready → deadlock
      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("failed");
      expect(state.error).toContain("Deadlock");
    });
  });

  // ── 14. Event audit trail ──

  describe("14. Event audit trail", () => {
    it("should emit events for all state transitions", async () => {
      const { db, runId } = await setupRun("Event trail test");
      const { spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Task A", kind: "code_gen", role: "developer", prompt: "Do A" },
        { key: "B", title: "Task B", kind: "code_gen", role: "developer", prompt: "Do B", depends_on_keys: ["A"] },
      ]);

      // Use finish_planning MCP tool (which emits run_planned event)
      // and wire the callback to trigger execution
      await handleToolCall(
        {
          db,
          runId,
          onPlanningComplete: (_rId: string, _summary: string) => {
            onPlanningComplete(db, runId, "Event plan", spawnFn);
          },
        },
        "finish_planning",
        { summary: "Event plan" },
      );

      // Write scratchpad
      await handleToolCall(
        { db, runId, nodeId: nodes.get("A")! },
        "write_scratchpad",
        { content: "Findings" },
      );

      // Create artifact
      await handleToolCall(
        { db, runId, nodeId: nodes.get("A")! },
        "create_artifact",
        { content: "Generated code", type: "file" },
      );

      await completeNode(db, runId, nodes.get("A")!, spawnFn);
      await completeNode(db, runId, nodes.get("B")!, spawnFn);

      // Check events
      const events = db.query("SELECT type FROM events WHERE run_id = ? ORDER BY stream_seq ASC").all(runId) as any[];
      const types = events.map((e: any) => e.type);

      expect(types).toContain("run_created");
      expect(types).toContain("node_created");
      expect(types).toContain("edge_added");
      expect(types).toContain("run_planned");
      expect(types).toContain("scratchpad_written");
      expect(types).toContain("artifact_created");
      expect(types).toContain("node_status_changed");

      // Events should be sequential
      const seqs = db.query("SELECT stream_seq FROM events WHERE run_id = ? ORDER BY stream_seq ASC").all(runId) as any[];
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i].stream_seq).toBeGreaterThan(seqs[i - 1].stream_seq);
      }
    });
  });

  // ── 15. Run status at each phase ──

  describe("15. Run status queries at each phase", () => {
    it("should report accurate node counts throughout execution", async () => {
      const { db, runId } = await setupRun("Status test");
      const { spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);
      const ctx: McpToolContext = { db, runId };

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "A", kind: "code_gen", role: "developer", prompt: "A" },
        { key: "B", title: "B", kind: "code_gen", role: "developer", prompt: "B", depends_on_keys: ["A"] },
        { key: "C", title: "C", kind: "code_gen", role: "developer", prompt: "C", depends_on_keys: ["A"] },
      ]);

      // Before execution: all pending
      let status = await handleToolCall(ctx, "get_run_status", {});
      expect(status.total_nodes).toBe(3);
      expect(status.pending).toBe(3);
      expect(status.active).toBe(0);
      expect(status.completed).toBe(0);

      await onPlanningComplete(db, runId, "Status plan", spawnFn);

      // A is active, B and C pending
      status = await handleToolCall(ctx, "get_run_status", {});
      expect(status.active).toBe(1);
      expect(status.pending).toBe(2);

      // Complete A → B and C become active
      await completeNode(db, runId, nodes.get("A")!, spawnFn);
      status = await handleToolCall(ctx, "get_run_status", {});
      expect(status.completed).toBe(1);
      expect(status.active).toBe(2);
      expect(status.pending).toBe(0);

      // Complete B and C
      await completeNode(db, runId, nodes.get("B")!, spawnFn);
      await completeNode(db, runId, nodes.get("C")!, spawnFn);
      status = await handleToolCall(ctx, "get_run_status", {});
      expect(status.completed).toBe(3);
      expect(status.active).toBe(0);
    });
  });

  // ── 16. WorkGraph item integration ──

  describe("16. WorkGraph item integration", () => {
    it("should link run to WorkGraph item and track lifecycle", async () => {
      const { db, runId } = await setupRun("WorkGraph test");
      const { spawnFn } = createAgentTracker();

      const wg = getWorkGraph();
      const parentItem = wg.create({ title: "Build feature X" });
      expect(parentItem.status).toBe("open");

      // Start orchestration with work_item_id
      await startOrchestration(
        db, runId, "Build feature X",
        spawnFn,
        parentItem.id,
      );

      // Verify link
      const linkedItem = getItemForRun(runId);
      expect(linkedItem).toBeDefined();
      expect(linkedItem!.id).toBe(parentItem.id);

      const nodes = await buildGraph(db, runId, [
        { key: "impl", title: "Implement", kind: "code_gen", role: "developer", prompt: "Build it" },
      ]);

      await onPlanningComplete(db, runId, "WorkGraph plan", spawnFn);

      // Complete the task → triggers onNodeCompleted → item → in_progress
      await completeNode(db, runId, nodes.get("impl")!, spawnFn);

      // Run should be completed → item should be done
      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("completed");

      const updatedItem = wg.get(parentItem.id);
      expect(updatedItem!.status).toBe("done");
    });

    it("should keep item open on run failure (allows retry)", async () => {
      const { db, runId } = await setupRun("WorkGraph failure test");
      const { spawnFn } = createAgentTracker();

      const wg = getWorkGraph();
      const parentItem = wg.create({ title: "Risky feature" });

      await startOrchestration(
        db, runId, "Risky feature",
        spawnFn,
        parentItem.id,
      );

      const nodes = await buildGraph(db, runId, [
        { key: "risky", title: "Risky", kind: "code_gen", role: "developer", prompt: "May fail" },
      ]);

      await onPlanningComplete(db, runId, "Risky plan", spawnFn);

      // Exhaust retries
      db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [nodes.get("risky")!]);
      await failNode(db, runId, nodes.get("risky")!, spawnFn, "Permanent error");

      // Item should NOT be marked done (allows retry)
      const updatedItem = wg.get(parentItem.id);
      expect(updatedItem!.status).not.toBe("done");
    });
  });

  // ── 17. HTTP API e2e ──

  describe("17. HTTP API end-to-end", () => {
    it("should create run via POST, query graph, and track nodes", async () => {
      const { db, app, runId } = await setupRun("HTTP API test");

      // Create nodes via REST API
      const nodeARes = await app.request(`/runs/${runId}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "code_gen", role: "architect", title: "Design" }),
      });
      expect(nodeARes.status).toBe(201);
      const nodeA = await nodeARes.json();

      const nodeBRes = await app.request(`/runs/${runId}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "code_gen", role: "developer", title: "Build" }),
      });
      const nodeB = await nodeBRes.json();

      // Create edge via REST API
      const edgeRes = await app.request(`/runs/${runId}/edges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_id: nodeA.node_id,
          target_id: nodeB.node_id,
          type: "depends_on",
        }),
      });
      expect(edgeRes.status).toBe(201);

      // Query ready nodes
      const readyRes = await app.request(`/runs/${runId}/ready`);
      const ready = await readyRes.json();
      expect(ready.ready).toContain(nodeA.node_id);
      expect(ready.ready).not.toContain(nodeB.node_id);

      // Update node A status
      const patchRes = await app.request(`/runs/${runId}/nodes/${nodeA.node_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      expect(patchRes.status).toBe(200);

      // Now B should be ready
      const readyRes2 = await app.request(`/runs/${runId}/ready`);
      const ready2 = await readyRes2.json();
      expect(ready2.ready).toContain(nodeB.node_id);

      // Query events
      const eventsRes = await app.request(`/runs/${runId}/events`);
      expect(eventsRes.status).toBe(200);
      const events = await eventsRes.json();
      expect(events.length).toBeGreaterThan(0);

      // Query nodes
      const nodesRes = await app.request(`/runs/${runId}/nodes`);
      const nodesData = await nodesRes.json();
      expect(nodesData).toHaveLength(2);

      // Query edges
      const edgesRes = await app.request(`/runs/${runId}/edges`);
      const edgesData = await edgesRes.json();
      expect(edgesData).toHaveLength(1);
    });
  });

  // ── 19. Complex real-world graph ──

  describe("19. Complex graph (architect → devs → reviewer → QA)", () => {
    it("should orchestrate a realistic multi-agent project", async () => {
      const { db, runId } = await setupRun("Build a full-stack todo app with auth");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "arch", title: "Architecture design", kind: "research", role: "architect",
          prompt: "Design the system: auth module, API, frontend, database schema" },
        { key: "db", title: "Database schema", kind: "code_gen", role: "developer",
          prompt: "Create PostgreSQL schema for users and todos", depends_on_keys: ["arch"] },
        { key: "auth", title: "Auth module", kind: "code_gen", role: "developer",
          prompt: "Implement JWT auth with signup/login", depends_on_keys: ["arch", "db"] },
        { key: "api", title: "REST API", kind: "code_gen", role: "developer",
          prompt: "Build CRUD API for todos", depends_on_keys: ["arch", "db"] },
        { key: "ui", title: "Frontend UI", kind: "code_gen", role: "developer",
          prompt: "Build React frontend with todo list and auth screens", depends_on_keys: ["arch"] },
        { key: "integrate", title: "Integration", kind: "code_gen", role: "developer",
          prompt: "Wire frontend to API with auth middleware", depends_on_keys: ["auth", "api", "ui"] },
        { key: "review", title: "Code review", kind: "review", role: "code_reviewer",
          prompt: "Review all code for security, performance, and best practices", depends_on_keys: ["integrate"] },
        { key: "qa", title: "QA testing", kind: "test", role: "qa",
          prompt: "Write and run e2e tests, verify auth flow, test CRUD ops", depends_on_keys: ["review"] },
      ]);

      // Validate
      const validation = await handleToolCall({ db, runId }, "validate_graph", {});
      expect(validation.valid).toBe(true);

      // Get full graph
      const graph = await handleToolCall({ db, runId }, "get_graph", {});
      expect(graph.nodes).toHaveLength(8);
      expect(graph.edges.length).toBeGreaterThanOrEqual(9); // Count of depends_on edges

      // Execute
      spawned.length = 0;
      await onPlanningComplete(db, runId, "Full-stack todo app with auth", spawnFn);

      // Phase 1: only architect is ready
      expect(spawned).toHaveLength(1);
      expect(spawned[0].nodeId).toBe(nodes.get("arch"));

      // Architect writes scratchpad with design decisions
      await handleToolCall(
        { db, runId, nodeId: nodes.get("arch")! },
        "write_scratchpad",
        { content: "Architecture: Hono backend, React frontend, PostgreSQL, JWT for auth" },
      );

      spawned.length = 0;
      await completeNode(db, runId, nodes.get("arch")!, spawnFn);

      // Phase 2: db and ui should be ready (ui only depends on arch, db only on arch)
      const spawnedP2 = spawned.map((s) => s.nodeId);
      expect(spawnedP2).toContain(nodes.get("db"));
      expect(spawnedP2).toContain(nodes.get("ui"));
      expect(spawnedP2).not.toContain(nodes.get("auth")); // auth needs db too
      expect(spawnedP2).not.toContain(nodes.get("api")); // api needs db too

      // Complete db → auth and api should become ready
      spawned.length = 0;
      await completeNode(db, runId, nodes.get("db")!, spawnFn);
      const spawnedP3 = spawned.map((s) => s.nodeId);
      expect(spawnedP3).toContain(nodes.get("auth"));
      expect(spawnedP3).toContain(nodes.get("api"));

      // Complete ui, auth, api in any order
      await completeNode(db, runId, nodes.get("ui")!, spawnFn);
      spawned.length = 0;
      await completeNode(db, runId, nodes.get("auth")!, spawnFn);
      // integrate not yet ready — needs api too
      expect(spawned.map((s) => s.nodeId)).not.toContain(nodes.get("integrate"));

      spawned.length = 0;
      await completeNode(db, runId, nodes.get("api")!, spawnFn);
      // Now integrate should be ready
      expect(spawned.map((s) => s.nodeId)).toContain(nodes.get("integrate"));

      spawned.length = 0;
      await completeNode(db, runId, nodes.get("integrate")!, spawnFn);
      expect(spawned.map((s) => s.nodeId)).toContain(nodes.get("review"));

      spawned.length = 0;
      await completeNode(db, runId, nodes.get("review")!, spawnFn);
      expect(spawned.map((s) => s.nodeId)).toContain(nodes.get("qa"));

      await completeNode(db, runId, nodes.get("qa")!, spawnFn);

      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("completed");

      // All 8 nodes should be completed
      const dbNodes = allNodes(db, runId);
      expect(dbNodes).toHaveLength(8);
      expect(dbNodes.every((n: any) => n.status === "completed")).toBe(true);
    });
  });

  // ── 20. Artifact creation ──

  describe("20. Artifact creation flow", () => {
    it("should create and track artifacts via MCP tools", async () => {
      const { db, runId } = await setupRun("Artifact test");
      const { spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "gen", title: "Generate code", kind: "code_gen", role: "developer", prompt: "Generate code" },
      ]);

      await onPlanningComplete(db, runId, "Artifact plan", spawnFn);

      const nodeId = nodes.get("gen")!;

      // Create multiple artifacts
      const art1 = await handleToolCall(
        { db, runId, nodeId },
        "create_artifact",
        { content: "export function hello() { return 'world'; }", type: "file" },
      );
      expect(art1.artifact_id).toBeTruthy();

      const art2 = await handleToolCall(
        { db, runId, nodeId },
        "create_artifact",
        { content: "diff --git a/src/index.ts\n+export function hello() {}", type: "diff" },
      );
      expect(art2.artifact_id).toBeTruthy();

      // Verify events
      const events = db.query(
        "SELECT type, payload_json FROM events WHERE run_id = ? AND type = 'artifact_created'"
      ).all(runId) as any[];
      expect(events).toHaveLength(2);

      const payloads = events.map((e: any) => JSON.parse(e.payload_json));
      expect(payloads[0].type).toBe("file");
      expect(payloads[1].type).toBe("diff");
    });
  });

  // ── 21. MCP tool definitions ──

  describe("21. MCP tool definitions", () => {
    it("should expose all 12 tools with valid schemas", () => {
      const tools = getToolDefinitions();
      expect(tools).toHaveLength(12);

      const names = tools.map((t) => t.name);
      expect(names).toContain("create_node");
      expect(names).toContain("add_edge");
      expect(names).toContain("remove_edge");
      expect(names).toContain("validate_graph");
      expect(names).toContain("finish_planning");
      expect(names).toContain("update_status");
      expect(names).toContain("write_scratchpad");
      expect(names).toContain("read_scratchpads");
      expect(names).toContain("create_artifact");
      expect(names).toContain("get_graph");
      expect(names).toContain("get_run_status");
      expect(names).toContain("get_run_source");

      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  // ── 22. Unknown tool handling ──

  describe("22. Error handling", () => {
    it("should return error for unknown tool", async () => {
      const { db, runId } = await setupRun("Unknown tool test");
      const result = await handleToolCall({ db, runId }, "nonexistent_tool", {});
      expect(result.error).toContain("Unknown tool");
    });

    it("should return error for update_status on non-existent node", async () => {
      const { db, runId } = await setupRun("Bad update test");
      const result = await handleToolCall({ db, runId }, "update_status", {
        node_id: "nonexistent",
        status: "completed",
      });
      expect(result.error).toContain("not found");
    });

    it("should return error for add_edge with non-existent source", async () => {
      const { db, runId } = await setupRun("Bad edge test");
      const ctx: McpToolContext = { db, runId };

      const n1 = await handleToolCall(ctx, "create_node", {
        title: "A", kind: "code_gen", role: "developer", prompt: "A",
      });

      const result = await handleToolCall(ctx, "add_edge", {
        source_id: "nonexistent",
        target_id: n1.node_id,
      });
      expect(result.error).toContain("not found");
    });

    it("should return error for write_scratchpad without node context", async () => {
      const { db, runId } = await setupRun("No node test");
      const result = await handleToolCall(
        { db, runId }, // no nodeId
        "write_scratchpad",
        { content: "Orphan entry" },
      );
      expect(result.error).toContain("No node_id");
    });
  });

  // ── 23. Multiple retries across different nodes ──

  describe("23. Multiple nodes with mixed retry outcomes", () => {
    it("should independently retry each node and track history", async () => {
      const { db, runId } = await setupRun("Multi-retry test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "Stable", kind: "code_gen", role: "developer", prompt: "Works first try" },
        { key: "B", title: "Flaky", kind: "code_gen", role: "developer", prompt: "Needs retry" },
        { key: "C", title: "Doomed", kind: "code_gen", role: "developer", prompt: "Always fails" },
      ]);

      spawned.length = 0;
      await onPlanningComplete(db, runId, "Retry mix plan", spawnFn);
      expect(spawned).toHaveLength(3); // All independent

      // A succeeds immediately
      await completeNode(db, runId, nodes.get("A")!, spawnFn);

      // B fails once, then succeeds
      await failNode(db, runId, nodes.get("B")!, spawnFn, "Transient");
      await completeNode(db, runId, nodes.get("B")!, spawnFn);

      // C fails until max retries
      db.run("UPDATE nodes_current SET retry_count = 2 WHERE node_id = ?", [nodes.get("C")!]);
      await failNode(db, runId, nodes.get("C")!, spawnFn, "Permanent");

      expect(nodeStatus(db, nodes.get("A")!)).toBe("completed");
      expect(nodeStatus(db, nodes.get("B")!)).toBe("completed");
      expect(nodeStatus(db, nodes.get("C")!)).toBe("failed");

      // Run should be "completed" (not failed) since some nodes succeeded
      const state = getOrchestration(runId)!;
      expect(state.phase).toBe("completed");
    });
  });

  // ── 24. Scratchpad priority levels ──

  describe("24. Scratchpad priority levels", () => {
    it("should record priority in events", async () => {
      const { db, runId } = await setupRun("Priority test");
      const ctx: McpToolContext = { db, runId };

      const node = await handleToolCall(ctx, "create_node", {
        title: "Task", kind: "code_gen", role: "developer", prompt: "Task",
      });

      await handleToolCall(
        { db, runId, nodeId: node.node_id },
        "write_scratchpad",
        { content: "FYI: minor observation", priority: "fyi" },
      );

      await handleToolCall(
        { db, runId, nodeId: node.node_id },
        "write_scratchpad",
        { content: "BLOCKING: need API key", priority: "blocking" },
      );

      await handleToolCall(
        { db, runId, nodeId: node.node_id },
        "write_scratchpad",
        { content: "SCOPE: requirements changed", priority: "scope_change" },
      );

      const events = db.query(
        "SELECT payload_json FROM events WHERE run_id = ? AND type = 'scratchpad_written'"
      ).all(runId) as any[];

      const priorities = events.map((e: any) => JSON.parse(e.payload_json).priority);
      expect(priorities).toContain("fyi");
      expect(priorities).toContain("blocking");
      expect(priorities).toContain("scope_change");
    });
  });

  // ── 25. Concurrent runs isolation ──

  describe("25. Concurrent runs isolation", () => {
    it("should keep two runs completely isolated", async () => {
      const run1 = await setupRun("Run 1 goal");
      const run2 = await setupRun("Run 2 goal");

      const tracker1 = createAgentTracker();
      const tracker2 = createAgentTracker();

      await registerRun(run1.db, run1.runId, tracker1.spawnFn);
      await registerRun(run2.db, run2.runId, tracker2.spawnFn);

      // Build different graphs
      const nodes1 = await buildGraph(run1.db, run1.runId, [
        { key: "X", title: "Run1 Task", kind: "code_gen", role: "developer", prompt: "Run 1" },
      ]);
      const nodes2 = await buildGraph(run2.db, run2.runId, [
        { key: "Y", title: "Run2 Task A", kind: "research", role: "architect", prompt: "Run 2A" },
        { key: "Z", title: "Run2 Task B", kind: "code_gen", role: "developer", prompt: "Run 2B", depends_on_keys: ["Y"] },
      ]);

      // Execute run 1
      tracker1.spawned.length = 0;
      await onPlanningComplete(run1.db, run1.runId, "Run 1", tracker1.spawnFn);
      await completeNode(run1.db, run1.runId, nodes1.get("X")!, tracker1.spawnFn);

      // Execute run 2
      tracker2.spawned.length = 0;
      await onPlanningComplete(run2.db, run2.runId, "Run 2", tracker2.spawnFn);
      await completeNode(run2.db, run2.runId, nodes2.get("Y")!, tracker2.spawnFn);
      await completeNode(run2.db, run2.runId, nodes2.get("Z")!, tracker2.spawnFn);

      // Both should complete independently
      expect(getOrchestration(run1.runId)!.phase).toBe("completed");
      expect(getOrchestration(run2.runId)!.phase).toBe("completed");

      // Verify data isolation
      expect(allNodes(run1.db, run1.runId)).toHaveLength(1);
      expect(allNodes(run2.db, run2.runId)).toHaveLength(2);
    });
  });

  // ── 26. Graph get_graph shows full state ──

  describe("26. get_graph shows full state at any point", () => {
    it("should reflect status changes in graph query", async () => {
      const { db, runId } = await setupRun("Graph query test");
      const { spawnFn } = createAgentTracker();
      const ctx: McpToolContext = { db, runId };

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "A", kind: "code_gen", role: "developer", prompt: "A" },
        { key: "B", title: "B", kind: "code_gen", role: "developer", prompt: "B", depends_on_keys: ["A"] },
      ]);

      await onPlanningComplete(db, runId, "Graph query plan", spawnFn);

      // Mid-execution graph
      let graph = await handleToolCall(ctx, "get_graph", {});
      const nodeA = graph.nodes.find((n: any) => n.node_id === nodes.get("A"));
      expect(nodeA.status).toBe("active");

      await completeNode(db, runId, nodes.get("A")!, spawnFn);

      graph = await handleToolCall(ctx, "get_graph", {});
      const updatedA = graph.nodes.find((n: any) => n.node_id === nodes.get("A"));
      const updatedB = graph.nodes.find((n: any) => n.node_id === nodes.get("B"));
      expect(updatedA.status).toBe("completed");
      expect(updatedB.status).toBe("active");
    });
  });

  // ── 27. Planner-to-executor handoff via finish_planning callback ──

  describe("27. finish_planning triggers execution cascade", () => {
    it("should wire the full planner → executor handoff", async () => {
      const { db, runId } = await setupRun("Handoff test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      // Simulate planner building graph and calling finish_planning
      const ctx: McpToolContext = {
        db,
        runId,
        onPlanningComplete: (rId, summary) => {
          onPlanningComplete(db, rId, summary, spawnFn);
        },
      };

      await handleToolCall(ctx, "create_node", {
        title: "Auto-task", kind: "code_gen", role: "developer", prompt: "Automated",
      });

      spawned.length = 0;

      // This should trigger onPlanningComplete → spawn task agent
      await handleToolCall(ctx, "finish_planning", {
        summary: "Auto-planned: 1 task",
      });

      // The task agent should be spawned automatically via the callback chain
      expect(spawned.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 28. update_status callback triggers cascade ──

  describe("28. update_status callback triggers cascade", () => {
    it("should wire the full agent self-report → cascade flow", async () => {
      const { db, runId } = await setupRun("Self-report test");
      const { spawned, spawnFn } = createAgentTracker();

      await registerRun(db, runId, spawnFn);

      const nodes = await buildGraph(db, runId, [
        { key: "A", title: "A", kind: "code_gen", role: "developer", prompt: "A" },
        { key: "B", title: "B", kind: "code_gen", role: "developer", prompt: "B", depends_on_keys: ["A"] },
      ]);

      await onPlanningComplete(db, runId, "Self-report plan", spawnFn);
      wireAgents(getOrchestration(runId)!, [nodes.get("A")!]);

      // Simulate agent calling update_status MCP tool with callback wired
      const agentCtx: McpToolContext = {
        db,
        runId,
        nodeId: nodes.get("A")!,
        onNodeCompleted: (rId, nId) => {
          onNodeStatusUpdate(db, rId, nId, "completed", spawnFn);
        },
      };

      spawned.length = 0;

      // Agent self-reports completion via MCP tool
      const result = await handleToolCall(agentCtx, "update_status", {
        node_id: nodes.get("A")!,
        status: "completed",
      });
      expect(result.ok).toBe(true);

      // This should have triggered cascade: B should now be spawned
      expect(spawned.some((s) => s.nodeId === nodes.get("B"))).toBe(true);
    });
  });
});
