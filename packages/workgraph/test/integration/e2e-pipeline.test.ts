import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { EventEnvelope } from "@opencode-ai/orchestrator-events";
import { appendEvent, getEvents, replayEvents } from "../../src/services/event-store";
import { rootReducer, initialRootState, type RootState } from "../../src/reducers/index";
import { PlanningService } from "../../src/services/planning";
import { resolveRoute, type CapabilityDescription } from "../../src/routing";
import { CollaborationService } from "../../src/services/collaboration";
import { LeadLoop } from "../../src/services/lead-loop";
import { Watchdog } from "../../src/services/watchdog";
import { ScratchpadService } from "../../src/services/scratchpad";
import { getReadyNodes, LeaseManager, type TeamPolicy } from "../../src/scheduler";
import { GraphEngine, type Node, type Edge, GateTracker } from "@opencode-ai/orchestrator-graph";
import { computeHash } from "../../src/services/hash-chain";

describe("E2E Pipeline Integration", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database;
  let counter: number;
  let prevHash: string;

  beforeEach(() => {
    counter = 1;
    prevHash = "00000000";
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

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
  });

  async function emitEvent(
    type: string,
    payload: Record<string, any>,
    runId: string = "run_1"
  ): Promise<EventEnvelope> {
    const seq = counter++;
    const evt: EventEnvelope = {
      id: `evt_${seq}`,
      run_id: runId,
      stream_id: runId,
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      type,
      payload_json: JSON.stringify(payload),
      actor_type: "system",
      actor_id: "orchestrator",
      op_id: `op_${seq}`,
      prev_hash: prevHash,
      hash: "",
      created_at: new Date().toISOString(),
    };
    evt.hash = await computeHash(evt, prevHash);
    prevHash = evt.hash;

    await appendEvent(db, evt);
    return evt;
  }

  it("full E2E: decompose -> route -> dispatch -> execute -> lead reroute -> synthesize", async () => {
    const runId = "run_1";

    // ========================================
    // PHASE 1: Planning - Decompose the goal
    // ========================================
    const planningService = new PlanningService(7);
    const goal = "Build a frontend UI with backend API and test coverage";
    const plan = planningService.plan(runId, goal);

    expect(plan.questions.length).toBeGreaterThanOrEqual(3);
    const scopes = plan.questions.map((q) => q.scope);
    expect(scopes).toContain("frontend");
    expect(scopes).toContain("backend");
    expect(scopes).toContain("testing");

    // Emit run_created event
    await emitEvent("run_created", { goal });

    // Emit run_planned event
    await emitEvent("run_planned", { plan_id: "plan_1" });

    // Emit question_scoped events
    for (const q of plan.questions) {
      await emitEvent("question_scoped", { question: q.question });
    }

    // ========================================
    // PHASE 2: Routing - Route questions to capabilities
    // ========================================
    const capabilities: CapabilityDescription[] = [
      { id: "frontend_team", description: "Frontend UI with React and SolidJS" },
      { id: "backend_team", description: "Backend API server and database" },
      { id: "qa_team", description: "QA testing and quality assurance" },
      { id: "general_team", description: "General coordination and planning" },
    ];

    const routes: Array<{ questionId: string; teamId: string; confidence: number }> = [];
    for (const q of plan.questions) {
      const result = await resolveRoute(q.question, capabilities);
      routes.push({
        questionId: q.id,
        teamId: result.selected_id || "general_team",
        confidence: result.confidence,
      });

      if (result.selected_id) {
        await emitEvent("route_scored", {
          route_id: `route_${q.id}`,
          team_id: result.selected_id,
          confidence: result.confidence,
        });
      }
    }

    // ========================================
    // PHASE 3: Create teams and dispatch
    // ========================================
    const teamIds = [...new Set(routes.map((r) => r.teamId))];
    for (const teamId of teamIds) {
      await emitEvent("team_created", { team_id: teamId, name: teamId });
      await emitEvent("team_member_added", { team_id: teamId, agent_id: `agent_${teamId}` });
    }

    // Dispatch plan
    const dispatched = planningService.dispatch(plan);
    expect(dispatched.every((d) => d.ready)).toBe(true);

    await emitEvent("dispatch_requested", { dispatch_id: "d_1" });

    // ========================================
    // PHASE 4: Build graph from plan and schedule
    // ========================================
    const graphNodes: Node[] = [];
    const graphEdges: Edge[] = [];
    const nodeTeamMap = new Map<string, string>();

    // Create nodes for each dispatched question
    for (let i = 0; i < dispatched.length; i++) {
      const nodeId = `node_q${i}`;
      const teamId = routes[i]?.teamId || "general_team";

      graphNodes.push({ id: nodeId, status: "pending", kind: "team_task" });
      nodeTeamMap.set(nodeId, teamId);

      await emitEvent("node_created", { node_id: nodeId, kind: "team_task", team_id: teamId });
    }

    // Add a synthesis node that depends on all question nodes
    const synthesisNodeId = "node_synthesis";
    graphNodes.push({ id: synthesisNodeId, status: "pending", kind: "synthesis_task" });
    nodeTeamMap.set(synthesisNodeId, "general_team");
    await emitEvent("node_created", { node_id: synthesisNodeId, kind: "synthesis_task", team_id: "general_team" });

    // Add edges: each question node -> synthesis node
    for (let i = 0; i < dispatched.length; i++) {
      const edgeId = `edge_q${i}_to_synth`;
      graphEdges.push({
        source_id: `node_q${i}`,
        target_id: synthesisNodeId,
        type: "hard",
      });
      await emitEvent("edge_added", {
        id: edgeId,
        source_id: `node_q${i}`,
        target_id: synthesisNodeId,
        type: "hard",
      });
    }

    const gateTracker = new GateTracker();
    const graph = new GraphEngine(graphNodes, graphEdges);
    graph.setGateTracker(gateTracker);

    const leaseManager = new LeaseManager();
    const teamPolicy: TeamPolicy = { maxActivePerRun: 5, maxActivePerTeam: 3 };

    // Get initial ready nodes
    let readyNodes = getReadyNodes(graphNodes, graph, { leaseManager, teamPolicy, nodeTeamMap });

    // All question nodes should be ready (no incoming deps)
    // synthesis node blocked by all questions
    const readyIds = readyNodes.map((n) => n.id);
    expect(readyIds).not.toContain(synthesisNodeId);
    expect(readyIds.length).toBeGreaterThan(0);

    // ========================================
    // PHASE 5: Simulate execution - mark nodes active, then completed
    // ========================================
    const collaboration = new CollaborationService();
    const watchdog = new Watchdog({ noProgressTimeoutMs: 100 }); // short timeout for testing

    // Execute first batch of ready nodes
    for (const node of readyNodes) {
      leaseManager.acquireLease(node.id, 60_000);
      graph.updateNodeStatus(node.id, "active");
      // Also update in graphNodes array for scheduler
      const n = graphNodes.find((gn) => gn.id === node.id);
      if (n) n.status = "active";

      await emitEvent("node_status_changed", { node_id: node.id, status: "active" });
      watchdog.recordActivity(node.id, "active");
    }

    // Post team messages
    collaboration.postMessage({
      id: "msg_start",
      runId,
      teamId: teamIds[0] || "frontend_team",
      senderId: "lead",
      type: "propose",
      content: "Starting execution of dispatched plan",
    });

    // ========================================
    // PHASE 6: Make one node stall, detect with LeadLoop
    // ========================================
    const leadLoop = new LeadLoop();
    const stalledNodeId = readyNodes[0]?.id;

    // Simulate passage of time by directly checking with a future timestamp
    if (stalledNodeId) {
      // Make node_q0 stall by setting its lastActivityAt in the past
      const stalledNodes = [
        { id: stalledNodeId, status: "active", lastActivityAt: Date.now() - 200_000 },
      ];

      const gaps = leadLoop.detectGaps(runId, stalledNodes, 120_000);
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0].nodeId).toBe(stalledNodeId);

      // Emit gap detection event
      await emitEvent("lead_plan_created", { plan_id: "lead_plan_1" });
      await emitEvent("lead_gap_detected", { plan_id: "lead_plan_1", gap: gaps[0].reason });

      // Post a blocker message
      collaboration.postMessage({
        id: "msg_blocker",
        runId,
        teamId: nodeTeamMap.get(stalledNodeId) || "unknown",
        senderId: "lead",
        type: "blocker",
        content: `Node ${stalledNodeId} stalled: ${gaps[0].reason}`,
      });

      // ========================================
      // PHASE 7: Request reroute
      // ========================================
      const reroute = leadLoop.requestReroute(
        runId,
        stalledNodeId,
        "qa_team",
        "Primary team stalled, rerouting"
      );

      await emitEvent("lead_reroute_requested", {
        plan_id: "lead_plan_1",
        reroute: reroute.reason,
      });

      // Create handoff
      collaboration.requestHandoff({
        id: "h_reroute",
        runId,
        fromTeamId: nodeTeamMap.get(stalledNodeId) || "unknown",
        toTeamId: "qa_team",
        payload: reroute.reason,
      });

      await emitEvent("handoff_requested", {
        id: "h_reroute",
        from_team_id: nodeTeamMap.get(stalledNodeId) || "unknown",
        to_team_id: "qa_team",
      });

      // Accept handoff
      collaboration.acceptHandoff("h_reroute");
      await emitEvent("handoff_accepted", { id: "h_reroute" });

      // Complete the rerouted node
      leaseManager.releaseLease(stalledNodeId);
      graph.updateNodeStatus(stalledNodeId, "completed");
      const n = graphNodes.find((gn) => gn.id === stalledNodeId);
      if (n) n.status = "completed";
      await emitEvent("node_status_changed", { node_id: stalledNodeId, status: "completed" });
    }

    // ========================================
    // PHASE 8: Complete remaining nodes
    // ========================================
    for (const node of graphNodes) {
      if (node.status !== "completed" && node.id !== synthesisNodeId) {
        leaseManager.releaseLease(node.id);
        graph.updateNodeStatus(node.id, "completed");
        node.status = "completed";
        await emitEvent("node_status_changed", { node_id: node.id, status: "completed" });
      }
    }

    // Now synthesis should be ready
    readyNodes = getReadyNodes(graphNodes, graph, { leaseManager, teamPolicy, nodeTeamMap });
    const synthesisReady = readyNodes.find((n) => n.id === synthesisNodeId);
    expect(synthesisReady).toBeDefined();

    // Complete synthesis
    graph.updateNodeStatus(synthesisNodeId, "completed");
    const synthNode = graphNodes.find((gn) => gn.id === synthesisNodeId);
    if (synthNode) synthNode.status = "completed";
    await emitEvent("node_status_changed", { node_id: synthesisNodeId, status: "completed" });

    // ========================================
    // PHASE 9: Create artifacts from completed nodes
    // ========================================
    const scratchpad = new ScratchpadService({ maxSizeBytes: 10 * 1024 * 1024 });

    // Write scratchpad entries for each completed question node
    for (let i = 0; i < dispatched.length; i++) {
      const nodeId = `node_q${i}`;
      scratchpad.write(runId, nodeId, `scratch_${nodeId}`, `Draft output for ${dispatched[i].scope}`);
    }

    // Promote first scratchpad to artifact
    const promoted = scratchpad.promote("scratch_node_q0");
    expect(promoted).not.toBeNull();

    await emitEvent("artifact_created", {
      id: promoted!.artifact.id,
      node_id: promoted!.artifact.nodeId,
      content: promoted!.artifact.content,
      version: 1,
    });

    // Create a decision about the approach
    await emitEvent("decision_proposed", {
      id: "decision_approach",
      proposal: "Use modular microservices architecture",
    });

    await emitEvent("decision_accepted", { id: "decision_approach" });

    // ========================================
    // PHASE 10: Verify final state through rootReducer replay
    // ========================================
    const finalState = await replayEvents(db, runId, rootReducer, { ...initialRootState });

    // Verify run
    expect(finalState.run.runs[runId]).toBeDefined();
    expect(finalState.run.runs[runId].goal).toBe(goal);
    expect(finalState.run.runs[runId].status).toBe("planned");

    // Verify teams were created
    for (const teamId of teamIds) {
      expect(finalState.team.teams[teamId]).toBeDefined();
      expect(finalState.team.teams[teamId].members).toContain(`agent_${teamId}`);
    }

    // Verify all question nodes exist
    for (let i = 0; i < dispatched.length; i++) {
      expect(finalState.node.nodes[`node_q${i}`]).toBeDefined();
      expect(finalState.node.nodes[`node_q${i}`].status).toBe("completed");
    }

    // Verify synthesis node
    expect(finalState.node.nodes[synthesisNodeId]).toBeDefined();
    expect(finalState.node.nodes[synthesisNodeId].status).toBe("completed");

    // Verify edges
    expect(finalState.edge.edges.length).toBe(dispatched.length);
    for (const edge of finalState.edge.edges) {
      expect(edge.target_id).toBe(synthesisNodeId);
    }

    // Verify planning state
    expect(finalState.planning.plans[runId]).toBeDefined();
    expect(finalState.planning.plans[runId].dispatched).toBe(true);
    expect(finalState.planning.plans[runId].questions.length).toBe(plan.questions.length);

    // Verify handoff
    expect(finalState.handoff.handoffs["h_reroute"]).toBeDefined();
    expect(finalState.handoff.handoffs["h_reroute"].status).toBe("accepted");

    // Verify artifact
    expect(finalState.artifact.artifacts[promoted!.artifact.id]).toBeDefined();

    // Verify decision
    expect(finalState.decision.decisions["decision_approach"]).toBeDefined();
    expect(finalState.decision.decisions["decision_approach"].status).toBe("accepted");

    // Verify lead plans
    expect(finalState.lead.leadPlans["lead_plan_1"]).toBeDefined();
    expect(finalState.lead.leadPlans["lead_plan_1"].gaps.length).toBeGreaterThan(0);
    expect(finalState.lead.leadPlans["lead_plan_1"].reroutes.length).toBeGreaterThan(0);

    // Verify collaboration state
    const allMessages = collaboration.getMessages(runId);
    expect(allMessages.length).toBeGreaterThanOrEqual(2);

    const blockerMsgs = collaboration.getMessagesByType(runId, "blocker");
    expect(blockerMsgs.length).toBeGreaterThan(0);

    const handoffs = collaboration.getHandoffs(runId);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].status).toBe("accepted");

    // Verify reroute tracking
    expect(leadLoop.getGaps(runId).length).toBeGreaterThan(0);
    expect(leadLoop.getReroutes(runId).length).toBeGreaterThan(0);
  });

  it("should produce deterministic final state on re-replay", async () => {
    const runId = "run_1";

    // Emit a small set of events
    await emitEvent("run_created", { goal: "Simple goal" });
    await emitEvent("team_created", { team_id: "t1", name: "Team 1" });
    await emitEvent("node_created", { node_id: "n1", kind: "lead_task", team_id: "t1" });
    await emitEvent("node_status_changed", { node_id: "n1", status: "active" });
    await emitEvent("node_status_changed", { node_id: "n1", status: "completed" });
    await emitEvent("artifact_created", { id: "a1", node_id: "n1", content: "output", version: 1 });

    const state1 = await replayEvents(db, runId, rootReducer, { ...initialRootState });
    const state2 = await replayEvents(db, runId, rootReducer, { ...initialRootState });

    expect(JSON.stringify(state1)).toBe(JSON.stringify(state2));
  });

  it("should handle watchdog escalation for stalled nodes", async () => {
    const watchdog = new Watchdog({ noProgressTimeoutMs: 100 });

    watchdog.recordActivity("n1", "active");
    watchdog.recordActivity("n2", "active");
    watchdog.recordActivity("n3", "completed");

    // Wait a bit to let timeout expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    const stalled = watchdog.checkStalled();

    // n1 and n2 should be stalled (active and timed out), n3 is completed so not stalled
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

    // Read
    const entries = scratchpad.read("run_1");
    expect(entries).toHaveLength(1);

    // Get by ID
    const fetched = scratchpad.get("sp_1");
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe("Draft content here");

    // Promote to artifact
    const promoted = scratchpad.promote("sp_1");
    expect(promoted).not.toBeNull();
    expect(promoted!.artifact.id).toBe("artifact_sp_1");
    expect(promoted!.artifact.content).toBe("Draft content here");

    // After promotion, entry is removed
    const afterPromotion = scratchpad.get("sp_1");
    expect(afterPromotion).toBeUndefined();
    expect(scratchpad.read("run_1")).toHaveLength(0);
  });

  it("should integrate graph cycle detection with pipeline safety", () => {
    // A valid DAG
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

    // Add a cycle
    graph.addEdge({ source_id: "c", target_id: "a", type: "hard" });
    expect(graph.hasCycles()).toBe(true);

    // Remove the cycle edge
    graph.removeEdge("c", "a");
    expect(graph.hasCycles()).toBe(false);
  });

  it("should handle hash-chained events through the full pipeline", async () => {
    const runId = "run_1";

    // All events emitted by emitEvent are hash-chained
    await emitEvent("run_created", { goal: "Hash chain test" });
    await emitEvent("team_created", { team_id: "t1", name: "T1" });
    await emitEvent("node_created", { node_id: "n1", kind: "lead_task", team_id: "t1" });

    const events = await getEvents(db, runId);
    expect(events).toHaveLength(3);

    // Verify chain manually
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prev_hash).toBe(events[i - 1].hash);
    }
    expect(events[0].prev_hash).toBe("00000000");

    // Each hash should be a valid 64-char hex
    for (const evt of events) {
      expect(evt.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
