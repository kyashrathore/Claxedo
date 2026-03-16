import { GraphEngine, type Node } from "../graph";

export interface Lease {
  nodeId: string;
  acquiredAt: number;
  expiresAt: number;
}

export class LeaseManager {
  private leases: Map<string, Lease> = new Map();

  acquireLease(nodeId: string, durationMs: number = 30_000): boolean {
    // If already leased and not expired, cannot acquire
    if (this.isLeased(nodeId)) {
      return false;
    }
    // Remove expired lease if any
    this.leases.delete(nodeId);

    const now = Date.now();
    this.leases.set(nodeId, {
      nodeId,
      acquiredAt: now,
      expiresAt: now + durationMs,
    });
    return true;
  }

  releaseLease(nodeId: string): void {
    this.leases.delete(nodeId);
  }

  isLeased(nodeId: string): boolean {
    const lease = this.leases.get(nodeId);
    if (!lease) return false;
    if (Date.now() >= lease.expiresAt) {
      this.leases.delete(nodeId);
      return false;
    }
    return true;
  }

  getActiveLeases(): Lease[] {
    this.cleanup();
    return Array.from(this.leases.values());
  }

  cleanup(): void {
    const now = Date.now();
    for (const [nodeId, lease] of this.leases) {
      if (now >= lease.expiresAt) {
        this.leases.delete(nodeId);
      }
    }
  }
}

export interface TeamPolicy {
  maxActivePerRun: number;  // default 12
  maxActivePerTeam: number; // default 4
}

export function getReadyNodes(
  nodes: Node[],
  graph: GraphEngine,
  options?: {
    leaseManager?: LeaseManager;
    teamPolicy?: TeamPolicy;
    nodeTeamMap?: Map<string, string>; // nodeId -> teamId
  }
): Node[] {
  const leaseManager = options?.leaseManager;
  const teamPolicy = options?.teamPolicy;
  const nodeTeamMap = options?.nodeTeamMap;

  const maxActivePerRun = teamPolicy?.maxActivePerRun ?? 12;
  const maxActivePerTeam = teamPolicy?.maxActivePerTeam ?? 4;

  // Count currently active and leased nodes
  let activeCount = 0;
  const activePerTeam = new Map<string, number>();

  for (const node of nodes) {
    const isActive = node.status === "active";
    const isLeased = leaseManager ? leaseManager.isLeased(node.id) : false;

    if (isActive || isLeased) {
      activeCount++;
      if (nodeTeamMap) {
        const teamId = nodeTeamMap.get(node.id);
        if (teamId) {
          activePerTeam.set(teamId, (activePerTeam.get(teamId) || 0) + 1);
        }
      }
    }
  }

  const readyNodes: Node[] = [];

  for (const node of nodes) {
    // Only pending or retryable nodes are eligible to be dispatched
    if (node.status !== "pending" && node.status !== "retryable") {
      continue;
    }

    // Exclude leased nodes
    if (leaseManager && leaseManager.isLeased(node.id)) {
      continue;
    }

    if (!graph.isReady(node.id)) {
      continue;
    }

    // Check maxActivePerRun
    if (activeCount + readyNodes.length >= maxActivePerRun) {
      break;
    }

    // Check maxActivePerTeam
    if (nodeTeamMap && teamPolicy) {
      const teamId = nodeTeamMap.get(node.id);
      if (teamId) {
        const currentTeamActive = (activePerTeam.get(teamId) || 0);
        // Count how many we've already added for this team in this batch
        const alreadyAddedForTeam = readyNodes.filter(
          rn => nodeTeamMap.get(rn.id) === teamId
        ).length;
        if (currentTeamActive + alreadyAddedForTeam >= maxActivePerTeam) {
          continue;
        }
      }
    }

    readyNodes.push(node);
  }

  return readyNodes;
}
