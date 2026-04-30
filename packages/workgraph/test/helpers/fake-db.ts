/**
 * FakeDb — real in-memory SQLite wrapper for executor integration tests.
 *
 * Uses a real in-memory SQLite Database with the real IExecutionStore
 * implementation so executor logic runs against actual SQL queries.
 *
 * Test-level overrides:
 *   db.metricsJson    — if non-null, overrides getRunMetrics() return value
 *   db.openAttemptId  — if non-null, overrides findOpenAttemptId() return value
 *   db.customRunNodes — if set, overrides queryRunNodes() return value
 */

import Database from "better-sqlite3";
import { initializeDb } from "../../src/db/schema";
import { openSqliteEventStore } from "../../src/orchestrator/core/services/event-store-sqlite";
import { openSqliteExecutionStore } from "../../src/sdk/execution-store";
import type {
  IExecutionStore,
  RunSnapshot,
  NodeSnapshot,
  EdgeSnapshot,
  PlannerSourceRow,
  AttemptInput,
  RunExecMeta,
  RunNodeRow,
  RunMetrics,
} from "../../src/sdk/execution-store";
import type { OrchestratorRunState } from "../../src/orchestrator/types";
import type { TraceEventInput } from "../../src/orchestrator/trace/trace-store";

export type DbNode = {
  node_id: string;
  status: string;
  node_type: string;
  role: string;
  kind: string;
  title: string;
  retry_count: number;
};

export class FakeDb implements IExecutionStore {
  readonly runId: string;

  // Test-level override props
  metricsJson: string | null = null;
  openAttemptId: string | null = null;
  customRunNodes: any[] | null = null;

  private readonly _sqlite: Database;
  private readonly _store: IExecutionStore;

  /** Exposes the underlying SQLite instance for helpers that need raw db.run() / db.query(). */
  get sqlite(): Database { return this._sqlite; }

  constructor(runId = "run_x") {
    this.runId = runId;
    this._sqlite = new Database(":memory:");
    initializeDb(this._sqlite);
    const eventStore = openSqliteEventStore(this._sqlite);
    this._store = openSqliteExecutionStore(this._sqlite, eventStore);

    // Pre-insert a run row so getRun() and getRunGoal() work
    this._sqlite.run(
      `INSERT OR IGNORE INTO runs_current (run_id, goal, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [runId, "test goal", "pending", new Date().toISOString(), new Date().toISOString()],
    );
  }

  // -------------------------------------------------------------------------
  // Test convenience helpers
  // -------------------------------------------------------------------------

  addNode(nodeId: string, status: string, opts: Partial<DbNode> = {}): this {
    const node: DbNode = {
      node_type: "task",
      role: "developer",
      kind: "research",
      title: nodeId,
      retry_count: 0,
      ...opts,
      node_id: nodeId,
      status,
    };
    this._sqlite.run(
      `INSERT OR IGNORE INTO nodes_current
         (node_id, run_id, role, kind, title, node_type, status, retry_count, runtime_type, runtime_type_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.node_id,
        this.runId,
        node.role,
        node.kind,
        node.title,
        node.node_type,
        node.status,
        node.retry_count,
        "task",
        null,
      ],
    );
    return this;
  }

  addEdge(source: string, target: string): this {
    this._sqlite.run(
      `INSERT OR IGNORE INTO dependency_edges_current (id, run_id, source_id, target_id, type)
       VALUES (?, ?, ?, ?, ?)`,
      [`edge_${source}_${target}`, this.runId, source, target, "hard"],
    );
    return this;
  }

  nodeStatus(nodeId: string): string | undefined {
    const row = this._sqlite
      .query("SELECT status FROM nodes_current WHERE node_id = ?")
      .get(nodeId) as { status: string } | null;
    return row?.status;
  }

  retryCount(nodeId: string): number {
    const row = this._sqlite
      .query("SELECT retry_count FROM nodes_current WHERE node_id = ?")
      .get(nodeId) as { retry_count: number } | null;
    return row?.retry_count ?? 0;
  }

