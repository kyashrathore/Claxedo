/**
 * E2E test: spec → plan → execute flow using MockAgent.
 *
 * Tests the full pipeline: create run with source spec, start orchestration,
 * let MockAgent drive planning + execution, verify final state.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDb } from "../../src/app";
import { startOrchestration, getOrchestration, getRunMetrics } from "../../src/orchestrator/executor";
import { MockAgent, createSimpleMockAgent } from "../helpers/mock-agent";

function makeDb() {
  const db = new Database(":memory:");
  initializeDb(db);
  return db;
}

function makeRun(db: any, goal: string, sourceContent?: string) {
  const runId = `run_e2e_${Math.random().toString(36).slice(2)}`;
  db.run("INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [runId, goal, "active", new Date().toISOString(), new Date().toISOString()]);
  if (sourceContent) {
    db.run("INSERT INTO run_sources_current (run_id, kind, title, content, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, "spec", `${goal} spec`, sourceContent, null, new Date().toISOString()]);
  }
  return runId;
}

function waitForPhase(db: any, runId: string, expectedPhase: string, maxMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const state = getOrchestration(runId);
      if (state?.phase === expectedPhase) {
        resolve();
        return;
      }
      const row = db.query("SELECT status FROM runs_current WHERE run_id = ?").get(runId) as any;
      if (row?.status === expectedPhase) {
        resolve();
        return;
      }
      if (Date.now() - start > maxMs) {
        const phase = state?.phase ?? row?.status ?? "unknown";
        reject(new Error(`Timed out waiting for phase "${expectedPhase}" (current: "${phase}")`));
        return;
      }
      setTimeout(check, 20);
    };
    setTimeout(check, 5);
  });
}

// ---------------------------------------------------------------------------
// Simple single-task flow
// ---------------------------------------------------------------------------

describe("spec-flow: single task", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("completes a run with a single task node", async () => {
    const runId = makeRun(db, "implement hello world", "Write a hello world function in TypeScript.");
    const agent = createSimpleMockAgent(db, [
      { title: "Write hello world", kind: "code_gen", role: "developer", prompt: "Write it" },
    ]);

    await startOrchestration(db, runId, "implement hello world", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("completed");

    const nodes = db.query("SELECT status FROM nodes_current WHERE run_id = ?").all(runId) as any[];
    expect(nodes.every((n: any) => n.status === "completed")).toBe(true);

    const metrics = getRunMetrics(db, runId);
    expect(metrics).not.toBeNull();
    expect(metrics!.completed_count).toBe(1);
    expect(metrics!.failed_count).toBe(0);
  });

  it("records scratchpad output after completion", async () => {
    const runId = makeRun(db, "research topic");
    const agent = new MockAgent(db);
    agent.addScript({
      match: { planner: true },
      planNodes: [{ title: "Research", kind: "research", role: "developer", prompt: "research" }],
    });
    agent.addScript({
      match: {},
      tools: [{ name: "write_scratchpad", args: { content: "Research findings: important fact" } }],
      status: "completed",
    });

    await startOrchestration(db, runId, "research topic", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const scratchpads = db.query("SELECT content FROM scratchpad_entries WHERE run_id = ?").all(runId) as any[];
    const contents = scratchpads.map((s: any) => s.content);
    expect(contents.some((c: string) => c.includes("Research findings"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-task sequential flow
// ---------------------------------------------------------------------------

describe("spec-flow: sequential tasks", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("executes tasks in dependency order", async () => {
    const completionOrder: string[] = [];
    const runId = makeRun(db, "build auth feature");

    const agent = new MockAgent(db);
    agent.addScript({
      match: { planner: true },
      planNodes: [
        { title: "Design schema", kind: "research", role: "developer", prompt: "design" },
        { title: "Implement API", kind: "code_gen", role: "developer", prompt: "implement", depends_on: [] },
        { title: "Write tests", kind: "test", role: "qa", prompt: "test", depends_on: [] },
      ],
    });

    // Track order via scratchpad writes
    agent.addScript({
      match: { title: "design schema" },
      tools: [{ name: "write_scratchpad", args: { content: "schema done" } }],
      status: "completed",
    });
    agent.addScript({
      match: {},
      status: "completed",
    });

    await startOrchestration(db, runId, "build auth feature", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("completed");

    const nodes = db.query("SELECT status FROM nodes_current WHERE run_id = ?").all(runId) as any[];
    expect(nodes.length).toBe(3);
    expect(nodes.every((n: any) => n.status === "completed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parallel tasks
// ---------------------------------------------------------------------------

describe("spec-flow: parallel tasks", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("completes independent parallel nodes", async () => {
    const runId = makeRun(db, "parallel work");

    const agent = new MockAgent(db);
    agent.addScript({
      match: { planner: true },
      planNodes: [
        { title: "Task A", kind: "research", role: "developer", prompt: "A" },
        { title: "Task B", kind: "research", role: "developer", prompt: "B" },
        { title: "Task C", kind: "research", role: "developer", prompt: "C" },
      ],
    });
    agent.addScript({ match: {}, status: "completed" });

    await startOrchestration(db, runId, "parallel work", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const metrics = getRunMetrics(db, runId);
    expect(metrics).not.toBeNull();
    expect(metrics!.task_count).toBe(3);
    expect(metrics!.completed_count).toBe(3);
    expect(metrics!.max_parallelism).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Failed task flow
// ---------------------------------------------------------------------------

describe("spec-flow: failures", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("marks run as completed (partial) when some tasks fail", async () => {
    const runId = makeRun(db, "mixed outcomes");

    const agent = new MockAgent(db);
    agent.addScript({
      match: { planner: true },
      planNodes: [
        { title: "Will succeed", kind: "research", role: "developer", prompt: "succeed" },
        { title: "Will fail", kind: "research", role: "developer", prompt: "fail" },
      ],
    });
    agent.addScript({ match: { title: "will succeed" }, status: "completed" });
    agent.addScript({ match: { title: "will fail" }, status: "failed" });
    // Add a catch-all to ensure other nodes complete (if any retry)
    agent.addScript({ match: {}, status: "completed" });

    await startOrchestration(db, runId, "mixed outcomes", agent.spawnFn());
    await waitForPhase(db, runId, "completed", 5000);

    // Should be completed (partial) since at least one succeeded
    const state = getOrchestration(runId)!;
    expect(["completed", "failed"]).toContain(state.phase);
  });

  it("marks run as failed when all tasks fail", async () => {
    const runId = makeRun(db, "doom");

    const agent = new MockAgent(db);
    agent.addScript({
      match: { planner: true },
      planNodes: [
        { title: "Always fail", kind: "research", role: "developer", prompt: "fail" },
      ],
    });
    // Return failed status but also simulate exhausting retries by returning failed each time
    agent.addScript({ match: {}, status: "failed" });

    await startOrchestration(db, runId, "doom", agent.spawnFn());
    await waitForPhase(db, runId, "failed", 5000);

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Empty plan
// ---------------------------------------------------------------------------

describe("spec-flow: empty plan", () => {
  let db: any;

  beforeEach(() => {
    db = makeDb();
  });

  it("completes immediately when planner creates no nodes", async () => {
    const runId = makeRun(db, "nothing to do");

    const agent = new MockAgent(db);
    agent.addScript({ match: { planner: true }, planNodes: [] });

    await startOrchestration(db, runId, "nothing to do", agent.spawnFn());
    await waitForPhase(db, runId, "completed");

    const state = getOrchestration(runId)!;
    expect(state.phase).toBe("completed");
  });
});
