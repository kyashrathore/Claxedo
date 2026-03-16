import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteEventStore, type IEventStore } from "../../src/orchestrator/core/services/event-store-sqlite";
import { rootReducer, initialRootState } from "../../src/orchestrator/core/reducers/index";
import { PlanningService } from "../../src/orchestrator/core/services/planning";
import { LeadLoop } from "../../src/orchestrator/core/services/lead-loop";
import { Watchdog } from "../../src/orchestrator/core/services/watchdog";
import { ScratchpadService } from "../../src/orchestrator/core/services/scratchpad";
import { getReadyNodes, LeaseManager, type TeamPolicy } from "../../src/orchestrator/core/scheduler";
import { GraphEngine, type Node, type Edge } from "../../src/orchestrator/graph/graph";
import { GateTracker } from "../../src/orchestrator/graph/gates";

describe("E2E Pipeline Integration", () => {
  let sqlite: Database;
  let store: IEventStore;
  let counter: number;

  beforeEach(() => {
    counter = 1;
    sqlite = new Database(":memory:");
    sqlite.run(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_seq INTEGER NOT NULL,
        logical_ts INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        op_id TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    store = openSqliteEventStore(sqlite);
  });

  async function emitEvent(
    type: string,
    payload: Record<string, any>,
    runId: string = "run_1"
  ) {
    const seq = counter++;
    return store.append({
      id: `evt_${seq}`,
      run_id: runId,
      stream_id: runId,
      schema_version: 1,
      type,
      payload_json: JSON.stringify(payload),
      actor_type: "system",
      actor_id: "orchestrator",
      op_id: `op_${seq}`,
      created_at: new Date().toISOString(),
    });
  }

  it("full E2E: plan -> dispatch -> execute -> synthesize", async () => {
    const runId = "run_1";

    // PHASE 1: Planning
    const planningService = new PlanningService(7);
    const goal = "Build a frontend UI with backend API and test coverage";
    const plan = planningService.plan(runId, goal);

    expect(plan.questions.length).toBeGreaterThanOrEqual(3);
    const scopes = plan.questions.map((q) => q.scope);
    expect(scopes).toContain("frontend");
    expect(scopes).toContain("backend");
    expect(scopes).toContain("testing");

    await emitEvent("run_created", { goal });
    await emitEvent("run_planned", { plan_id: "plan_1" });
    for (const q of plan.questions) {
      await emitEvent("question_scoped", { question: q.question });
    }

    // PHASE 2: Build graph with manual team assignment
    const dispatched = planningService.dispatch(plan);
    expect(dispatched.every((d) => d.ready)).toBe(true);

    const graphNodes: Node[] = [];
    const graphEdges: Edge[] = [];
    const nodeTeamMap = new Map<string, string>();

    const teams = ["frontend_team", "backend_team", "qa_team", "general_team"];
    for (let i = 0; i < dispatched.length; i++) {
      const nodeId = `node_q${i}`;
      const teamId = teams[i % teams.length];
      graphNodes.push({ id: nodeId, status: "pending", kind: "team_task" });
      nodeTeamMap.set(nodeId, teamId);
      await emitEvent("node_created", { node_id: nodeId, kind: "team_task", team_id: teamId });
    }

    const synthesisNodeId = "node_synthesis";
    graphNodes.push({ id: synthesisNodeId, status: "pending", kind: "synthesis_task" });
    nodeTeamMap.set(synthesisNodeId, "general_team");
    await emitEvent("node_created", { node_id: synthesisNodeId, kind: "synthesis_task", team_id: "general_team" });

    for (let i = 0; i < dispatched.length; i++) {
      graphEdges.push({ source_id: `node_q${i}`, target_id: synthesisNodeId, type: "hard" });
      await emitEvent("edge_added", {
        id: `edge_q${i}_to_synth`,
        source_id: `node_q${i}`,
        target_id: synthesisNodeId,
        type: "hard",
      });
    }

    // PHASE 3: Schedule and execute
    const gateTracker = new GateTracker();
    const graph = new GraphEngine(graphNodes, graphEdges);
    graph.setGateTracker(gateTracker);

    const leaseManager = new LeaseManager();
    const teamPolicy: TeamPolicy = { maxActivePerRun: 5, maxActivePerTeam: 3 };

    let readyNodes = getReadyNodes(graphNodes, graph, { leaseManager, teamPolicy, nodeTeamMap });
    expect(readyNodes.map((n) => n.id)).not.toContain(synthesisNodeId);
    expect(readyNodes.length).toBeGreaterThan(0);

    for (const node of readyNodes) {
      leaseManager.acquireLease(node.id, 60_000);
      graph.updateNodeStatus(node.id, "active");
      const n = graphNodes.find((gn) => gn.id === node.id);
      if (n) n.status = "active";
      await emitEvent("node_status_changed", { node_id: node.id, status: "active" });
    }

    // PHASE 4: LeadLoop gap detection
    const leadLoop = new LeadLoop();
    const stalledNodeId = readyNodes[0]?.id;
    if (stalledNodeId) {
      const stalledNodes = [
        { id: stalledNodeId, status: "active", lastActivityAt: Date.now() - 200_000 },
      ];
      const gaps = leadLoop.detectGaps(runId, stalledNodes, 120_000);
      expect(gaps.length).toBeGreaterThan(0);

      const reroute = leadLoop.requestReroute(runId, stalledNodeId, "qa_team", "Primary team stalled");
      await emitEvent("lead_reroute_requested", { plan_id: "lead_plan_1", reroute: reroute.reason });

      leaseManager.releaseLease(stalledNodeId);
      graph.updateNodeStatus(stalledNodeId, "completed");
      const n = graphNodes.find((gn) => gn.id === stalledNodeId);
      if (n) n.status = "completed";
      await emitEvent("node_status_changed", { node_id: stalledNodeId, status: "completed" });
    }

    for (const node of graphNodes) {
      if (node.status !== "completed" && node.id !== synthesisNodeId) {
        leaseManager.releaseLease(node.id);
        graph.updateNodeStatus(node.id, "completed");
        node.status = "completed";
        await emitEvent("node_status_changed", { node_id: node.id, status: "completed" });
      }
    }

    readyNodes = getReadyNodes(graphNodes, graph, { leaseManager, teamPolicy, nodeTeamMap });
    expect(readyNodes.find((n) => n.id === synthesisNodeId)).toBeDefined();

    graph.updateNodeStatus(synthesisNodeId, "completed");
    const synthNode = graphNodes.find((gn) => gn.id === synthesisNodeId);
    if (synthNode) synthNode.status = "completed";
    await emitEvent("node_status_changed", { node_id: synthesisNodeId, status: "completed" });

    // PHASE 5: Scratchpad -> artifact
    const scratchpad = new ScratchpadService({ maxSizeBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < dispatched.length; i++) {
      scratchpad.write(runId, `node_q${i}`, `scratch_node_q${i}`, `Draft for ${dispatched[i].scope}`);
    }

    const promoted = scratchpad.promote("scratch_node_q0");
    expect(promoted).not.toBeNull();
    await emitEvent("artifact_created", {
      id: promoted!.artifact.id,
      node_id: promoted!.artifact.nodeId,
      content: promoted!.artifact.content,
      version: 1,
    });

    // PHASE 6: Verify via replay
    const finalState = await store.replayEvents(runId, rootReducer, { ...initialRootState });

    expect(finalState.run.runs[runId]).toBeDefined();
    expect(finalState.run.runs[runId].goal).toBe(goal);
    expect(finalState.run.runs[runId].status).toBe("planned");

    for (let i = 0; i < dispatched.length; i++) {
      expect(finalState.node.nodes[`node_q${i}`]).toBeDefined();
      expect(finalState.node.nodes[`node_q${i}`].status).toBe("completed");
    }

    expect(finalState.node.nodes[synthesisNodeId]).toBeDefined();
    expect(finalState.node.nodes[synthesisNodeId].status).toBe("completed");
    expect(finalState.edge.edges.length).toBe(dispatched.length);
    expect(finalState.artifact.artifacts[promoted!.artifact.id]).toBeDefined();
  });

  it("should produce deterministic final state on re-replay", async () => {
    const runId = "run_1";

    await emitEvent("run_created", { goal: "Simple goal" });
    await emitEvent("node_created", { node_id: "n1", kind: "lead_task", team_id: "t1" });
    await emitEvent("node_status_changed", { node_id: "n1", status: "active" });
    await emitEvent("node_status_changed", { node_id: "n1", status: "completed" });
    await emitEvent("artifact_created", { id: "a1", node_id: "n1", content: "output", version: 1 });

    const state1 = await store.replayEvents(runId, rootReducer, { ...initialRootState });
    const state2 = await store.replayEvents(runId, rootReducer, { ...initialRootState });

    expect(JSON.stringify(state1)).toBe(JSON.stringify(state2));
  });

  it("should handle watchdog escalation for stalled nodes", async () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 100 });

    watchdog.recordActivity("n1", "active");
    watchdog.recordActivity("n2", "active");
    watchdog.recordActivity("n3", "completed");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const stalled = watchdog.checkStalled();
    expect(stalled.length).toBe(2);
    const stalledIds = stalled.map((s) => s.nodeId);
    expect(stalledIds).toContain("n1");
    expect(stalledIds).toContain("n2");

    const escalations = watchdog.escalate(stalled);
    expect(escalations.length).toBe(2);
    for (const e of escalations) {
      expect(e.type).toBe("watchdog_escalated");
      expect(["retry", "kill"]).toContain(e.action);
    }
  });

  it("should handle scratchpad lifecycle: write -> read -> promote", () => {
    const scratchpad = new ScratchpadService();

    const entry = scratchpad.write("run_1", "node_1", "sp_1", "Draft content here");
    expect(entry.id).toBe("sp_1");
    expect(entry.content).toBe("Draft content here");
    expect(entry.sizeBytes).toBeGreaterThan(0);

    const entries = scratchpad.read("run_1");
    expect(entries).toHaveLength(1);

    const fetched = scratchpad.get("sp_1");
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe("Draft content here");

    const promoted = scratchpad.promote("sp_1");
    expect(promoted).not.toBeNull();
    expect(promoted!.artifact.id).toBe("artifact_sp_1");
    expect(promoted!.artifact.content).toBe("Draft content here");

    expect(scratchpad.get("sp_1")).toBeUndefined();
    expect(scratchpad.read("run_1")).toHaveLength(0);
  });

  it("should integrate graph cycle detection with pipeline safety", () => {
    const nodes: Node[] = [
      { id: "a", status: "pending" },
      { id: "b", status: "pending" },
      { id: "c", status: "pending" },
    ];
    const edges: Edge[] = [
      { source_id: "a", target_id: "b", type: "hard" },
      { source_id: "b", target_id: "c", type: "hard" },
    ];

    const graph = new GraphEngine(nodes, edges);
    expect(graph.hasCycles()).toBe(false);

    graph.addEdge({ source_id: "c", target_id: "a", type: "hard" });
    expect(graph.hasCycles()).toBe(true);

    graph.removeEdge("c", "a");
    expect(graph.hasCycles()).toBe(false);
  });

  it("should handle hash-chained events through the full pipeline", async () => {
    const runId = "run_1";

    await emitEvent("run_created", { goal: "Hash chain test" });
    await emitEvent("node_created", { node_id: "n1", kind: "lead_task", team_id: "t1" });
    await emitEvent("edge_added", { id: "e1", source_id: "n1", target_id: "n2", type: "hard" });

    const events = await store.getEvents(runId);
    expect(events).toHaveLength(3);

    for (let i = 1; i < events.length; i++) {
      expect(events[i].prev_hash).toBe(events[i - 1].hash);
    }
    expect(events[0].prev_hash).toBe("00000000");

    for (const evt of events) {
      expect(evt.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
