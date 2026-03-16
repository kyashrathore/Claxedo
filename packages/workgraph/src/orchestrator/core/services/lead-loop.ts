export interface Gap {
  id: string;
  runId: string;
  nodeId: string;
  reason: string;
  detectedAt: string;
}

export interface RerouteRequest {
  id: string;
  runId: string;
  fromNodeId: string;
  toTeamId: string;
  reason: string;
  requestedAt: string;
}

export class LeadLoop {
  private gaps: Gap[] = [];
  private reroutes: RerouteRequest[] = [];

  detectGaps(
    runId: string,
    nodes: Array<{ id: string; status: string; lastActivityAt?: number }>,
    timeoutMs: number = 120_000
  ): Gap[] {
    const now = Date.now();
    const newGaps: Gap[] = [];

    for (const node of nodes) {
      if (node.status === "completed" || node.status === "failed") continue;
      if (
        node.status === "active" &&
        node.lastActivityAt &&
        now - node.lastActivityAt > timeoutMs
      ) {
        const gap: Gap = {
          id: `gap_${node.id}_${now}`,
          runId,
          nodeId: node.id,
          reason: `No progress for ${Math.round((now - node.lastActivityAt) / 1000)}s`,
          detectedAt: new Date().toISOString(),
        };
        newGaps.push(gap);
        this.gaps.push(gap);
      }
    }
    return newGaps;
  }

  requestReroute(
    runId: string,
    fromNodeId: string,
    toTeamId: string,
    reason: string
  ): RerouteRequest {
    const reroute: RerouteRequest = {
      id: `reroute_${fromNodeId}_${Date.now()}`,
      runId,
      fromNodeId,
      toTeamId,
      reason,
      requestedAt: new Date().toISOString(),
    };
    this.reroutes.push(reroute);
    return reroute;
  }

  getGaps(runId: string): Gap[] {
    return this.gaps.filter((g) => g.runId === runId);
  }

  getReroutes(runId: string): RerouteRequest[] {
    return this.reroutes.filter((r) => r.runId === runId);
  }
}
