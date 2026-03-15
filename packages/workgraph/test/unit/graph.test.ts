import { describe, it, expect, beforeEach } from "bun:test";
import { GraphEngine } from "../../src/orchestrator/graph/graph";
import { GateTracker } from "../../src/orchestrator/graph/gates";

// ---------------------------------------------------------------------------
// GateTracker
// ---------------------------------------------------------------------------

describe("GateTracker", () => {
  let tracker: GateTracker;

  beforeEach(() => { tracker = new GateTracker(); });

  it("starts empty", () => {
    expect(tracker.getSatisfiedCount()).toBe(0);
    expect(tracker.isSatisfied("a", "b")).toBe(false);
  });

  it("satisfy marks gate as satisfied", () => {
    tracker.satisfy("src", "tgt");
    expect(tracker.isSatisfied("src", "tgt")).toBe(true);
  });

  it("different pair not satisfied", () => {
    tracker.satisfy("src", "tgt");
    expect(tracker.isSatisfied("src", "other")).toBe(false);
    expect(tracker.isSatisfied("other", "tgt")).toBe(false);
  });

  it("reopen removes gate", () => {
    tracker.satisfy("a", "b");
    tracker.reopen("a", "b");
    expect(tracker.isSatisfied("a", "b")).toBe(false);
    expect(tracker.getSatisfiedCount()).toBe(0);
  });

  it("getSatisfiedCount tracks multiple gates", () => {
    tracker.satisfy("a", "b");
    tracker.satisfy("a", "c");
    tracker.satisfy("b", "c");
    expect(tracker.getSatisfiedCount()).toBe(3);
  });

  it("clear removes all gates", () => {
    tracker.satisfy("a", "b");
    tracker.satisfy("c", "d");
    tracker.clear();
    expect(tracker.getSatisfiedCount()).toBe(0);
    expect(tracker.isSatisfied("a", "b")).toBe(false);
  });

  it("gate satisfaction is directional: satisfy(a,b) does not satisfy(b,a)", () => {
    tracker.satisfy("a", "b");
    expect(tracker.isSatisfied("b", "a")).toBe(false);
  });

  it("reopen on unsatisfied gate is a no-op", () => {
    expect(() => tracker.reopen("x", "y")).not.toThrow();
    expect(tracker.getSatisfiedCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GraphEngine — node / edge CRUD
// ---------------------------------------------------------------------------

describe("GraphEngine — nodes and edges", () => {
  let g: GraphEngine;

  beforeEach(() => {
    g = new GraphEngine(
      [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" },
        { id: "c", status: "pending" },
      ],
      [],
    );
  });

  it("getNode returns node", () => {
    expect(g.getNode("a")).toEqual({ id: "a", status: "pending" });
  });

  it("getNode returns undefined for unknown id", () => {
    expect(g.getNode("z")).toBeUndefined();
  });

  it("getNodes returns all nodes", () => {
    expect(g.getNodes()).toHaveLength(3);
  });

  it("addNode registers node", () => {
    g.addNode({ id: "d", status: "pending" });
    expect(g.getNode("d")).toBeDefined();
    expect(g.getNodes()).toHaveLength(4);
  });

  it("removeNode deletes node", () => {
    g.removeNode("a");
    expect(g.getNode("a")).toBeUndefined();
    expect(g.getNodes()).toHaveLength(2);
  });

  it("updateNodeStatus changes status", () => {
    g.updateNodeStatus("a", "completed");
    expect(g.getNode("a")?.status).toBe("completed");
  });

  it("updateNodeStatus on unknown node is no-op", () => {
    expect(() => g.updateNodeStatus("z", "completed")).not.toThrow();
  });

  it("addEdge makes edge retrievable", () => {
    g.addEdge({ source_id: "a", target_id: "b", type: "hard" });
    expect(g.getEdges()).toHaveLength(1);
  });

  it("mutating getEdges result does not affect internal state", () => {
    g.addEdge({ source_id: "a", target_id: "b", type: "hard" });
    const copy = g.getEdges();
    copy.push({ source_id: "x", target_id: "y", type: "soft" });
    expect(g.getEdges()).toHaveLength(1);
  });

  it("removeEdge removes matching edge only", () => {
    g.addEdge({ source_id: "a", target_id: "b", type: "hard" });
    g.addEdge({ source_id: "b", target_id: "c", type: "hard" });
    g.removeEdge("a", "b");
    expect(g.getEdges()).toHaveLength(1);
    expect(g.getEdges()[0].source_id).toBe("b");
  });

  it("getIncomingEdges returns edges targeting node", () => {
    g.addEdge({ source_id: "a", target_id: "c", type: "hard" });
    g.addEdge({ source_id: "b", target_id: "c", type: "soft" });
    const incoming = g.getIncomingEdges("c");
    expect(incoming).toHaveLength(2);
    expect(incoming.map(e => e.source_id).sort()).toEqual(["a", "b"]);
  });

  it("getOutgoingEdges returns edges from node", () => {
    g.addEdge({ source_id: "a", target_id: "b", type: "hard" });
    g.addEdge({ source_id: "a", target_id: "c", type: "soft" });
    expect(g.getOutgoingEdges("a")).toHaveLength(2);
    expect(g.getOutgoingEdges("b")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GraphEngine — hasCycles
// ---------------------------------------------------------------------------

describe("GraphEngine — hasCycles", () => {
  it("empty graph has no cycles", () => {
    expect(new GraphEngine([], []).hasCycles()).toBe(false);
  });

  it("linear chain has no cycles", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }, { id: "c", status: "pending" }],
      [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "b", target_id: "c", type: "hard" },
      ],
    );
    expect(g.hasCycles()).toBe(false);
  });

  it("diamond graph has no cycles", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }, { id: "c", status: "pending" }, { id: "d", status: "pending" }],
      [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "a", target_id: "c", type: "hard" },
        { source_id: "b", target_id: "d", type: "hard" },
        { source_id: "c", target_id: "d", type: "hard" },
      ],
    );
    expect(g.hasCycles()).toBe(false);
  });

  it("direct hard cycle is detected", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }],
      [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "b", target_id: "a", type: "hard" },
      ],
    );
    expect(g.hasCycles()).toBe(true);
  });

  it("transitive hard cycle is detected", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }, { id: "c", status: "pending" }],
      [
        { source_id: "a", target_id: "b", type: "hard" },
        { source_id: "b", target_id: "c", type: "hard" },
        { source_id: "c", target_id: "a", type: "hard" },
      ],
    );
    expect(g.hasCycles()).toBe(true);
  });

  it("soft cycles are ignored (not detected)", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }],
      [
        { source_id: "a", target_id: "b", type: "soft" },
        { source_id: "b", target_id: "a", type: "soft" },
      ],
    );
    expect(g.hasCycles()).toBe(false);
  });

  it("review_gate cycles are ignored", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }],
      [
        { source_id: "a", target_id: "b", type: "review_gate" },
        { source_id: "b", target_id: "a", type: "review_gate" },
      ],
    );
    expect(g.hasCycles()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GraphEngine — isReady
// ---------------------------------------------------------------------------

describe("GraphEngine — isReady", () => {
  it("returns false for unknown node", () => {
    expect(new GraphEngine([], []).isReady("z")).toBe(false);
  });

  it("returns false for active node", () => {
    const g = new GraphEngine([{ id: "a", status: "active" }], []);
    expect(g.isReady("a")).toBe(false);
  });

  it("returns false for completed node", () => {
    const g = new GraphEngine([{ id: "a", status: "completed" }], []);
    expect(g.isReady("a")).toBe(false);
  });

  it("returns false for failed node", () => {
    const g = new GraphEngine([{ id: "a", status: "failed" }], []);
    expect(g.isReady("a")).toBe(false);
  });

  it("returns true for retryable node with no deps", () => {
    const g = new GraphEngine([{ id: "a", status: "retryable" }], []);
    expect(g.isReady("a")).toBe(true);
  });

  it("returns true for pending node with no deps", () => {
    const g = new GraphEngine([{ id: "a", status: "pending" }], []);
    expect(g.isReady("a")).toBe(true);
  });

  it("hard dep not completed blocks readiness", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "hard" }],
    );
    expect(g.isReady("b")).toBe(false);
  });

  it("hard dep completed allows readiness", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "completed" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "hard" }],
    );
    expect(g.isReady("b")).toBe(true);
  });

  it("review_gate dep not completed blocks readiness", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "review_gate" }],
    );
    expect(g.isReady("b")).toBe(false);
  });

  it("review_gate dep completed allows readiness", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "completed" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "review_gate" }],
    );
    expect(g.isReady("b")).toBe(true);
  });

  it("soft edges do not block readiness", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "pending" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "soft" }],
    );
    expect(g.isReady("b")).toBe(true);
  });

  it("artifact_gate blocks when no tracker is set or passed", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "completed" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "artifact_gate" }],
    );
    expect(g.isReady("b")).toBe(false);
  });

  it("artifact_gate blocks when gate not satisfied", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "completed" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "artifact_gate" }],
    );
    const tracker = new GateTracker();
    expect(g.isReady("b", tracker)).toBe(false);
  });

  it("artifact_gate passes when gate satisfied via arg", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "completed" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "artifact_gate" }],
    );
    const tracker = new GateTracker();
    tracker.satisfy("a", "b");
    expect(g.isReady("b", tracker)).toBe(true);
  });

  it("uses instance tracker when no arg provided", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "completed" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "artifact_gate" }],
    );
    const tracker = new GateTracker();
    tracker.satisfy("a", "b");
    g.setGateTracker(tracker);
    expect(g.isReady("b")).toBe(true);
  });

  it("explicit arg tracker overrides instance tracker", () => {
    const g = new GraphEngine(
      [{ id: "a", status: "completed" }, { id: "b", status: "pending" }],
      [{ source_id: "a", target_id: "b", type: "artifact_gate" }],
    );
    const instanceTracker = new GateTracker();
    instanceTracker.satisfy("a", "b");
    g.setGateTracker(instanceTracker);

    const argTracker = new GateTracker(); // NOT satisfied
    expect(g.isReady("b", argTracker)).toBe(false);
  });

  it("missing source node in graph blocks hard edge", () => {
    const g = new GraphEngine(
      [{ id: "b", status: "pending" }],
      [{ source_id: "missing", target_id: "b", type: "hard" }],
    );
    expect(g.isReady("b")).toBe(false);
  });
});
