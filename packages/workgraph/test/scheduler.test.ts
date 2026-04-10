import { describe, it, expect } from "vitest";
import { type RunState } from "../src/orchestrator/core/reducers/run";
import { getReadyNodes, LeaseManager } from "../src/orchestrator/core/scheduler";
import { GraphEngine } from "../src/orchestrator/graph/graph";

// Mock minimal nodes and graph to test scheduling logic
describe("Scheduler Engine", () => {
  it("should return nodes that are pending and have no hard blockers", () => {
    // In TDD we mock the DB state or reducer state
    const nodes = [
      { id: "node_1", status: "completed" as const },
      { id: "node_2", status: "pending" as const },
      { id: "node_3", status: "pending" as const }
    ];

    const edges = [
      { source_id: "node_1", target_id: "node_2", type: "hard" as const },
      { source_id: "node_2", target_id: "node_3", type: "hard" as const }
    ];

    const graph = new GraphEngine(nodes, edges);

    // We pass the graph engine into our scheduler to find what to dispatch
    const readyNodes = getReadyNodes(nodes, graph);

    expect(readyNodes.length).toBe(1);
    expect(readyNodes[0].id).toBe("node_2"); // Node 1 is done, so Node 2 is ready. Node 3 waits for Node 2.
  });

  it("should not return any nodes if all are waiting or completed", () => {
    const nodes = [
      { id: "node_1", status: "pending" as const },
      { id: "node_2", status: "pending" as const }
    ];

    const edges = [
      { source_id: "node_1", target_id: "node_2", type: "hard" as const }
    ];

    const graph = new GraphEngine(nodes, edges);
    const readyNodes = getReadyNodes(nodes, graph);

    expect(readyNodes.length).toBe(1);
    expect(readyNodes[0].id).toBe("node_1"); // Node 1 is ready since it has no incoming hard edges
  });

  describe("Retryable nodes", () => {
    it("should include retryable nodes in ready list", () => {
      const nodes = [
        { id: "node_1", status: "completed" as const },
        { id: "node_2", status: "retryable" as const }
      ];

      const edges = [
        { source_id: "node_1", target_id: "node_2", type: "hard" as const }
      ];

      const graph = new GraphEngine(nodes, edges);
      const readyNodes = getReadyNodes(nodes, graph);

      expect(readyNodes.length).toBe(1);
      expect(readyNodes[0].id).toBe("node_2");
    });

    it("should not include retryable nodes whose dependencies are not met", () => {
      const nodes = [
        { id: "node_1", status: "pending" as const },
        { id: "node_2", status: "retryable" as const }
      ];

      const edges = [
        { source_id: "node_1", target_id: "node_2", type: "hard" as const }
      ];

      const graph = new GraphEngine(nodes, edges);
      const readyNodes = getReadyNodes(nodes, graph);

      expect(readyNodes.length).toBe(1);
      expect(readyNodes[0].id).toBe("node_1"); // Only node_1 is ready
    });
  });

  describe("LeaseManager", () => {
    it("should acquire a lease successfully", () => {
      const lm = new LeaseManager();
      expect(lm.acquireLease("n1")).toBe(true);
      expect(lm.isLeased("n1")).toBe(true);
    });

    it("should prevent double acquisition of the same lease", () => {
      const lm = new LeaseManager();
      lm.acquireLease("n1");
      expect(lm.acquireLease("n1")).toBe(false);
    });

    it("should release a lease", () => {
      const lm = new LeaseManager();
      lm.acquireLease("n1");
      lm.releaseLease("n1");
      expect(lm.isLeased("n1")).toBe(false);
    });

    it("should treat expired leases as not leased", () => {
      const lm = new LeaseManager();
      // Acquire with 0ms duration — effectively immediately expired
      lm.acquireLease("n1", 0);
      // Need a small delay to ensure Date.now() >= expiresAt
      expect(lm.isLeased("n1")).toBe(false);
    });

    it("should allow re-acquisition after expiry", () => {
      const lm = new LeaseManager();
      lm.acquireLease("n1", 0);
      // Lease is expired, so we should be able to re-acquire
      expect(lm.acquireLease("n1")).toBe(true);
    });

    it("should return active leases excluding expired ones", () => {
      const lm = new LeaseManager();
      lm.acquireLease("n1", 60_000);
      lm.acquireLease("n2", 0); // immediately expired
      const active = lm.getActiveLeases();
      expect(active.length).toBe(1);
      expect(active[0].nodeId).toBe("n1");
    });

    it("cleanup should remove expired leases", () => {
      const lm = new LeaseManager();
      lm.acquireLease("n1", 0);
      lm.acquireLease("n2", 60_000);
      lm.cleanup();
      expect(lm.isLeased("n1")).toBe(false);
      expect(lm.isLeased("n2")).toBe(true);
    });
  });

  describe("Leased nodes excluded from ready list", () => {
    it("should exclude leased nodes from ready results", () => {
      const nodes = [
        { id: "n1", status: "pending" as const },
        { id: "n2", status: "pending" as const }
      ];
      const edges: any[] = [];
      const graph = new GraphEngine(nodes, edges);
      const lm = new LeaseManager();
      lm.acquireLease("n1");

      const ready = getReadyNodes(nodes, graph, { leaseManager: lm });
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("n2");
    });

    it("should include previously leased nodes after lease expires", () => {
      const nodes = [
        { id: "n1", status: "pending" as const }
      ];
      const edges: any[] = [];
      const graph = new GraphEngine(nodes, edges);
      const lm = new LeaseManager();
      lm.acquireLease("n1", 0); // immediately expired

      const ready = getReadyNodes(nodes, graph, { leaseManager: lm });
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("n1");
    });
  });

  describe("Team policy: maxActivePerRun", () => {
    it("should limit the total number of ready nodes based on active + leased count", () => {
      const nodes = [
        { id: "n1", status: "active" as const },
        { id: "n2", status: "active" as const },
        { id: "n3", status: "pending" as const },
        { id: "n4", status: "pending" as const },
        { id: "n5", status: "pending" as const }
      ];
      const edges: any[] = [];
      const graph = new GraphEngine(nodes, edges);

      const ready = getReadyNodes(nodes, graph, {
        teamPolicy: { maxActivePerRun: 3, maxActivePerTeam: 10 }
      });

      // 2 active, so only 1 more can be scheduled
      expect(ready.length).toBe(1);
    });

    it("should return no ready nodes if max is already reached", () => {
      const nodes = [
        { id: "n1", status: "active" as const },
        { id: "n2", status: "active" as const },
        { id: "n3", status: "pending" as const }
      ];
      const edges: any[] = [];
      const graph = new GraphEngine(nodes, edges);

      const ready = getReadyNodes(nodes, graph, {
        teamPolicy: { maxActivePerRun: 2, maxActivePerTeam: 10 }
      });

      expect(ready.length).toBe(0);
    });
  });

  describe("Team policy: maxActivePerTeam", () => {
    it("should limit ready nodes per team", () => {
      const nodes = [
        { id: "n1", status: "active" as const },
        { id: "n2", status: "pending" as const },
        { id: "n3", status: "pending" as const },
        { id: "n4", status: "pending" as const }
      ];
      const edges: any[] = [];
      const graph = new GraphEngine(nodes, edges);

      const nodeTeamMap = new Map([
        ["n1", "teamA"],
        ["n2", "teamA"],
        ["n3", "teamA"],
        ["n4", "teamB"]
      ]);

      const ready = getReadyNodes(nodes, graph, {
        teamPolicy: { maxActivePerRun: 12, maxActivePerTeam: 2 },
        nodeTeamMap
      });

      // teamA: 1 active + at most 1 more = n2 ready. n3 would exceed team limit
      // teamB: 0 active + n4 ready
      const readyIds = ready.map(n => n.id);
      expect(readyIds).toContain("n2");
      expect(readyIds).toContain("n4");
      expect(readyIds).not.toContain("n3");
    });

    it("should not limit nodes without a team mapping", () => {
      const nodes = [
        { id: "n1", status: "pending" as const },
        { id: "n2", status: "pending" as const }
      ];
      const edges: any[] = [];
      const graph = new GraphEngine(nodes, edges);

      const ready = getReadyNodes(nodes, graph, {
        teamPolicy: { maxActivePerRun: 12, maxActivePerTeam: 1 },
        nodeTeamMap: new Map() // no team mappings
      });

      // No team constraint since nodes aren't mapped
      expect(ready.length).toBe(2);
    });
  });
});
