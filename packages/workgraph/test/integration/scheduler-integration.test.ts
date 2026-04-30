import { describe, it, expect, beforeEach } from "vitest";
import { getReadyNodes, LeaseManager, type TeamPolicy } from "../../src/orchestrator/core/scheduler";
import { GraphEngine, type Node, type Edge } from "../../src/orchestrator/graph/graph";
import { GateTracker } from "../../src/orchestrator/graph/gates";

describe("Scheduler Integration", () => {
  let gateTracker: GateTracker;
  let leaseManager: LeaseManager;

  beforeEach(() => {
    gateTracker = new GateTracker();
    leaseManager = new LeaseManager();
  });

  function buildComplexGraph(): { nodes: Node[]; edges: Edge[]; nodeTeamMap: Map<string, string> } {
    const nodes: Node[] = [
      { id: "lead_1", status: "pending", kind: "lead_task" },
      { id: "lead_2", status: "pending", kind: "lead_task" },
      { id: "team_1", status: "pending", kind: "team_task" },
      { id: "team_2", status: "pending", kind: "team_task" },
      { id: "agent_1", status: "pending", kind: "agent_task" },
      { id: "agent_2", status: "pending", kind: "agent_task" },
      { id: "verify_1", status: "pending", kind: "verification_task" },
      { id: "verify_2", status: "pending", kind: "verification_task" },
    ];

    const edges: Edge[] = [
      // Hard deps: lead_1 -> team_1, lead_2 -> team_2
      { source_id: "lead_1", target_id: "team_1", type: "hard" },
      { source_id: "lead_2", target_id: "team_2", type: "hard" },
      // Hard dep: team_1 -> agent_1
      { source_id: "team_1", target_id: "agent_1", type: "hard" },
      // Review gate: team_2 -> agent_2
      { source_id: "team_2", target_id: "agent_2", type: "review_gate" },
      // Artifact gate: agent_1 -> verify_1
      { source_id: "agent_1", target_id: "verify_1", type: "artifact_gate" },
      // Hard dep: agent_2 -> verify_2
      { source_id: "agent_2", target_id: "verify_2", type: "hard" },
      // Soft dep (should not block): lead_1 -> lead_2
      { source_id: "lead_1", target_id: "lead_2", type: "soft" },
    ];

    const nodeTeamMap = new Map([
      ["lead_1", "teamA"],
      ["lead_2", "teamA"],
      ["team_1", "teamA"],
      ["team_2", "teamB"],
      ["agent_1", "teamA"],
      ["agent_2", "teamB"],
      ["verify_1", "teamA"],
      ["verify_2", "teamB"],
    ]);

    return { nodes, edges, nodeTeamMap };
  }

  it("should return only nodes with no unsatisfied hard dependencies", () => {
    const { nodes, edges } = buildComplexGraph();
    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    const ready = getReadyNodes(nodes, graph);

    // lead_1: no incoming hard edges -> ready
    // lead_2: incoming soft edge from lead_1 -> soft doesn't block -> ready
    // team_1: blocked by lead_1 (pending) -> not ready
    // team_2: blocked by lead_2 (pending) -> not ready
    // All others: blocked
    const readyIds = ready.map((n) => n.id);
    expect(readyIds).toContain("lead_1");
    expect(readyIds).toContain("lead_2");
    expect(readyIds).not.toContain("team_1");
    expect(readyIds).not.toContain("team_2");
    expect(readyIds).not.toContain("agent_1");
  });

  it("should respect hard deps, review gates, and artifact gates together", () => {
    const { nodes, edges, nodeTeamMap } = buildComplexGraph();
    // Complete lead_1 and lead_2
    nodes[0].status = "completed"; // lead_1
    nodes[1].status = "completed"; // lead_2

    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    const ready = getReadyNodes(nodes, graph);
    const readyIds = ready.map((n) => n.id);

    // team_1: lead_1 completed -> ready
    // team_2: lead_2 completed -> ready
    expect(readyIds).toContain("team_1");
    expect(readyIds).toContain("team_2");
    // agent_1 blocked by team_1 (pending still), agent_2 blocked by team_2 review gate
    expect(readyIds).not.toContain("agent_1");
    expect(readyIds).not.toContain("agent_2");
  });

  it("should unblock review gate when source completes", () => {
    const { nodes, edges } = buildComplexGraph();
    nodes[0].status = "completed"; // lead_1
    nodes[1].status = "completed"; // lead_2
    nodes[3].status = "completed"; // team_2 - needed for review_gate to agent_2

    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    const ready = getReadyNodes(nodes, graph);
    const readyIds = ready.map((n) => n.id);

    expect(readyIds).toContain("agent_2"); // review gate source (team_2) is completed
    expect(readyIds).not.toContain("verify_2"); // agent_2 still pending
  });

  it("should unblock artifact gate when gate is satisfied", () => {
    const { nodes, edges } = buildComplexGraph();
    nodes[0].status = "completed"; // lead_1
    nodes[1].status = "completed"; // lead_2
    nodes[2].status = "completed"; // team_1
    nodes[4].status = "completed"; // agent_1 (source for artifact_gate to verify_1)

    // Satisfy the artifact gate for agent_1 -> verify_1
    gateTracker.satisfy("agent_1", "verify_1");

    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    const ready = getReadyNodes(nodes, graph);
    const readyIds = ready.map((n) => n.id);

    expect(readyIds).toContain("verify_1");
  });

  it("should NOT unblock artifact gate when gate is not satisfied even if source is completed", () => {
    const { nodes, edges } = buildComplexGraph();
    nodes[0].status = "completed"; // lead_1
    nodes[2].status = "completed"; // team_1
    nodes[4].status = "completed"; // agent_1

    // Do NOT satisfy the artifact gate
    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    const ready = getReadyNodes(nodes, graph);
    const readyIds = ready.map((n) => n.id);

    expect(readyIds).not.toContain("verify_1");
  });

  it("should exclude leased nodes from ready results", () => {
    const { nodes, edges } = buildComplexGraph();

    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    leaseManager.acquireLease("lead_1", 60_000);

    const ready = getReadyNodes(nodes, graph, { leaseManager });
    const readyIds = ready.map((n) => n.id);

    expect(readyIds).not.toContain("lead_1");
    expect(readyIds).toContain("lead_2"); // soft dep on lead_1 doesn't block
  });

  it("should include nodes after lease is released", () => {
    const { nodes, edges } = buildComplexGraph();

    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    leaseManager.acquireLease("lead_1", 60_000);
    leaseManager.releaseLease("lead_1");

    const ready = getReadyNodes(nodes, graph, { leaseManager });
    const readyIds = ready.map((n) => n.id);

    expect(readyIds).toContain("lead_1");
  });

  it("should respect maxActivePerRun policy", () => {
    const { nodes, edges, nodeTeamMap } = buildComplexGraph();

    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    const teamPolicy: TeamPolicy = { maxActivePerRun: 3, maxActivePerTeam: 10 };

    // No active nodes, 2 ready (lead_1, lead_2)
    const ready = getReadyNodes(nodes, graph, { teamPolicy, nodeTeamMap });
    expect(ready.length).toBeLessThanOrEqual(3);
    expect(ready.length).toBe(2); // only 2 are ready
  });

  it("should limit ready nodes when active nodes already count toward maxActivePerRun", () => {
    const nodes: Node[] = [
      { id: "n1", status: "active", kind: "lead_task" },
      { id: "n2", status: "active", kind: "lead_task" },
      { id: "n3", status: "pending", kind: "team_task" },
      { id: "n4", status: "pending", kind: "team_task" },
      { id: "n5", status: "pending", kind: "agent_task" },
    ];
    const edges: Edge[] = [];
    const graph = new GraphEngine(nodes, edges);

    const teamPolicy: TeamPolicy = { maxActivePerRun: 3, maxActivePerTeam: 10 };
    const ready = getReadyNodes(nodes, graph, { teamPolicy });

    // 2 active + 1 ready = 3 (max)
    expect(ready.length).toBe(1);
  });

  it("should respect maxActivePerTeam policy", () => {
    const { nodes, edges, nodeTeamMap } = buildComplexGraph();

    const graph = new GraphEngine(nodes, edges);
    graph.setGateTracker(gateTracker);

    const teamPolicy: TeamPolicy = { maxActivePerRun: 12, maxActivePerTeam: 1 };

    const ready = getReadyNodes(nodes, graph, { teamPolicy, nodeTeamMap });
    const readyIds = ready.map((n) => n.id);

    // teamA has 0 active, can add 1: lead_1
    // teamB has no ready nodes (team_2 blocked by lead_2)
    // lead_2 is teamA: but lead_1 already fills the slot -> lead_2 skipped
    expect(readyIds).toContain("lead_1");
    expect(readyIds).not.toContain("lead_2");
  });

  it("should count leased nodes as active for team policy calculation", () => {
    const nodes: Node[] = [
      { id: "n1", status: "pending", kind: "team_task" },
      { id: "n2", status: "pending", kind: "team_task" },
      { id: "n3", status: "pending", kind: "agent_task" },
    ];
    const edges: Edge[] = [];
    const nodeTeamMap = new Map([
      ["n1", "teamA"],
      ["n2", "teamA"],
      ["n3", "teamB"],
    ]);

    const graph = new GraphEngine(nodes, edges);
    leaseManager.acquireLease("n1", 60_000);

    const teamPolicy: TeamPolicy = { maxActivePerRun: 12, maxActivePerTeam: 1 };

    const ready = getReadyNodes(nodes, graph, {
      leaseManager,
      teamPolicy,
      nodeTeamMap,
    });
    const readyIds = ready.map((n) => n.id);

    // n1 is leased (counts as active for teamA), n2 is teamA -> max reached, n3 is teamB -> ready
    expect(readyIds).not.toContain("n1"); // leased
    expect(readyIds).not.toContain("n2"); // team limit
    expect(readyIds).toContain("n3");
  });

  it("should progress through full execution lifecycle", () => {
    const { nodes, edges, nodeTeamMap } = buildComplexGraph();
    const graph = new GraphEngine(nodes, edges);
    gateTracker = new GateTracker();
    graph.setGateTracker(gateTracker);

    // Phase 1: Initial ready
    let ready = getReadyNodes(nodes, graph);
    expect(ready.map((n) => n.id)).toContain("lead_1");
    expect(ready.map((n) => n.id)).toContain("lead_2");

    // Phase 2: Complete lead nodes
    graph.updateNodeStatus("lead_1", "completed");
    graph.updateNodeStatus("lead_2", "completed");
    nodes[0].status = "completed";
    nodes[1].status = "completed";

    ready = getReadyNodes(nodes, graph);
    expect(ready.map((n) => n.id)).toContain("team_1");
    expect(ready.map((n) => n.id)).toContain("team_2");

    // Phase 3: Complete team nodes
    graph.updateNodeStatus("team_1", "completed");
    graph.updateNodeStatus("team_2", "completed");
    nodes[2].status = "completed";
    nodes[3].status = "completed";

    ready = getReadyNodes(nodes, graph);
    const readyIds = ready.map((n) => n.id);
    // agent_1: team_1 completed -> hard dep satisfied -> ready
    expect(readyIds).toContain("agent_1");
    // agent_2: team_2 completed -> review_gate satisfied -> ready
    expect(readyIds).toContain("agent_2");

    // Phase 4: Complete agent nodes and satisfy artifact gate
    graph.updateNodeStatus("agent_1", "completed");
    graph.updateNodeStatus("agent_2", "completed");
    nodes[4].status = "completed";
    nodes[5].status = "completed";
    gateTracker.satisfy("agent_1", "verify_1");

    ready = getReadyNodes(nodes, graph);
    const finalIds = ready.map((n) => n.id);
    expect(finalIds).toContain("verify_1"); // artifact gate satisfied
    expect(finalIds).toContain("verify_2"); // hard dep on agent_2 is completed
  });

  it("should include retryable nodes that have met dependencies", () => {
    const nodes: Node[] = [
      { id: "n1", status: "completed", kind: "lead_task" },
      { id: "n2", status: "retryable", kind: "team_task" },
    ];
    const edges: Edge[] = [
      { source_id: "n1", target_id: "n2", type: "hard" },
    ];

    const graph = new GraphEngine(nodes, edges);
    const ready = getReadyNodes(nodes, graph);
    expect(ready.map((n) => n.id)).toContain("n2");
  });
});
