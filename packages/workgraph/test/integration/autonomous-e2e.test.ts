import { vi, describe, it, expect } from "vitest";
import { FakeDb, makeSpawn, nextRunId } from "../helpers/fake-db";

const {
  startExecution,
  onNodeStatusUpdate,
  reconcileExecution,
  getOrchestration,
} = await import("../../src/orchestrator/executor");

describe("Autonomous E2E Pipeline", () => {
  it("diamond graph: all nodes complete through cascade", async () => {
    const runId = nextRunId();
    // Diamond: root → left, root → right, left → sink, right → sink
    const db = new FakeDb(runId)
      .addNode("root", "pending")
      .addNode("left", "pending")
      .addNode("right", "pending")
      .addNode("sink", "pending")
      .addEdge("root", "left")
      .addEdge("root", "right")
      .addEdge("left", "sink")
      .addEdge("right", "sink");

    const spawn1 = makeSpawn();
    await startExecution(db, runId, "goal", spawn1);
    expect(spawn1.callCount).toBe(1);
    expect(spawn1.calls[0].nodeId).toBe("root");

    // Complete root → left and right dispatched
    const spawn2 = makeSpawn();
    await onNodeStatusUpdate(db, runId, "root", "completed", spawn2);
    expect(spawn2.callCount).toBe(2);
    const dispatched2 = spawn2.calls.map((c) => c.nodeId).sort();
    expect(dispatched2).toEqual(["left", "right"]);

    // Complete left → sink still blocked on right
    const spawn3 = makeSpawn();
    await onNodeStatusUpdate(db, runId, "left", "completed", spawn3);
    expect(spawn3.callCount).toBe(0);

    // Complete right → sink now ready
    const spawn4 = makeSpawn();
    await onNodeStatusUpdate(db, runId, "right", "completed", spawn4);
    expect(spawn4.callCount).toBe(1);
    expect(spawn4.calls[0].nodeId).toBe("sink");

    // Complete sink → run completes
    await onNodeStatusUpdate(db, runId, "sink", "completed", makeSpawn());
    expect(getOrchestration(runId)?.phase).toBe("completed");
  });

  it("scheduler obeys team policy mid-run: caps same-team dispatch", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId)
      .addNode("n1", "pending", { role: "team_x" })
      .addNode("n2", "pending", { role: "team_x" })
      .addNode("n3", "pending", { role: "team_x" })
      .addNode("n4", "pending", { role: "team_y" });

    const spawn = makeSpawn();
    await startExecution(db, runId, "goal", spawn, {
      teamPolicy: { maxActivePerRun: 12, maxActivePerTeam: 1 },
    });

    // 1 from team_x + 1 from team_y = 2 total
    expect(spawn.callCount).toBe(2);
    const roles = spawn.calls.map((c) => db.getNodeRole(c.nodeId));
    expect(roles.filter((r) => r === "team_x").length).toBe(1);
    expect(roles.filter((r) => r === "team_y").length).toBe(1);
  });

  it("identical graph setup produces identical execution state", async () => {
    const runId1 = nextRunId();
    const runId2 = nextRunId();

    const db1 = new FakeDb(runId1).addNode("a", "pending").addNode("b", "pending").addEdge("a", "b");
    const db2 = new FakeDb(runId2).addNode("a", "pending").addNode("b", "pending").addEdge("a", "b");

    await startExecution(db1, runId1, "goal", makeSpawn());
    await startExecution(db2, runId2, "goal", makeSpawn());

    const s1 = getOrchestration(runId1)!;
    const s2 = getOrchestration(runId2)!;

    expect(s1.phase).toBe(s2.phase);
    expect(db1.nodeStatus("a")).toBe(db2.nodeStatus("a"));
    expect(db1.nodeStatus("b")).toBe(db2.nodeStatus("b"));
  });

  it("active node is not re-dispatched when execution is reconciled", async () => {
    const runId = nextRunId();
    const db = new FakeDb(runId).addNode("n1", "pending");
    const spawn = makeSpawn();
    await startExecution(db, runId, "goal", spawn);
    expect(spawn.callCount).toBe(1);

    // n1 is now active — reconcile must not spawn it again
    const spawn2 = makeSpawn();
    await reconcileExecution(db, runId, spawn2);
    expect(spawn2.callCount).toBe(0);
  });
});
