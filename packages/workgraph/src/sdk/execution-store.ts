/**
 * Execution store — DB-agnostic interface for all DB operations performed
 * during orchestration (run state, nodes, attempts, metrics, events).
 *
 * Follows the same interface + implementation + factory pattern as IEventStore.
 * executor.ts receives an IExecutionStore instead of a raw db handle.
 */

import { ulid } from "ulid";
import { createTraceEvent, appendTraceEvent } from "../substrate/trace";
import type { IEventStore } from "../substrate/event-store";

import type { RunMetrics, RunParallelism, RunPhase } from "./attempts";
import { sqlite, type SqliteDb, type SqliteInput } from "../sqlite";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface RunSnapshot {
  status: RunPhase;
  created_at: string | null;
}

export interface NodeSnapshot {
  node_id: string;
  status: string;
  node_type: string;
  role: string;
  kind: string;
  title: string;
  retry_count: number;
}

export interface EdgeSnapshot {
  source_id: string;
  target_id: string;
}

export interface PlannerSourceRow {
  kind: string;
  title: string;
  content: string;
  source_path: string | null;
}

export interface AttemptInput {
  runId: string;
  nodeId: string;
  status: string;
  runtimeType: string;
  directory?: string | null;
  worktreePath?: string | null;
  sessionId?: string | null;
  ptyId?: string | null;
}

export interface RunExecMeta {
  runtimeType?: string | null;
  sessionId?: string | null;
  ptyId?: string | null;
  directory?: string | null;
}

