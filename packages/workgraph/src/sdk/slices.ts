/**
 * Slice (source document) store — DB-agnostic interface for `sources_current`.
 *
 * Follow the same interface + implementation + factory pattern as IEventStore:
 *   ISliceStore  →  SqliteSliceStore  →  openSqliteSliceStore(db)
 */

import type { Database } from "bun:sqlite";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SliceRow {
  slice_id: string
  goal: string
  kind: string
  title: string
  content: string
  source_path: string | null
  status: string
  plan_run_id: string | null
  last_run_id: string | null
  /** Active run id (plan or exec depending on status). Derived from slice status. */
  trace_run_id: string | null
  /** Execution metadata joined from run_exec_current. */
  runtime_type: string | null
  session_id: string | null
  pty_id: string | null
  directory: string | null
  worktree_path: string | null
  provider: string | null
  repo_ref: string | null
  repo_label: string | null
  provider_connection_id: string | null
  import_mode: string | null
  import_query: any | null
  mission_item_id: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface CreateSliceInput {
  goal: string
  kind: string
  title: string
  content: string
  source_path?: string | null
  status?: string
  provider?: string | null
  provider_connection_id?: string | null
  import_mode?: string | null
  import_query?: string | null
  mission_item_id?: string | null
  repo_ref?: string | null
  repo_label?: string | null
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ISliceStore {
  /** Get a single slice by ID, including exec metadata join. Returns null if not found. */
  get(sliceId: string): SliceRow | null
  /** List all slices. Pass "__unbound__" for slices with no repo, or a repo_ref to filter. */
  list(repoRef?: string | null): SliceRow[]
  /** Insert a new slice row. Returns the created slice. */
  create(sliceId: string, input: CreateSliceInput): SliceRow
  /** Patch specific columns. `updated_at` is set automatically. */
  update(sliceId: string, changes: Record<string, string | null>): void
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

function resolveRunId(row: any): string | null {
  if (row.status === "planning") return row.plan_run_id ?? null
  if (row.status === "planned") return row.last_run_id ?? row.plan_run_id ?? null
  if (row.status === "executing" || row.status === "completed" || row.status === "failed") {
    return row.last_run_id ?? row.plan_run_id ?? null
  }
  return row.plan_run_id ?? row.last_run_id ?? null
}

function parseJson(value: string | null | undefined): any | null {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

function toSliceRow(db: Database, raw: any): SliceRow {
  const traceRunId = resolveRunId(raw)
  const exec = traceRunId
    ? (db.query("SELECT runtime_type, session_id, pty_id, directory FROM run_exec_current WHERE run_id = ?").get(traceRunId) as any)
    : null
  return {
    slice_id: raw.source_id,
    goal: raw.goal,
    kind: raw.kind,
    title: raw.title,
    content: raw.content,
    source_path: raw.source_path ?? null,
    status: raw.status,
    plan_run_id: raw.plan_run_id ?? null,
    last_run_id: raw.last_run_id ?? null,
    trace_run_id: traceRunId,
    runtime_type: exec?.runtime_type ?? null,
    session_id: exec?.session_id ?? null,
    pty_id: exec?.pty_id ?? null,
    directory: exec?.directory ?? null,
    worktree_path: exec?.directory ?? null,
    provider: raw.provider ?? null,
    repo_ref: raw.repo_ref ?? null,
    repo_label: raw.repo_label ?? null,
    provider_connection_id: raw.provider_connection_id ?? null,
    import_mode: raw.import_mode ?? null,
    import_query: parseJson(raw.import_query),
    mission_item_id: raw.mission_item_id ?? null,
    error: raw.error ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  }
}

class SqliteSliceStore implements ISliceStore {
  constructor(private db: Database) {}

  get(sliceId: string): SliceRow | null {
    const raw = this.db.query("SELECT * FROM sources_current WHERE source_id = ?").get(sliceId) as any
    return raw ? toSliceRow(this.db, raw) : null
  }

  list(repoRef?: string | null): SliceRow[] {
    let rows: any[]
    if (repoRef === "__unbound__") {
      rows = this.db.query("SELECT * FROM sources_current WHERE repo_ref IS NULL ORDER BY updated_at DESC").all() as any[]
    } else if (repoRef) {
      rows = this.db.query("SELECT * FROM sources_current WHERE repo_ref = ? ORDER BY updated_at DESC").all(repoRef) as any[]
    } else {
      rows = this.db.query("SELECT * FROM sources_current ORDER BY updated_at DESC").all() as any[]
    }
    return rows.map((row) => toSliceRow(this.db, row))
  }

  create(sliceId: string, input: CreateSliceInput): SliceRow {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO sources_current
        (source_id, goal, kind, title, content, source_path, status, plan_run_id, last_run_id, error,
         provider, provider_connection_id, import_mode, import_query, mission_item_id, repo_ref, repo_label,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sliceId,
        input.goal,
        input.kind,
        input.title,
        input.content,
        input.source_path ?? null,
        input.status ?? "draft",
        null,
        null,
        null,
        input.provider ?? null,
        input.provider_connection_id ?? null,
        input.import_mode ?? null,
        input.import_query ?? null,
        input.mission_item_id ?? null,
        input.repo_ref ?? null,
        input.repo_label ?? null,
        now,
        now,
      ],
    )
    return this.get(sliceId)!
  }

  update(sliceId: string, changes: Record<string, string | null>): void {
    const keys = Object.keys(changes)
    if (!keys.length) return
    this.db.run(
      `UPDATE sources_current SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE source_id = ?`,
      [...keys.map((k) => changes[k]), new Date().toISOString(), sliceId],
    )
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an ISliceStore backed by the given bun:sqlite Database instance. */
export function openSqliteSliceStore(db: Database): ISliceStore {
  return new SqliteSliceStore(db)
}
