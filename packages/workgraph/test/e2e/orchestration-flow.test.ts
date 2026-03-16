/**
 * End-to-end orchestration flow tests.
 *
 * Each test exercises a complete orchestration scenario from planning-complete
 * through to a terminal run phase (completed / failed). Uses the same FakeDb
 * and makeSpawn helpers as the integration suite; no real SQLite or agents.
 *
 * Boundaries mocked:
 *   db           → FakeDb
 *   spawnAgentFn → makeSpawn
 *   ../db/helpers→ mocked module (absent on this branch)
 */

import { describe, it, expect, mock } from "bun:test";
import { FakeDb, makeSpawn, nextRunId } from "../helpers/fake-db";

const { startExecution, onNodeStatusUpdate, getOrchestration } = await import(
  "../../src/orchestrator/executor"
);

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("E2E: single node run", () => {
  it("planning complete with one node → node executes → run completes", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending");
    const spawn = makeSpawn();
    await startExecution(db, runId, "do something", spawn);
    // startExecution finds 'a' ready and spawns it
    expect(spawn.callCount).toBe(1);
    expect(db.nodeStatus("a")).toBe("active");
    // Task agent completes
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });
});

describe("E2E: linear chain A → B", () => {
  it("A completes → B becomes ready → B completes → run completes", async () => {
    const runId = nextRunId();
    const db = new FakeDb()
      .addNode("a", "pending")
      .addNode("b", "pending")
      .addEdge("a", "b");
    const spawn = makeSpawn();
    await startExecution(db, runId, "chain", spawn);
    // Only 'a' is initially ready
    expect(spawn.callCount).toBe(1);
    expect(spawn.calls[0].nodeId).toBe("a");
    // A completes — should spawn B
    await onNodeStatusUpdate(db, runId, "a", "completed", spawn);
    expect(spawn.callCount).toBe(2);
    expect(spawn.calls[1].nodeId).toBe("b");
    // B completes — run finishes
    await onNodeStatusUpdate(db, runId, "b", "completed", spawn);
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });
});

describe("E2E: parallel nodes A and B (no dependencies)", () => {
  it("both nodes spawned immediately, run completes after both finish", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending").addNode("b", "pending");
    const spawn = makeSpawn();
    await startExecution(db, runId, "parallel", spawn);
    // Both ready at the start
    expect(spawn.callCount).toBe(2);
    expect(db.nodeStatus("a")).toBe("active");
    expect(db.nodeStatus("b")).toBe("active");
    // A completes — B still active, run not done yet
    await onNodeStatusUpdate(db, runId, "a", "completed", spawn);
    expect(getOrchestration(runId)?.phase).toBe("executing");
    // B completes — run done
    await onNodeStatusUpdate(db, runId, "b", "completed", spawn);
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });
});

describe("E2E: diamond topology A → {B, C} → D", () => {
  it("D only spawns after both B and C complete", async () => {
    const runId = nextRunId();
    const db = new FakeDb()
      .addNode("a", "pending")
      .addNode("b", "pending")
      .addNode("c", "pending")
      .addNode("d", "pending")
      .addEdge("a", "b")
      .addEdge("a", "c")
      .addEdge("b", "d")
      .addEdge("c", "d");
    const spawn = makeSpawn();
    await startExecution(db, runId, "diamond", spawn);
    expect(spawn.callCount).toBe(1); // only A is ready
    await onNodeStatusUpdate(db, runId, "a", "completed", spawn);
    expect(spawn.callCount).toBe(3); // A done → B and C spawned
    // B completes — D still blocked on C
    await onNodeStatusUpdate(db, runId, "b", "completed", spawn);
    expect(spawn.callCount).toBe(3); // D not yet ready
    expect(getOrchestration(runId)?.phase).toBe("executing");
    // C completes — D now ready
    await onNodeStatusUpdate(db, runId, "c", "completed", spawn);
    expect(spawn.callCount).toBe(4); // D spawned
    expect(spawn.calls[3].nodeId).toBe("d");
    // D completes
    await onNodeStatusUpdate(db, runId, "d", "completed", spawn);
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("E2E: node fails then succeeds on retry", () => {
  it("first failure triggers a retry spawn; success on retry completes the run", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending");
    const spawn = makeSpawn();
    await startExecution(db, runId, "retry-run", spawn);
    db.nodes.get("a")!.status = "active"; // reset to active after startExecution
    db.nodes.get("a")!.retry_count = 0;
    // First failure — should retry
    await onNodeStatusUpdate(db, runId, "a", "failed", spawn);
    expect(db.retryCount("a")).toBe(1);
    expect(spawn.callCount).toBeGreaterThan(1); // retry spawn
    // Simulate the retry completing
    db.nodes.get("a")!.status = "active";
    await onNodeStatusUpdate(db, runId, "a", "completed", spawn);
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });
});

describe("E2E: node exhausts all retries", () => {
  it("run transitions to failed after all retry attempts fail", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending");
    const spawn = makeSpawn();
    await startExecution(db, runId, "exhaust-retries", spawn);
    db.nodes.get("a")!.status = "active";
    db.nodes.get("a")!.retry_count = 0;
    // Fail and retry until exhausted (MAX_RETRIES = 2)
    await onNodeStatusUpdate(db, runId, "a", "failed", spawn); // retry_count → 1
    db.nodes.get("a")!.status = "active";
    await onNodeStatusUpdate(db, runId, "a", "failed", spawn); // retry_count → 2
    db.nodes.get("a")!.status = "active";
    await onNodeStatusUpdate(db, runId, "a", "failed", spawn); // exhausted
    expect(db.nodeStatus("a")).toBe("failed");
    expect(getOrchestration(runId)?.phase).toBe("failed");
  });
});

describe("E2E: failure cascades to dependent nodes", () => {
  it("when A fails, B (dependent on A) is also failed and run terminates", async () => {
    const runId = nextRunId();
    const db = new FakeDb()
      .addNode("a", "pending")
      .addNode("b", "pending")
      .addEdge("a", "b");
    const spawn = makeSpawn();
    await startExecution(db, runId, "cascade-fail", spawn);
    db.nodes.get("a")!.status = "active";
    db.nodes.get("a")!.retry_count = 2; // force exhaustion on first failure
    await onNodeStatusUpdate(db, runId, "a", "failed", spawn);
    // B should be cascade-failed
    expect(db.nodeStatus("b")).toBe("failed");
    expect(getOrchestration(runId)?.phase).toBe("failed");
  });
});

describe("E2E: lifecycle hooks fire at correct milestones", () => {
  it("onNodeCompleted and onRunCompleted fire in order on happy path", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("a", "pending");
    const events: string[] = [];
    const hooks = {
      onNodeCompleted: mock(async () => { events.push("nodeCompleted"); }),
      onRunCompleted: mock(async () => { events.push("runCompleted"); }),
    };
    await startExecution(db, runId, "hooks-test", makeSpawn(), { hooks });
    db.nodes.get("a")!.status = "active";
    await onNodeStatusUpdate(db, runId, "a", "completed", makeSpawn());
    expect(events).toEqual(["nodeCompleted", "runCompleted"]);
  });
});