  setNodeStatus(nodeId: string, status: string): void {
    this._sqlite.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [status, nodeId]);
  }

  setNodeRetryCount(nodeId: string, count: number): void {
    this._sqlite.run("UPDATE nodes_current SET retry_count = ? WHERE node_id = ?", [count, nodeId]);
  }

  getNodeRole(nodeId: string): string | undefined {
    const row = this._sqlite
      .query("SELECT role FROM nodes_current WHERE node_id = ?")
      .get(nodeId) as { role: string } | null;
    return row?.role;
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Run state
  // -------------------------------------------------------------------------

  getRun(runId: string): RunSnapshot | null {
    return this._store.getRun(runId);
  }

  updateRunStatus(runId: string, status: string): void {
    this._store.updateRunStatus(runId, status);
  }

  upsertRunExec(runId: string, meta: RunExecMeta): void {
    this._store.upsertRunExec(runId, meta);
  }

  getRunDirectory(runId: string): string | null {
    return this._store.getRunDirectory(runId);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Source
  // -------------------------------------------------------------------------

  getRunSourceId(runId: string): string | null {
    return this._store.getRunSourceId(runId);
  }

  getRunSource(runId: string): PlannerSourceRow | null {
    return this._store.getRunSource(runId);
  }

  updateSource(
    sourceId: string | null,
    status: string,
    extra?: { error?: string | null; planRunId?: string | null; lastRunId?: string | null },
  ): void {
    this._store.updateSource(sourceId, status, extra);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Nodes
  // -------------------------------------------------------------------------

  getNode(nodeId: string): NodeSnapshot | null {
    return this._store.getNode(nodeId);
  }

  getNodesForRun(runId: string): NodeSnapshot[] {
    return this._store.getNodesForRun(runId);
  }

  getEdgesForRun(runId: string): EdgeSnapshot[] {
    return this._store.getEdgesForRun(runId);
  }

  updateNodeStatus(runId: string, nodeId: string, status: string): void {
    this._store.updateNodeStatus(runId, nodeId, status);
  }

  incrementNodeRetry(nodeId: string): void {
    this._store.incrementNodeRetry(nodeId);
  }

  getDependentsOf(runId: string, nodeId: string): Array<{ target_id: string; status: string }> {
    return this._store.getDependentsOf(runId, nodeId);
  }

  getScratchpad(runId: string, nodeId: string): string | null {
    return this._store.getScratchpad(runId, nodeId);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Attempts
  // -------------------------------------------------------------------------

  createAttempt(input: AttemptInput): void {
    this._store.createAttempt(input);
  }

  finishAttempt(runId: string, nodeId: string, status: string): void {
    this._store.finishAttempt(runId, nodeId, status);
  }

  findOpenAttemptId(runId: string, nodeId: string, sessionId: string): string | null {
    // If a test has set openAttemptId override, return that
    if (this.openAttemptId !== null) return this.openAttemptId;
    return this._store.findOpenAttemptId(runId, nodeId, sessionId);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Blockers
  // -------------------------------------------------------------------------

  hasBlockers(runId: string): boolean {
    return this._store.hasBlockers(runId);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Metrics
  // -------------------------------------------------------------------------

  finalizeMetrics(runId: string, state: OrchestratorRunState): RunMetrics {
    return this._store.finalizeMetrics(runId, state);
  }

  getRunMetrics(runId: string): RunMetrics | null {
    // If test has set metricsJson override, use that
    if (this.metricsJson !== null) {
      try { return JSON.parse(this.metricsJson) as RunMetrics; } catch { return null; }
    }
    return this._store.getRunMetrics(runId);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Metadata query
  // -------------------------------------------------------------------------

  queryRunNodes(runId: string): RunNodeRow[] {
    if (this.customRunNodes) return this.customRunNodes;
    return this._store.queryRunNodes(runId);
  }

  getRunGoal(runId: string): string {
    return this._store.getRunGoal(runId);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Event emission
  // -------------------------------------------------------------------------

  emitRunEvent(runId: string, type: string, payload: Record<string, unknown>): void {
    this._store.emitRunEvent(runId, type, payload);
  }

  emitNodeEvent(runId: string, nodeId: string, status: string): void {
    this._store.emitNodeEvent(runId, nodeId, status);
  }

  // -------------------------------------------------------------------------
  // IExecutionStore — Trace
  // -------------------------------------------------------------------------

  traceEvent(input: TraceEventInput): void {
    this._store.traceEvent(input);
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
