import { GateTracker } from "./gates";

export interface Node {
  id: string;
  status: "pending" | "active" | "completed" | "failed" | "retryable";
  kind?: "lead_task" | "team_task" | "agent_task" | "verification_task" | "synthesis_task";
}

export interface Edge {
  source_id: string;
  target_id: string;
  type: "hard" | "soft" | "review_gate" | "artifact_gate";
}

export class GraphEngine {
  private nodes: Map<string, Node> = new Map();
  private edges: Edge[] = [];
  private gateTracker?: GateTracker;

  constructor(nodes: Node[], edges: Edge[]) {
    nodes.forEach(n => this.nodes.set(n.id, n));
    this.edges = edges;
  }

  setGateTracker(tracker: GateTracker): void {
    this.gateTracker = tracker;
  }

  getGateTracker(): GateTracker | undefined {
    return this.gateTracker;
  }

  addNode(node: Node): void {
    this.nodes.set(node.id, node);
  }

  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
  }

  addEdge(edge: Edge): void {
    this.edges.push(edge);
  }

  removeEdge(sourceId: string, targetId: string): void {
    this.edges = this.edges.filter(
      e => !(e.source_id === sourceId && e.target_id === targetId)
    );
  }

  getNode(nodeId: string): Node | undefined {
    return this.nodes.get(nodeId);
  }

  getNodes(): Node[] {
    return Array.from(this.nodes.values());
  }

  getEdges(): Edge[] {
    return [...this.edges];
  }

  getIncomingEdges(nodeId: string): Edge[] {
    return this.edges.filter(e => e.target_id === nodeId);
  }

  getOutgoingEdges(nodeId: string): Edge[] {
    return this.edges.filter(e => e.source_id === nodeId);
  }

  updateNodeStatus(nodeId: string, status: Node["status"]): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.status = status;
    }
  }

  hasCycles(): boolean {
    const adj = new Map<string, string[]>();
    for (const n of this.nodes.values()) {
      adj.set(n.id, []);
    }

    for (const e of this.edges) {
      if (e.type === "hard") {
        adj.get(e.source_id)?.push(e.target_id);
      }
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    const isCyclicUtil = (nodeId: string): boolean => {
      if (recStack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;

      visited.add(nodeId);
      recStack.add(nodeId);

      const neighbors = adj.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (isCyclicUtil(neighbor)) {
          return true;
        }
      }

      recStack.delete(nodeId);
      return false;
    };

    for (const nodeId of this.nodes.keys()) {
      if (isCyclicUtil(nodeId)) {
        return true;
      }
    }

    return false;
  }

  isReady(nodeId: string, gateTracker?: GateTracker): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;

    // Node must be "pending" or "retryable" to be ready
    if (node.status !== "pending" && node.status !== "retryable") return false;

    const tracker = gateTracker || this.gateTracker;

    // Check all incoming edges where target is this node
    const incomingEdges = this.edges.filter(e => e.target_id === nodeId);

    for (const e of incomingEdges) {
      if (e.type === "hard" || e.type === "review_gate") {
        const sourceNode = this.nodes.get(e.source_id);
        if (!sourceNode || sourceNode.status !== "completed") {
          return false;
        }
      } else if (e.type === "artifact_gate") {
        if (!tracker || !tracker.isSatisfied(e.source_id, e.target_id)) {
          return false;
        }
      }
      // "soft" edges do not block readiness
    }

    return true;
  }
}