export interface RunNodeRow {
  node_id: string;
  role: string;
  kind: string;
  title: string;
  status: string;
  session_id: string | null;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IExecutionStore {
  // --- Run state ---
  getRun(runId: string): RunSnapshot | null;
  updateRunStatus(runId: string, status: string): void;
  upsertRunExec(runId: string, meta: RunExecMeta): void;
  getRunDirectory(runId: string): string | null;

  // --- Source ---
  getRunSourceId(runId: string): string | null;
  getRunSource(runId: string): PlannerSourceRow | null;
  updateSource(
    sourceId: string | null,
    status: string,
    extra?: { error?: string | null; planRunId?: string | null; lastRunId?: string | null },
  ): void;

  // --- Nodes ---
  getNode(nodeId: string): NodeSnapshot | null;
  getNodesForRun(runId: string): NodeSnapshot[];
  getEdgesForRun(runId: string): EdgeSnapshot[];
  updateNodeStatus(runId: string, nodeId: string, status: string): void;
  incrementNodeRetry(nodeId: string): void;
  getDependentsOf(runId: string, nodeId: string): Array<{ target_id: string; status: string }>;
  getScratchpad(runId: string, nodeId: string): string | null;

  // --- Attempts ---
  createAttempt(input: AttemptInput): void;
  finishAttempt(runId: string, nodeId: string, status: string): void;
  findOpenAttemptId(runId: string, nodeId: string, sessionId: string): string | null;

  // --- Blockers ---
  hasBlockers(runId: string): boolean;
  /** Blocker rows recorded for the run (blocking work item → blocked node). */
  listBlockers?(runId: string): Array<{ work_item_id: string; target_node_id: string }>;
  /** Remove one blocker row (e.g. after the blocking work item completed). */
  removeBlocker?(runId: string, workItemId: string, targetNodeId: string): void;

  // --- Metrics ---
  finalizeMetrics(runId: string, state: { parallelism?: RunParallelism | null }): RunMetrics;
  /** Work item linked to a node at snapshot time (run_node_items_current). */
  getWorkItemForNode?(runId: string, nodeId: string): string | null;
  /** True while the node has an attempt that has not finished. */
  hasOpenAttempt?(runId: string, nodeId: string): boolean;
  getRunMetrics(runId: string): RunMetrics | null;

  // --- Metadata query (for status views) ---
  queryRunNodes(runId: string): RunNodeRow[];
  getRunGoal(runId: string): string;

  // --- Event emission ---
  /** Emit a run-level event. Fire-and-forget via IEventStore (best-effort). */
  emitRunEvent(runId: string, type: string, payload: Record<string, unknown>): void;
  /** Emit a node status change event. Fire-and-forget via IEventStore (best-effort). */
  emitNodeEvent(runId: string, nodeId: string, status: string): void;

  // --- Trace ---
  traceEvent(input: Parameters<typeof createTraceEvent>[0]): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

class SqliteExecutionStore implements IExecutionStore {
  constructor(
    private db: SqliteDb,
    private eventStore: IEventStore,
  ) {}

  // --- Run state ---

  getRun(runId: string): RunSnapshot | null {
    return this.db
      .query("SELECT status, created_at FROM runs_current WHERE run_id = ?")
      .get(runId) as RunSnapshot | null;
  }

  updateRunStatus(runId: string, status: string): void {
    this.db.run(
      "UPDATE runs_current SET status = ?, updated_at = ? WHERE run_id = ?",
      [status, new Date().toISOString(), runId],
    );
  }

  upsertRunExec(runId: string, meta: RunExecMeta): void {
    this.db.run(
      `INSERT INTO run_exec_current (run_id, runtime_type, session_id, pty_id, directory, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         runtime_type = COALESCE(excluded.runtime_type, run_exec_current.runtime_type),
         session_id = excluded.session_id,
         pty_id = excluded.pty_id,
         directory = COALESCE(excluded.directory, run_exec_current.directory),
         updated_at = excluded.updated_at`,
      [
        runId,
        meta.runtimeType ?? "workspace",
        meta.sessionId ?? null,
        meta.ptyId ?? null,
        meta.directory ?? null,
        new Date().toISOString(),
      ],
    );
  }

  getRunDirectory(runId: string): string | null {
    return (
      (this.db.query("SELECT directory FROM run_exec_current WHERE run_id = ?").get(runId) as { directory: string | null } | null)
        ?.directory ?? null
    );
  }

  // --- Source ---

  getRunSourceId(runId: string): string | null {
    return (
      (this.db.query("SELECT source_id FROM runs_current WHERE run_id = ?").get(runId) as { source_id: string | null } | null)
        ?.source_id ?? null
    );
  }

  getRunSource(runId: string): PlannerSourceRow | null {
    return (
      this.db
        .query("SELECT kind, title, content, source_path FROM run_sources_current WHERE run_id = ?")
        .get(runId) as PlannerSourceRow | null
    );
  }

  updateSource(
    sourceId: string | null,
    status: string,
    extra?: { error?: string | null; planRunId?: string | null; lastRunId?: string | null },
  ): void {
    if (!sourceId) return;
    const sets = ["status = ?", "updated_at = ?"];
    const vals: Array<string | null> = [status, new Date().toISOString()];
    if (extra && "error" in extra) { sets.push("error = ?"); vals.push(extra.error ?? null); }
    if (extra && "planRunId" in extra) { sets.push("plan_run_id = ?"); vals.push(extra.planRunId ?? null); }
    if (extra && "lastRunId" in extra) { sets.push("last_run_id = ?"); vals.push(extra.lastRunId ?? null); }
    vals.push(sourceId);
    this.db.run(`UPDATE sources_current SET ${sets.join(", ")} WHERE source_id = ?`, vals);
  }

  // --- Nodes ---

  getNode(nodeId: string): NodeSnapshot | null {
    return (
      this.db
        .query("SELECT node_id, role, kind, title, node_type, status, retry_count FROM nodes_current WHERE node_id = ?")
        .get(nodeId) as NodeSnapshot | null
    );
  }

  getNodesForRun(runId: string): NodeSnapshot[] {
    return this.db
      .query("SELECT node_id, status, node_type, role, kind, title, retry_count FROM nodes_current WHERE run_id = ?")
      .all(runId) as NodeSnapshot[];
  }

  getEdgesForRun(runId: string): EdgeSnapshot[] {
    return this.db
      .query("SELECT source_id, target_id FROM dependency_edges_current WHERE run_id = ?")
      .all(runId) as EdgeSnapshot[];
  }

  updateNodeStatus(runId: string, nodeId: string, status: string): void {
    this.db.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [status, nodeId]);
    this.emitNodeEvent(runId, nodeId, status);
  }

  incrementNodeRetry(nodeId: string): void {
    this.db.run("UPDATE nodes_current SET retry_count = retry_count + 1 WHERE node_id = ?", [nodeId]);
  }

  getDependentsOf(runId: string, nodeId: string): Array<{ target_id: string; status: string }> {
    const edges = this.db
      .query("SELECT target_id FROM dependency_edges_current WHERE run_id = ? AND source_id = ?")
      .all(runId, nodeId) as Array<{ target_id: string }>;
    return edges.map((edge) => {
      const node = this.db
        .query("SELECT status FROM nodes_current WHERE node_id = ?")
        .get(edge.target_id) as { status: string } | null;
      return { target_id: edge.target_id, status: node?.status ?? "unknown" };
    });
  }

  getScratchpad(runId: string, nodeId: string): string | null {
    return (
      (
        this.db
          .query("SELECT content FROM scratchpad_entries WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC LIMIT 1")
          .get(runId, nodeId) as { content: string } | null
      )?.content ?? null
    );
  }

  // --- Attempts ---

  createAttempt(input: AttemptInput): void {
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, directory, worktree_path, session_id, pty_id, started_at, finished_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        `att_${ulid()}`,
        input.runId, input.nodeId, input.status, input.runtimeType,
        input.directory ?? null, input.worktreePath ?? null,
        input.sessionId ?? null, input.ptyId ?? null,
        now, null, now,
      ],
    );
  }

  finishAttempt(runId: string, nodeId: string, status: string): void {
    const row = this.db
      .query("SELECT attempt_id FROM attempts_current WHERE run_id = ? AND node_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get(runId, nodeId) as { attempt_id: string } | null;
    if (!row) return;
    const now = new Date().toISOString();
    this.db.run(
      "UPDATE attempts_current SET status = ?, finished_at = ?, last_heartbeat_at = ? WHERE attempt_id = ?",
      [status, now, now, row.attempt_id],
    );
  }

  findOpenAttemptId(runId: string, nodeId: string, sessionId: string): string | null {
    return (
      (
        this.db
          .query("SELECT attempt_id FROM attempts_current WHERE run_id = ? AND node_id = ? AND session_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1")
          .get(runId, nodeId, sessionId) as { attempt_id: string } | null
      )?.attempt_id ?? null
    );
  }

  // --- Blockers ---

  hasBlockers(runId: string): boolean {
    return !!this.db
      .query(
        `SELECT 1 FROM run_blockers_current b
         INNER JOIN nodes_current n ON n.run_id = b.run_id AND n.node_id = b.target_node_id
         WHERE b.run_id = ? AND n.status IN ('pending', 'blocked') LIMIT 1`,
      )
      .get(runId);
  }

  listBlockers(runId: string): Array<{ work_item_id: string; target_node_id: string }> {
    return this.db
      .query("SELECT work_item_id, target_node_id FROM run_blockers_current WHERE run_id = ?")
      .all(runId) as Array<{ work_item_id: string; target_node_id: string }>;
  }

  removeBlocker(runId: string, workItemId: string, targetNodeId: string): void {
    this.db.run(
      "DELETE FROM run_blockers_current WHERE run_id = ? AND work_item_id = ? AND target_node_id = ?",
      [runId, workItemId, targetNodeId],
    );
  }

  // --- Metrics ---

  getWorkItemForNode(runId: string, nodeId: string): string | null {
    const row = this.db
      .query("SELECT work_item_id FROM run_node_items_current WHERE run_id = ? AND node_id = ?")
      .get(runId, nodeId) as { work_item_id: string } | null;
    return row?.work_item_id ?? null;
  }

  hasOpenAttempt(runId: string, nodeId: string): boolean {
    return !!this.db
      .query("SELECT 1 ok FROM attempts_current WHERE run_id = ? AND node_id = ? AND finished_at IS NULL LIMIT 1")
      .get(runId, nodeId);
  }

  finalizeMetrics(runId: string, state: { parallelism?: RunParallelism | null }): RunMetrics {
    const allNodes = this.db
      .query("SELECT status FROM nodes_current WHERE run_id = ?")
      .all(runId) as Array<{ status: string }>;

    const completed_count = allNodes.filter((n) => n.status === "completed").length;
    const failed_count = allNodes.filter((n) => n.status === "failed").length;

    const p = state.parallelism;
    let wall_time_ms = 0;
    let avg_parallelism = 0;
    let max_parallelism = 0;
    if (p) {
      const now = Date.now();
      const elapsed = now - p.last_sample_ms;
      const integral = p.integral + p.current * elapsed;
      wall_time_ms = now - p.start_ms;
      avg_parallelism = wall_time_ms > 0 ? integral / wall_time_ms : 0;
      max_parallelism = p.max;
    }

    const metrics: RunMetrics = {
      wall_time_ms,
      task_count: allNodes.length,
      completed_count,
      failed_count,
      max_parallelism,
      avg_parallelism,
      total_tokens_used: null,
      estimated_cost_usd: null,
    };

    this.db.run("UPDATE runs_current SET metrics_json = ? WHERE run_id = ?", [
      JSON.stringify(metrics),
      runId,
    ]);

    return metrics;
  }

  getRunMetrics(runId: string): RunMetrics | null {
    const row = this.db
      .query("SELECT metrics_json FROM runs_current WHERE run_id = ?")
      .get(runId) as { metrics_json: string | null } | null;
    if (!row?.metrics_json) return null;
    try { return JSON.parse(row.metrics_json) as RunMetrics; } catch { return null; }
  }

  // --- Metadata query ---

  queryRunNodes(runId: string): RunNodeRow[] {
    return (
      this.db
        .query(
          `SELECT n.node_id, n.role, n.kind, n.title, n.status,
                  (SELECT a.session_id FROM attempts_current a
                   WHERE a.run_id = n.run_id AND a.node_id = n.node_id
                   ORDER BY a.started_at DESC LIMIT 1) AS session_id
           FROM nodes_current n WHERE n.run_id = ?`,
        )
        .all(runId) as RunNodeRow[]
    );
  }

  getRunGoal(runId: string): string {
    return (
      (this.db.query("SELECT goal FROM runs_current WHERE run_id = ?").get(runId) as { goal: string } | null)?.goal ?? ""
    );
  }

  // --- Event emission ---

  emitRunEvent(runId: string, type: string, payload: Record<string, unknown>): void {
    const eventId = `evt_${ulid()}`;
    this.eventStore
      .append({
        id: eventId,
        run_id: runId,
        stream_id: runId,
        schema_version: 1,
        type,
        payload_json: JSON.stringify(payload),
        actor_type: "system",
        actor_id: "orchestrator",
        op_id: `op_${eventId}`,
        created_at: new Date().toISOString(),
      })
      .catch((e) => console.error(`[execution-store] failed to emit ${type} for ${runId}:`, e));
  }

  emitNodeEvent(runId: string, nodeId: string, status: string): void {
    const eventId = `evt_${ulid()}`;
    this.eventStore
      .append({
        id: eventId,
        run_id: runId,
        stream_id: runId,
        schema_version: 1,
        type: "node_status_changed",
        payload_json: JSON.stringify({ node_id: nodeId, status }),
        actor_type: "system",
        actor_id: "orchestrator",
        op_id: `op_${eventId}`,
        created_at: new Date().toISOString(),
      })
      .catch((e) => console.error(`[execution-store] failed to emit node event for ${nodeId}:`, e));
  }

  // --- Trace ---

  traceEvent(input: Parameters<typeof createTraceEvent>[0]): void {
    try {
      appendTraceEvent(this.db, createTraceEvent(input));
    } catch {
      // trace is best-effort; never crash the executor
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an IExecutionStore backed by the given SQLite database and event store. */
export function openSqliteExecutionStore(db: SqliteInput, eventStore: IEventStore): IExecutionStore {
  return new SqliteExecutionStore(sqlite(db), eventStore);
}
