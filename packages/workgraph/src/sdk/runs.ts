/**
 * Run store — DB-agnostic interface for run/node/edge CRUD.
 *
 * Follows the same interface + implementation + factory pattern as IEventStore:
 *   IRunStore  →  SqliteRunStore  →  openSqliteRunStore(db)
 */

import type { RunSourceInput } from "../model/types";
import { sqlite, type SqliteDb, type SqliteInput } from "../sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunRow {
  run_id: string;
  goal: string;
  status: string;
  source_kind: string | null;
  source_title: string | null;
  source_size: number | null;
  runtime_type: string | null;
  session_id: string | null;
  pty_id: string | null;
  directory: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface NodeRow {
  node_id: string;
  run_id: string;
  role: string;
  kind: string;
  title: string;
  status: string;
  retry_count: number;
}

export interface EdgeRow {
  id: string;
  run_id: string;
  source_id: string;
  target_id: string;
  type: string;
}

/** Paginated result returned by `listRuns({ limit, cursor? })`. */
export interface RunPage {
  items: RunRow[];
  /** rowid of last item; null means this is the last page. */
  next_cursor: number | null;
}

/** A node returned by a graph traversal query. */
export interface TraversalNode {
  node_id: string;
  depth: number;
  status: string;
  title: string;
}

