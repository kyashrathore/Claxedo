/**
 * FakeDb — minimal in-memory SQLite-shaped stub for executor integration tests.
 *
 * Mocks only the DB boundary (the `db: any` parameter that executor functions
 * receive). All executor logic runs unmodified; only IO is stubbed.
 */

export type DbNode = {
  node_id: string;
  status: string;
  node_type: string;
  role: string;
  kind: string;
  title: string;
  retry_count: number;
};

export class FakeDb {
  readonly nodes = new Map<string, DbNode>();
  readonly edges: Array<{ source_id: string; target_id: string }> = [];
  runStatus = "executing";

  addNode(node_id: string, status: string, opts: Partial<DbNode> = {}): this {
    this.nodes.set(node_id, {
      node_type: "task",
      role: "developer",
      // "research" is a shared kind — no isolated worktree required
      kind: "research",
      title: node_id,
      retry_count: 0,
      ...opts,
      node_id,
      status,
    });
    return this;
  }

  addEdge(source_id: string, target_id: string): this {
    this.edges.push({ source_id, target_id });
    return this;
  }

  nodeStatus(node_id: string): string | undefined {
    return this.nodes.get(node_id)?.status;
  }

  retryCount(node_id: string): number {
    return this.nodes.get(node_id)?.retry_count ?? 0;
  }

  query(sql: string) {
    const self = this;
    return {
      all(...args: any[]): any[] {
        // All nodes for a run (various column projections)
        if (sql.includes("FROM nodes_current WHERE run_id")) {
          return [...self.nodes.values()];
        }
        // All edges for a run
        if (sql.includes("FROM dependency_edges_current") && !sql.includes("AND source_id")) {
          return self.edges;
        }
        // Outgoing edges from a specific source node
        if (sql.includes("FROM dependency_edges_current") && sql.includes("AND source_id")) {
          const sourceId = args[args.length - 1];
          return self.edges
            .filter((e) => e.source_id === sourceId)
            .map((e) => ({ target_id: e.target_id }));
        }
        // Scratchpad entries (for run result assembly and prompt lookup)
        if (sql.includes("scratchpad_entries")) return [];
        // Blockers check
        if (sql.includes("run_blockers_current")) return [];
        return [];
      },

      get(...args: any[]): any {
        // Single node by node_id
        if (sql.includes("FROM nodes_current WHERE node_id")) {
          const nodeId = args[args.length - 1];
          return self.nodes.get(nodeId) ?? null;
        }
        // Any run metadata query
        if (sql.includes("FROM runs_current")) {
          return {
            source_id: null,
            status: self.runStatus,
            created_at: new Date().toISOString(),
            goal: "test goal",
            metrics_json: null,
          };
        }
        // Run sources (planner prompt context)
        if (sql.includes("run_sources_current")) return null;
        // Run exec (directory for task agent)
        if (sql.includes("run_exec_current")) return null;
        // Attempt lookup (attemptFinish)
        if (sql.includes("attempts_current")) return { attempt_id: "att_01" };
        // Event sequence (getNextSeq from db/helpers)
        if (sql.includes("events_current")) return { seq: 0, next_seq: 0, stream_seq: -1 };
        return null;
      },
    };
  }

  run(sql: string, params: any[]): void {
    // Node status update
    if (sql.includes("UPDATE nodes_current SET status = ?")) {
      const [status, nodeId] = params;
      const node = this.nodes.get(nodeId);
      if (node) node.status = status;
      return;
    }
    // Retry count increment
    if (sql.includes("retry_count = retry_count + 1")) {
      const [nodeId] = params;
      const node = this.nodes.get(nodeId);
      if (node) node.retry_count++;
      return;
    }
    // Run status update
    if (sql.includes("UPDATE runs_current SET status")) {
      const [status] = params;
      this.runStatus = status;
      return;
    }
    // All other SQL (events, attempts, exec tracking, trace, metrics) silently succeeds
  }
}

/** Returns a mock spawn function for shared-kind ("research") nodes.
 *  Each invocation returns a unique agent with a session_id (attachable). */
export function makeSpawn(overrides?: Partial<{ id: string; session_id: string }>) {
  let count = 0;
  const calls: Array<{ nodeId: string }> = [];
  const fn = async (_prompt: string, _runId: string, nodeId: string) => {
    count++;
    calls.push({ nodeId });
    return {
      id: overrides?.id ?? `agent_${count}`,
      session_id: overrides?.session_id ?? `sess_${count}`,
      runtime_type: "workspace" as const,
    };
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  Object.defineProperty(fn, "callCount", { get: () => count });
  return fn as typeof fn & { calls: typeof calls; callCount: number };
}

/** Spawn that always throws — simulates a spawn failure. */
export function makeFailingSpawn(message = "spawn error") {
  return async () => {
    throw new Error(message);
  };
}

/** A unique run ID per test to avoid collision with module-level orchestrations Map. */
let seq = 0;
export function nextRunId(): string {
  return `test_run_${Date.now()}_${++seq}`;
}
