import { describe, it, expect } from "bun:test";
import { GraphEngine, type Node, type Edge } from "../src/orchestrator/graph/graph";
import { GateTracker } from "../src/orchestrator/graph/gates";

describe("GraphEngine", () => {
  it("should detect a simple hard cycle between nodes", () => {
    const nodes: Node[] = [
      { id: "node_A", status: "pending" },
      { id: "node_B", status: "pending" }
    ];

    const edges: Edge[] = [
      { source_id: "node_A", target_id: "node_B", type: "hard" },
      { source_id: "node_B", target_id: "node_A", type: "hard" }
    ];

    const engine = new GraphEngine(nodes, edges);
    expect(engine.hasCycles()).toBe(true);
  });

  it("should mark a node as ready when its hard dependencies are complete", () => {
    const nodes: Node[] = [
      { id: "node_A", status: "completed" },
      { id: "node_B", status: "pending" }
    ];

    const edges: Edge[] = [
      { source_id: "node_A", target_id: "node_B", type: "hard" }
    ];

    const engine = new GraphEngine(nodes, edges);
    expect(engine.hasCycles()).toBe(false);
    expect(engine.isReady("node_B")).toBe(true);
  });

  it("should not mark a node as ready if a hard dependency is still pending", () => {
    const nodes: Node[] = [
      { id: "node_A", status: "pending" },
      { id: "node_B", status: "pending" }
    ];

    const edges: Edge[] = [
      { source_id: "node_A", target_id: "node_B", type: "hard" }
    ];

    const engine = new GraphEngine(nodes, edges);
    expect(engine.isReady("node_B")).toBe(false);
  });

  describe("addNode / removeNode", () => {
    it("should add a node to the graph", () => {
      const engine = new GraphEngine([], []);
      engine.addNode({ id: "n1", status: "pending" });
      expect(engine.getNode("n1")).toEqual({ id: "n1", status: "pending" });
    });

    it("should remove a node from the graph", () => {
      const engine = new GraphEngine([{ id: "n1", status: "pending" }], []);
      engine.removeNode("n1");
      expect(engine.getNode("n1")).toBeUndefined();
    });

    it("should overwrite a node with the same id", () => {
      const engine = new GraphEngine([{ id: "n1", status: "pending" }], []);
      engine.addNode({ id: "n1", status: "completed" });
      expect(engine.getNode("n1")!.status).toBe("completed");
    });

    it("removeNode should be a no-op for non-existent nodes", () => {
      const engine = new GraphEngine([], []);
      engine.removeNode("nonexistent"); // should not throw
      expect(engine.getNodes()).toHaveLength(0);
    });
  });

  describe("addEdge / removeEdge", () => {
    it("should add an edge to the graph", () => {
      const engine = new GraphEngine([], []);
      engine.addEdge({ source_id: "a", target_id: "b", type: "hard" });
      expect(engine.getEdges()).toHaveLength(1);
      expect(engine.getEdges()[0]).toEqual({ source_id: "a", target_id: "b", type: "hard" });
    });

    it("should remove a matching edge", () => {
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "b", target_id: "c", type: "soft" }
      ];
      const engine = new GraphEngine([], edges);
      engine.removeEdge("a", "b");
      expect(engine.getEdges()).toHaveLength(1);
      expect(engine.getEdges()[0].source_id).toBe("b");
    });

    it("removeEdge should be a no-op for non-existent edges", () => {
      const engine = new GraphEngine([], [{ source_id: "a", target_id: "b", type: "hard" }]);
      engine.removeEdge("x", "y");
      expect(engine.getEdges()).toHaveLength(1);
    });
  });

  describe("getIncomingEdges / getOutgoingEdges", () => {
    it("should return incoming edges for a node", () => {
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "c", target_id: "b", type: "soft" },
        { source_id: "b", target_id: "d", type: "hard" }
      ];
      const engine = new GraphEngine([], edges);
      const incoming = engine.getIncomingEdges("b");
      expect(incoming).toHaveLength(2);
      expect(incoming.every(e => e.target_id === "b")).toBe(true);
    });

    it("should return outgoing edges for a node", () => {
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "a", target_id: "c", type: "soft" },
        { source_id: "b", target_id: "d", type: "hard" }
      ];
      const engine = new GraphEngine([], edges);
      const outgoing = engine.getOutgoingEdges("a");
      expect(outgoing).toHaveLength(2);
      expect(outgoing.every(e => e.source_id === "a")).toBe(true);
    });

    it("should return empty array when no edges match", () => {
      const engine = new GraphEngine([], []);
      expect(engine.getIncomingEdges("x")).toHaveLength(0);
      expect(engine.getOutgoingEdges("x")).toHaveLength(0);
    });
  });

  describe("getNode / getNodes / getEdges", () => {
    it("getNode should return undefined for missing node", () => {
      const engine = new GraphEngine([], []);
      expect(engine.getNode("missing")).toBeUndefined();
    });

    it("getNodes should return all nodes", () => {
      const nodes: Node[] = [
        { id: "a", status: "pending" },
        { id: "b", status: "completed" },
        { id: "c", status: "failed" }
      ];
      const engine = new GraphEngine(nodes, []);
      const result = engine.getNodes();
      expect(result).toHaveLength(3);
      const ids = result.map(n => n.id).sort();
      expect(ids).toEqual(["a", "b", "c"]);
    });

    it("getEdges should return a copy of edges", () => {
      const edges: Edge[] = [{ source_id: "a", target_id: "b", type: "hard" }];
      const engine = new GraphEngine([], edges);
      const result = engine.getEdges();
      result.push({ source_id: "x", target_id: "y", type: "soft" });
      expect(engine.getEdges()).toHaveLength(1); // original unmodified
    });
  });

  describe("updateNodeStatus", () => {
    it("should update a node's status in-place", () => {
      const engine = new GraphEngine([{ id: "n1", status: "pending" }], []);
      engine.updateNodeStatus("n1", "active");
      expect(engine.getNode("n1")!.status).toBe("active");
    });

    it("should be a no-op for non-existent node", () => {
      const engine = new GraphEngine([], []);
      engine.updateNodeStatus("nonexistent", "active"); // should not throw
    });

    it("should support retryable status", () => {
      const engine = new GraphEngine([{ id: "n1", status: "failed" }], []);
      engine.updateNodeStatus("n1", "retryable");
      expect(engine.getNode("n1")!.status).toBe("retryable");
    });
  });

  describe("isReady with review_gate", () => {
    it("should block when review_gate source is not completed", () => {
      const nodes: Node[] = [
        { id: "reviewer", status: "active" },
        { id: "target", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "reviewer", target_id: "target", type: "review_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.isReady("target")).toBe(false);
    });

    it("should be ready when review_gate source is completed", () => {
      const nodes: Node[] = [
        { id: "reviewer", status: "completed" },
        { id: "target", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "reviewer", target_id: "target", type: "review_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.isReady("target")).toBe(true);
    });
  });

  describe("isReady with artifact_gate", () => {
    it("should block when artifact_gate is not satisfied", () => {
      const nodes: Node[] = [
        { id: "producer", status: "completed" },
        { id: "consumer", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "producer", target_id: "consumer", type: "artifact_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      // No gate tracker — should not be ready
      expect(engine.isReady("consumer")).toBe(false);
    });

    it("should be ready when artifact_gate is satisfied via parameter", () => {
      const nodes: Node[] = [
        { id: "producer", status: "completed" },
        { id: "consumer", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "producer", target_id: "consumer", type: "artifact_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      const tracker = new GateTracker();
      tracker.satisfy("producer", "consumer");
      expect(engine.isReady("consumer", tracker)).toBe(true);
    });

    it("should be ready when artifact_gate is satisfied via setGateTracker", () => {
      const nodes: Node[] = [
        { id: "producer", status: "completed" },
        { id: "consumer", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "producer", target_id: "consumer", type: "artifact_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      const tracker = new GateTracker();
      tracker.satisfy("producer", "consumer");
      engine.setGateTracker(tracker);
      expect(engine.isReady("consumer")).toBe(true);
    });

    it("should block when artifact_gate is reopened", () => {
      const nodes: Node[] = [
        { id: "producer", status: "completed" },
        { id: "consumer", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "producer", target_id: "consumer", type: "artifact_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      const tracker = new GateTracker();
      tracker.satisfy("producer", "consumer");
      tracker.reopen("producer", "consumer");
      engine.setGateTracker(tracker);
      expect(engine.isReady("consumer")).toBe(false);
    });
  });

  describe("isReady with retryable status", () => {
    it("should consider retryable nodes as ready when dependencies are met", () => {
      const nodes: Node[] = [
        { id: "dep", status: "completed" },
        { id: "target", status: "retryable" }
      ];
      const edges: Edge[] = [
        { source_id: "dep", target_id: "target", type: "hard" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.isReady("target")).toBe(true);
    });

    it("should not consider active nodes as ready", () => {
      const engine = new GraphEngine([{ id: "n", status: "active" }], []);
      expect(engine.isReady("n")).toBe(false);
    });

    it("should not consider failed nodes as ready", () => {
      const engine = new GraphEngine([{ id: "n", status: "failed" }], []);
      expect(engine.isReady("n")).toBe(false);
    });

    it("should not consider completed nodes as ready", () => {
      const engine = new GraphEngine([{ id: "n", status: "completed" }], []);
      expect(engine.isReady("n")).toBe(false);
    });
  });

  describe("hasCycles with new edge types", () => {
    it("should not consider soft edges for cycle detection", () => {
      const nodes: Node[] = [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "soft" },
        { source_id: "b", target_id: "a", type: "soft" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.hasCycles()).toBe(false);
    });

    it("should not consider review_gate edges for cycle detection", () => {
      const nodes: Node[] = [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "review_gate" },
        { source_id: "b", target_id: "a", type: "review_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.hasCycles()).toBe(false);
    });

    it("should not consider artifact_gate edges for cycle detection", () => {
      const nodes: Node[] = [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "artifact_gate" },
        { source_id: "b", target_id: "a", type: "artifact_gate" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.hasCycles()).toBe(false);
    });

    it("should still detect cycles in hard edges only", () => {
      const nodes: Node[] = [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" },
        { id: "c", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "b", target_id: "c", type: "hard" },
        { source_id: "c", target_id: "a", type: "hard" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.hasCycles()).toBe(true);
    });

    it("should report no cycle when graph is a DAG", () => {
      const nodes: Node[] = [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" },
        { id: "c", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "b", target_id: "c", type: "hard" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.hasCycles()).toBe(false);
    });
  });

  describe("Node kind field", () => {
    it("should store and retrieve node kind", () => {
      const node: Node = { id: "t1", status: "pending", kind: "lead_task" };
      const engine = new GraphEngine([node], []);
      expect(engine.getNode("t1")!.kind).toBe("lead_task");
    });

    it("should default kind to undefined", () => {
      const node: Node = { id: "t1", status: "pending" };
      const engine = new GraphEngine([node], []);
      expect(engine.getNode("t1")!.kind).toBeUndefined();
    });
  });

  describe("soft edges do not block readiness", () => {
    it("should allow ready status even when soft dependency is not completed", () => {
      const nodes: Node[] = [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" }
      ];
      const edges: Edge[] = [
        { source_id: "a", target_id: "b", type: "soft" }
      ];
      const engine = new GraphEngine(nodes, edges);
      expect(engine.isReady("b")).toBe(true);
    });
  });
});
