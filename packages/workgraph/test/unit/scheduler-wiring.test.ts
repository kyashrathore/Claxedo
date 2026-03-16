import { describe, it, expect } from "bun:test";
import { FakeDb, makeSpawn, nextRunId } from "../helpers/fake-db";

const {
  startExecution,
  onNodeStatusUpdate,
  reconcileExecution,
  getOrchestration,
} = await import("../../src/orchestrator/executor");

describe("Scheduler Wiring", () => {
  it("respects maxActivePerRun: only dispatches up to the policy cap", async () => {
    const runId = nextRunId();
    const db = new FakeDb()
      .addNode("n1", "pending")
      .addNode("n2", "pending")
      .addNode("n3", "pending")
      .addNode("n4", "pending")
      .addNode("n5", "pending");
    const spawn = makeSpawn();
    await startExecution(db, runId, "goal", spawn, {
      teamPolicy: { maxActivePerRun: 2, maxActivePerTeam: 12 },
    });
    expect(spawn.callCount).toBe(2);
  });

  it("respects maxActivePerTeam: caps per-team dispatches", async () => {
    const runId = nextRunId();
    const db = new FakeDb()
      .addNode("n1", "pending", { role: "team_alpha" })
      .addNode("n2", "pending", { role: "team_alpha" })
      .addNode("n3", "pending", { role: "team_alpha" })
      .addNode("n4", "pending", { role: "team_alpha" });
    const spawn = makeSpawn();
    await startExecution(db, runId, "goal", spawn, {
      teamPolicy: { maxActivePerRun: 12, maxActivePerTeam: 2 },
    });
    expect(spawn.callCount).toBe(2);
  });

  it("active node is not re-dispatched when execution is reconciled", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("n1", "pending");
    const spawn1 = makeSpawn();
    await startExecution(db, runId, "goal", spawn1);
    expect(spawn1.callCount).toBe(1);

    // n1 is now active — reconcile must not spawn it again
    const spawn2 = makeSpawn();
    await reconcileExecution(db, runId, spawn2);
    expect(spawn2.callCount).toBe(0);
  });

  it("completed node is not re-spawned on subsequent reconcile", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("n1", "pending");
    await startExecution(db, runId, "goal", makeSpawn());
    db.nodes.get("n1")!.status = "active";
    await onNodeStatusUpdate(db, runId, "n1", "completed", makeSpawn());

    // Run completed — reconcile is a no-op, n1 not re-spawned
    const spawn = makeSpawn();
    await reconcileExecution(db, runId, spawn);
    expect(spawn.callCount).toBe(0);
  });

  it("permanently failed node is not re-spawned", async () => {
    const runId = nextRunId();
    const db = new FakeDb().addNode("n1", "pending", { retry_count: 2 });
    await startExecution(db, runId, "goal", makeSpawn());
    db.nodes.get("n1")!.status = "active";
    db.nodes.get("n1")!.retry_count = 2;
    await onNodeStatusUpdate(db, runId, "n1", "failed", makeSpawn());

    // Run is failed — reconcile is a no-op
    expect(getOrchestration(runId)?.phase).toBe("failed");
    const spawn = makeSpawn();
    await reconcileExecution(db, runId, spawn);
    expect(spawn.callCount).toBe(0);
  });

  it("dispatches downstream node after upstream completes", async () => {
    const runId = nextRunId();
    const db = new FakeDb()
      .addNode("a", "pending")
      .addNode("b", "pending")
      .addEdge("a", "b");
    const spawn = makeSpawn();
    await startExecution(db, runId, "goal", spawn, {
      teamPolicy: { maxActivePerRun: 12, maxActivePerTeam: 4 },
    });
    expect(spawn.callCount).toBe(1);
    expect(spawn.calls[0].nodeId).toBe("a");
    const spawn2 = makeSpawn();
    await onNodeStatusUpdate(db, runId, "a", "completed", spawn2);
    expect(spawn2.callCount).toBe(1);
    expect(spawn2.calls[0].nodeId).toBe("b");
  });
});