/** Result of a graph traversal. */
export interface TraversalResult {
  nodes: TraversalNode[];
  /** node_ids at maxDepth that have unloaded children; empty when maxDepth was not hit. */
  frontier: string[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IRunStore {
  /** Insert a new run. Returns the created row. */
  createRun(runId: string, goal: string): RunRow;
  /**
   * Insert a new run with optional source attachment and sourceId FK.
   * Equivalent to the old createRunInDb helper.
   */
  createRunWithMeta(
    runId: string,
    goal: string,
    status: string,
    source?: RunSourceInput,
    sourceId?: string,
  ): RunRow;
  /** Insert a run spawned by a recurring trigger (includes trigger FK columns). */
  createTriggerRun(
    runId: string,
    goal: string,
    runtimeType: string,
    triggerId: string,
    triggerRunIndex: number,
  ): void;
  /** Attach (or replace) a source document for a run. */
  attachRunSource(runId: string, source: RunSourceInput): void;
  /** Get a single run by ID. Returns null if not found. */
  getRun(runId: string): RunRow | null;
  /** List all runs with joined source and exec metadata, newest first. */
  listRuns(): RunRow[];
  /** List runs with cursor-based pagination. */
  listRuns(opts: { limit: number; cursor?: number }): RunPage;
  /** Get the source document attached to a run. */
  getRunSource(runId: string): Record<string, unknown> | null;
  /** Insert a new node. Returns the created row. */
  createNode(runId: string, nodeId: string, role: string, kind: string, title: string): NodeRow;
  /** List nodes for a run. */
  listNodes(runId: string): NodeRow[];
  /** Update a node's status. Returns the updated row or null if not found. */
  updateNodeStatus(runId: string, nodeId: string, status: string): NodeRow | null;
  /** Insert a new dependency edge. Returns the created row. */
  createEdge(runId: string, edgeId: string, sourceId: string, targetId: string, type: string): EdgeRow;
  /** List dependency edges for a run. */
  listEdges(runId: string): EdgeRow[];
  /** Return node_ids whose dependencies are all completed. */
  getReadyNodes(runId: string): string[];
  /** Return all descendants of a node up to maxDepth (including completed). */
  getDescendants(nodeId: string, maxDepth?: number): TraversalResult;
  /** Return active (non-terminal) descendants, pruning completed subtrees. */
  getActiveDescendants(nodeId: string, maxDepth?: number): TraversalResult;
  /** Return ancestors of a node up to maxDepth (walk edges in reverse). */
  getAncestors(nodeId: string, maxDepth?: number): TraversalResult;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

class SqliteRunStore implements IRunStore {
  constructor(private db: SqliteDb) {}

  createRun(runId: string, goal: string): RunRow {
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [runId, goal, "active", now, now],
    );
    return this.getRun(runId)!;
  }

  createRunWithMeta(
    runId: string,
    goal: string,
    status: string,
    source?: RunSourceInput,
    sourceId?: string,
  ): RunRow {
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO runs_current (run_id, goal, status, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, goal, status, sourceId ?? null, now, now],
    );
    if (source) this.attachRunSource(runId, source);
    return this.getRun(runId)!;
  }

  createTriggerRun(
    runId: string,
    goal: string,
    runtimeType: string,
    triggerId: string,
    triggerRunIndex: number,
  ): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO runs_current (run_id, goal, status, runtime_type, trigger_id, trigger_run_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, goal, "active", runtimeType, triggerId, triggerRunIndex, now, now],
    );
  }

  attachRunSource(runId: string, source: RunSourceInput): void {
    const now = new Date().toISOString();
    this.db.run(
      "INSERT OR REPLACE INTO run_sources_current (run_id, kind, title, content, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, source.kind, source.title, source.content, source.source_path ?? null, now],
    );
  }

  getRun(runId: string): RunRow | null {
    const row = this.db.query("SELECT * FROM runs_current WHERE run_id = ?").get(runId) as any;
    if (!row) return null;
    return {
      run_id: row.run_id,
      goal: row.goal,
      status: row.status,
      source_kind: null,
      source_title: null,
      source_size: null,
      runtime_type: null,
      session_id: null,
      pty_id: null,
      directory: null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    };
  }

  listRuns(): RunRow[];
  listRuns(opts: { limit: number; cursor?: number }): RunPage;
  listRuns(opts?: { limit?: number; cursor?: number }): RunRow[] | RunPage {
    const limit  = opts?.limit  ?? null;
    const cursor = opts?.cursor ?? null;

    const whereClause = cursor ? "WHERE r.rowid < ?" : "";
    const limitClause = limit  ? `LIMIT ${limit + 1}` : "";
    const params: any[] = cursor ? [cursor] : [];

    const rows = (this.db.query(
      `SELECT r.run_id, r.goal, r.status, r.created_at, r.updated_at,
              s.kind AS source_kind, s.title AS source_title, LENGTH(s.content) AS source_size,
              x.runtime_type, x.session_id, x.pty_id, x.directory
       FROM runs_current r
       LEFT JOIN run_sources_current s ON s.run_id = r.run_id
       LEFT JOIN run_exec_current    x ON x.run_id = r.run_id
       ${whereClause}
       ORDER BY r.rowid DESC
       ${limitClause}`,
    ).all(...params) as any[]).map((row) => ({
      run_id: row.run_id,
      goal: row.goal,
      status: row.status,
      source_kind: row.source_kind ?? null,
      source_title: row.source_title ?? null,
      source_size: row.source_size ?? null,
      runtime_type: row.runtime_type ?? null,
      session_id: row.session_id ?? null,
      pty_id: row.pty_id ?? null,
      directory: row.directory ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    }));

    if (!limit) return rows;   // backward-compat: no opts → return plain array

    const hasMore = rows.length > limit;
    const items   = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1)
    const lastRowid = items.length > 0
      ? (this.db.query("SELECT rowid FROM runs_current WHERE run_id = ?")
           .get(last?.run_id) as any)?.rowid ?? null
      : null;

    return { items, next_cursor: hasMore ? lastRowid : null };
  }

  getRunSource(runId: string): Record<string, unknown> | null {
    return this.db.query("SELECT * FROM run_sources_current WHERE run_id = ?").get(runId) as any ?? null;
  }

  createNode(runId: string, nodeId: string, role: string, kind: string, title: string): NodeRow {
    this.db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [nodeId, runId, role, kind, title, "pending", 0],
    );
    return { node_id: nodeId, run_id: runId, role, kind, title, status: "pending", retry_count: 0 };
  }

  listNodes(runId: string): NodeRow[] {
    return this.db.query("SELECT * FROM nodes_current WHERE run_id = ?").all(runId) as NodeRow[];
  }

  updateNodeStatus(runId: string, nodeId: string, status: string): NodeRow | null {
    const existing = this.db.query("SELECT * FROM nodes_current WHERE node_id = ? AND run_id = ?").get(nodeId, runId) as any;
    if (!existing) return null;
    this.db.run("UPDATE nodes_current SET status = ? WHERE node_id = ?", [status, nodeId]);
    return { ...existing, status };
  }

  createEdge(runId: string, edgeId: string, sourceId: string, targetId: string, type: string): EdgeRow {
    this.db.run(
      "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      [edgeId, runId, sourceId, targetId, type],
    );
    return { id: edgeId, run_id: runId, source_id: sourceId, target_id: targetId, type };
  }

  listEdges(runId: string): EdgeRow[] {
    return this.db.query("SELECT * FROM dependency_edges_current WHERE run_id = ?").all(runId) as EdgeRow[];
  }

  getReadyNodes(runId: string): string[] {
    const rows = this.db.query(
      `SELECT n.node_id
       FROM nodes_current n
       WHERE n.run_id = ?
         AND n.status = 'pending'
         AND NOT EXISTS (
           SELECT 1
           FROM dependency_edges_current e
           JOIN nodes_current dep ON dep.node_id = e.source_id
           WHERE e.target_id = n.node_id
             AND dep.status != 'completed'
         )`,
    ).all(runId) as Array<{ node_id: string }>;
    return rows.map((r) => r.node_id);
  }

  getDescendants(nodeId: string, maxDepth = 5): TraversalResult {
    const rows = this.db.query(
      `WITH RECURSIVE descendants(node_id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT e.target_id, d.depth + 1
         FROM dependency_edges_current e
         JOIN descendants d ON e.source_id = d.node_id
         WHERE d.depth < ?
       )
       SELECT n.node_id, d.depth, n.status, n.title,
              EXISTS (
                SELECT 1 FROM dependency_edges_current e2
                WHERE e2.source_id = n.node_id
              ) AS has_children
       FROM descendants d
       JOIN nodes_current n ON n.node_id = d.node_id
       WHERE d.depth > 0
       ORDER BY d.depth, n.rowid`,
    ).all(nodeId, maxDepth) as Array<TraversalNode & { has_children: number }>;

    const nodes = rows.map(({ has_children: _hc, ...n }) => n);
    const frontier = rows
      .filter((r) => r.depth === maxDepth && r.has_children)
      .map((r) => r.node_id);

    return { nodes, frontier };
  }

  getActiveDescendants(nodeId: string, maxDepth = 5): TraversalResult {
    const rows = this.db.query(
      `WITH RECURSIVE descendants(node_id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT e.target_id, d.depth + 1
         FROM dependency_edges_current e
         JOIN descendants d ON e.source_id = d.node_id
         JOIN nodes_current nc ON nc.node_id = e.target_id
           AND nc.status NOT IN ('completed', 'cancelled', 'failed')
         WHERE d.depth < ?
       )
       SELECT n.node_id, d.depth, n.status, n.title,
              EXISTS (
                SELECT 1 FROM dependency_edges_current e2
                WHERE e2.source_id = n.node_id
              ) AS has_children
       FROM descendants d
       JOIN nodes_current n ON n.node_id = d.node_id
       WHERE d.depth > 0
       ORDER BY d.depth, n.rowid`,
    ).all(nodeId, maxDepth) as Array<TraversalNode & { has_children: number }>;

    const nodes = rows.map(({ has_children: _hc, ...n }) => n);
    const frontier = rows
      .filter((r) => r.depth === maxDepth && r.has_children)
      .map((r) => r.node_id);

    return { nodes, frontier };
  }

  getAncestors(nodeId: string, maxDepth = 5): TraversalResult {
    const rows = this.db.query(
      `WITH RECURSIVE ancestors(node_id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT e.source_id, a.depth + 1
         FROM dependency_edges_current e
         JOIN ancestors a ON e.target_id = a.node_id
         WHERE a.depth < ?
       )
       SELECT n.node_id, a.depth, n.status, n.title
       FROM ancestors a
       JOIN nodes_current n ON n.node_id = a.node_id
       WHERE a.depth > 0
       ORDER BY a.depth, n.rowid`,
    ).all(nodeId, maxDepth) as Array<TraversalNode>;

    return { nodes: rows, frontier: [] };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an IRunStore backed by the given SQLite database. */
export function openSqliteRunStore(db: SqliteInput): IRunStore {
  return new SqliteRunStore(sqlite(db));
}
