export interface WatchdogConfig {
  noProgressTimeoutMs: number; // default 120_000 (120s)
  checkIntervalMs: number; // default 10_000 (10s)
}

export interface NodeProgress {
  nodeId: string;
  lastActivityAt: number;
  status: string;
}

export class Watchdog {
  private config: WatchdogConfig;
  private progress: Map<string, NodeProgress> = new Map();

  constructor(config?: Partial<WatchdogConfig>) {
    this.config = {
      noProgressTimeoutMs: config?.noProgressTimeoutMs ?? 120_000,
      checkIntervalMs: config?.checkIntervalMs ?? 10_000,
    };
  }

  recordActivity(nodeId: string, status: string): void {
    this.progress.set(nodeId, { nodeId, lastActivityAt: Date.now(), status });
  }

  checkStalled(now?: number): Array<{ nodeId: string; stalledForMs: number }> {
    const currentTime = now ?? Date.now();
    const stalled: Array<{ nodeId: string; stalledForMs: number }> = [];

    for (const [nodeId, progress] of this.progress) {
      if (progress.status === "completed" || progress.status === "failed") continue;
      const elapsed = currentTime - progress.lastActivityAt;
      if (elapsed >= this.config.noProgressTimeoutMs) {
        stalled.push({ nodeId, stalledForMs: elapsed });
      }
    }
    return stalled;
  }

  escalate(stalledNodes: Array<{ nodeId: string; stalledForMs: number }>): Array<{ type: string; nodeId: string; action: string }> {
    return stalledNodes.map(s => ({
      type: "watchdog_escalated",
      nodeId: s.nodeId,
      action: s.stalledForMs > this.config.noProgressTimeoutMs * 2 ? "kill" : "retry",
    }));
  }

  getConfig(): WatchdogConfig {
    return { ...this.config };
  }

  removeNode(nodeId: string): void {
    this.progress.delete(nodeId);
  }
}
