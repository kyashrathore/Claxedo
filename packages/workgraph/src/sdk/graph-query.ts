/**
 * Graph query helpers — cross-table read/write functions for the work graph.
 *
 * These functions encapsulate the multi-table SQL joins and mutations that
 * support item views, execution planning, and execution state tracking.
 * Route handlers call these instead of writing raw SQL inline.
 */

import { ulid } from "ulid"
import type { WorkItem } from "../model/types"
import { getWorkGraph } from "../orchestrator/workgraph-bridge"
import type { ISliceStore } from "./slices"
import type { SqliteDb } from "../sqlite"

// ---------------------------------------------------------------------------
// Attempt helpers
// ---------------------------------------------------------------------------

export interface AttemptRow {
  attempt_id: string
  run_id: string
  node_id: string
  status: string
  runtime_type: string
  directory: string | null
  worktree_path: string | null
  session_id: string | null
  pty_id: string | null
  started_at: string
  finished_at: string | null
  last_heartbeat_at: string
}

function toAttemptRow(raw: any): AttemptRow {
  return {
    attempt_id: raw.attempt_id,
    run_id: raw.run_id,
    node_id: raw.node_id,
    status: raw.status,
    runtime_type: raw.runtime_type,
    directory: raw.directory ?? null,
    worktree_path: raw.worktree_path ?? null,
    session_id: raw.session_id ?? null,
    pty_id: raw.pty_id ?? null,
    started_at: raw.started_at,
    finished_at: raw.finished_at ?? null,
    last_heartbeat_at: raw.last_heartbeat_at,
  }
}

/** Latest attempt for a work item (prefers active/running). */
export function attemptForItem(db: SqliteDb, itemId: string): AttemptRow | null {
  const raw = db.query(
    `SELECT a.*
     FROM attempts_current a
     INNER JOIN run_node_items_current n ON n.run_id = a.run_id AND n.node_id = a.node_id
     WHERE n.work_item_id = ?
     ORDER BY CASE WHEN a.status IN ('starting', 'running') THEN 0 ELSE 1 END, a.started_at DESC
     LIMIT 1`,
  ).get(itemId) as any
  return raw ? toAttemptRow(raw) : null
}

/** All attempts for a work item, newest first. */
export function attemptsForItem(db: SqliteDb, itemId: string): AttemptRow[] {
  return (db.query(
    `SELECT a.*
     FROM attempts_current a
     INNER JOIN run_node_items_current n ON n.run_id = a.run_id AND n.node_id = a.node_id
     WHERE n.work_item_id = ?
     ORDER BY a.started_at DESC`,
  ).all(itemId) as any[]).map(toAttemptRow)
}

/** All ongoing (unfinished) executions for a work item. */
export function liveExecutions(db: SqliteDb, itemId: string) {
  return db.query(
    `SELECT a.run_id, a.node_id, a.session_id, a.pty_id, a.directory, a.worktree_path
     FROM attempts_current a
     INNER JOIN run_node_items_current n ON n.run_id = a.run_id AND n.node_id = a.node_id
     WHERE n.work_item_id = ? AND a.finished_at IS NULL
     ORDER BY a.started_at DESC`,
  ).all(itemId) as Array<{
    run_id: string
    node_id: string
    session_id: string | null
    pty_id: string | null
    directory: string | null
    worktree_path: string | null
  }>
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

/** All runs that include a work item, with latest attempt metadata. */
export function runsForItem(db: SqliteDb, itemId: string) {
  return (db.query(
    `SELECT DISTINCT
        r.run_id,
        r.goal,
        r.status,
        r.source_id,
        r.created_at,
        r.updated_at,
        n.node_id,
        COALESCE(a.runtime_type, x.runtime_type, 'workspace') AS runtime_type,
        a.attempt_id,
        a.status AS attempt_status,
        a.session_id,
        a.pty_id,
        a.directory,
        a.worktree_path
      FROM run_node_items_current n
      INNER JOIN runs_current r ON r.run_id = n.run_id
      LEFT JOIN run_exec_current x ON x.run_id = r.run_id
      LEFT JOIN (
        SELECT run_id, node_id, attempt_id, runtime_type, status,
               session_id, pty_id, directory, worktree_path, started_at
        FROM attempts_current a1
        WHERE started_at = (
          SELECT MAX(started_at) FROM attempts_current a2
          WHERE a2.run_id = a1.run_id AND a2.node_id = a1.node_id
        )
      ) a ON a.run_id = n.run_id AND a.node_id = n.node_id
      WHERE n.work_item_id = ?
      ORDER BY COALESCE(a.started_at, r.updated_at, r.created_at, '') DESC`,
  ).all(itemId) as any[]).map((r) => ({
    run_id: r.run_id,
    goal: r.goal,
    status: r.status,
    slice_id: r.source_id ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
    runtime_type: r.runtime_type ?? "workspace",
    attempt_id: r.attempt_id ?? null,
    attempt_status: r.attempt_status ?? null,
    session_id: r.session_id ?? null,
    pty_id: r.pty_id ?? null,
    directory: r.directory ?? null,
    worktree_path: r.worktree_path ?? null,
    node_id: r.node_id,
  }))
}

/** Set of work_item_ids that have at least one run in "executing" status. */
export function activeRunItemIds(db: SqliteDb): Set<string> {
  return new Set(
    (db.query(
      `SELECT DISTINCT n.work_item_id
       FROM run_node_items_current n
       INNER JOIN runs_current r ON r.run_id = n.run_id
       WHERE r.status = 'executing'`,
    ).all() as any[]).map((r) => r.work_item_id),
  )
}

/** Upsert run_exec_current with execution metadata. */
export function touchRun(
  db: SqliteDb,
  runId: string,
  meta: { runtime_type?: string; session_id?: string | null; pty_id?: string | null; directory?: string | null },
): void {
  const now = new Date().toISOString()
  const exists = db.query("SELECT run_id FROM run_exec_current WHERE run_id = ?").get(runId) as any
  if (!exists) {
    db.run(
      "INSERT INTO run_exec_current (run_id, runtime_type, session_id, pty_id, directory, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, meta.runtime_type ?? "workspace", meta.session_id ?? null, meta.pty_id ?? null, meta.directory ?? null, now],
    )
  } else {
    db.run(
      "UPDATE run_exec_current SET runtime_type = ?, session_id = ?, pty_id = ?, directory = ?, updated_at = ? WHERE run_id = ?",
      [meta.runtime_type ?? null, meta.session_id ?? null, meta.pty_id ?? null, meta.directory ?? null, now, runId],
    )
  }
}

// ---------------------------------------------------------------------------
// Event/artifact helpers
// ---------------------------------------------------------------------------

/** All events for runs that include a work item, filtered to relevant node events. */
export function eventsForItem(db: SqliteDb, itemId: string) {
  const runs = runsForItem(db, itemId)
  if (!runs.length) return []
  const nodesByRun = new Map<string, Set<string>>()
  for (const run of runs) {
    const set = nodesByRun.get(run.run_id) ?? new Set<string>()
    set.add(run.node_id)
    nodesByRun.set(run.run_id, set)
  }
  return Array.from(nodesByRun.entries())
    .flatMap(([runId, nodes]) =>
      (db.query("SELECT * FROM events WHERE run_id = ? ORDER BY stream_seq ASC").all(runId) as any[]).filter((event) => {
        try {
          const data = JSON.parse(event.payload_json)
          return typeof data === "object" && data && typeof data.node_id === "string" && nodes.has(data.node_id)
        } catch {
          return false
        }
      }),
    )
    .sort((a, b) => {
      if (a.created_at === b.created_at) return a.stream_seq - b.stream_seq
      return a.created_at.localeCompare(b.created_at)
    })
}

/** Artifacts emitted by a work item's execution runs. */
export function artifactsForItem(db: SqliteDb, itemId: string) {
  return eventsForItem(db, itemId)
    .filter((event) => event.type === "artifact_created")
    .flatMap((event) => {
      try {
        const data = JSON.parse(event.payload_json)
        if (typeof data !== "object" || !data) return []
        if (typeof data.artifact_id !== "string" || typeof data.content !== "string") return []
        return [{
          artifact_id: data.artifact_id,
          node_id: typeof data.node_id === "string" ? data.node_id : null,
          type: typeof data.type === "string" ? data.type : "artifact",
          content: data.content,
          created_at: event.created_at,
        }]
      } catch {
        return []
      }
    })
}

/** Artifacts from a work item and all its descendants (deduped). */
export function descendantArtifacts(db: Database, itemId: string) {
  const ids = getWorkGraph().getDescendants(itemId).map((item) => item.id)
  const seen = new Set<string>()
  return ids
    .flatMap((id) => artifactsForItem(db, id))
    .filter((artifact) => {
      if (seen.has(artifact.artifact_id)) return false
      seen.add(artifact.artifact_id)
      return true
    })
}

// ---------------------------------------------------------------------------
// Item view helpers
// ---------------------------------------------------------------------------

function itemLifecycle(item: WorkItem): "deleted" | "archived" | "active" {
  if (item.deletedAt) return "deleted"
  if (item.archivedAt) return "archived"
  return "active"
}

function itemIsActive(item: WorkItem): boolean {
  return !item.archivedAt && !item.deletedAt
}

function nodeRole(labels: string[]): string {
  if (labels.includes("qa")) return "qa"
  if (labels.includes("review")) return "code_reviewer"
  if (labels.includes("design")) return "designer"
  if (labels.includes("pm")) return "pm"
  return "developer"
}

/** Build the full item API response object. */
export function itemRow(db: Database, item: WorkItem, sliceStore: ISliceStore) {
  const wg = getWorkGraph()
  const blocked = wg.getBlockedBy(item.id)
  const blocking = wg.getBlocking(item.id)
  const slices = wg.getSlices(item.id).map((sliceId) => sliceStore.get(sliceId)).filter(Boolean)
  const runs = runsForItem(db, item.id)
  const last = attemptForItem(db, item.id)
  const live = runs.find((run) => run.attempt_status === "running" || run.attempt_status === "starting") ?? null
  const isBlocked = item.nodeType !== "mission" && itemIsActive(item) && item.status === "open" && blocked.some((dep) => dep.status !== "done")
  const ready = item.nodeType !== "mission" && itemIsActive(item) && item.status === "open" && !isBlocked && !live
  return {
    item_id: item.id,
    parent_id: item.parentId ?? null,
    repo_ref: item.repoRef ?? null,
    repo_label: item.repoLabel ?? null,
    node_type: item.nodeType,
    title: item.title,
    description: item.description,
    status: item.status,
    lifecycle: itemLifecycle(item),
    archived_at: item.archivedAt ?? null,
    archived_reason: item.archivedReason ?? null,
    deleted_at: item.deletedAt ?? null,
    deleted_reason: item.deletedReason ?? null,
    labels: item.labels,
    context: item.context ?? null,
    provider: item.provider ?? null,
    provider_meta: item.providerMeta ?? null,
    provider_url: item.providerUrl ?? null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    blocked: isBlocked,
    ready,
    blockers: blocked.length,
    dependents: blocking.length,
    slices: slices.map((s) => ({ slice_id: s!.slice_id, title: s!.title, kind: s!.kind, status: s!.status })),
    active_run_id: live?.run_id ?? null,
    latest_run_id: runs[0]?.run_id ?? null,
    runtime_type: live?.runtime_type ?? last?.runtime_type ?? null,
    attempt_id: live?.attempt_id ?? last?.attempt_id ?? null,
    attempt_status: live?.attempt_status ?? last?.status ?? null,
    session_id: live?.session_id ?? last?.session_id ?? null,
    pty_id: live?.pty_id ?? last?.pty_id ?? null,
    directory: live?.directory ?? last?.directory ?? null,
    worktree_path: live?.worktree_path ?? last?.worktree_path ?? null,
  }
}

export type ItemRowResult = ReturnType<typeof itemRow>

/** Filter and map a list of work items for API responses. */
export function applyItemFilters(
  items: WorkItem[],
  db: Database,
  sliceStore: ISliceStore,
  query: {
    status?: string | null
    lifecycle?: string | null
    slice_id?: string | null
    run_id?: string | null
    repo_ref?: string | null
    attention?: string | null
    search?: string | null
  },
): WorkItem[] {
  const wg = getWorkGraph()
  let filtered = items.filter((item) => {
    if (query.lifecycle === "all") return true
    if (query.lifecycle === "archived") return !!item.archivedAt && !item.deletedAt
    if (query.lifecycle === "deleted") return !!item.deletedAt
    return itemIsActive(item)
  })
  if (query.slice_id) {
    const ids = new Set(wg.getBySlice(query.slice_id).map((item) => item.id))
    filtered = filtered.filter((item) => ids.has(item.id))
  }
  if (query.run_id) {
    const ids = new Set(
      (db.query("SELECT DISTINCT work_item_id FROM run_node_items_current WHERE run_id = ?").all(query.run_id) as any[])
        .map((r) => r.work_item_id),
    )
    filtered = filtered.filter((item) => ids.has(item.id))
  }
  if (query.repo_ref === "__unbound__") {
    filtered = filtered.filter((item) => !item.repoRef)
  } else if (query.repo_ref) {
    filtered = filtered.filter((item) => item.repoRef === query.repo_ref)
  }
  if (query.search) {
    const txt = query.search.toLowerCase()
    filtered = filtered.filter((item) =>
      item.title.toLowerCase().includes(txt) || item.description.toLowerCase().includes(txt),
    )
  }
  if (!query.status && !query.attention) return filtered
  return filtered.filter((item) => {
    const info = itemRow(db, item, sliceStore)
    if (query.attention === "true" && !info.session_id) return false
    if (!query.status || query.status === "all") return true
    if (query.status === "ready") return info.ready
    if (query.status === "active") return item.status === "in_progress" || !!info.active_run_id
    if (query.status === "blocked") return info.blocked
    if (query.status === "done") return item.status === "done"
    return item.status === query.status
  })
}

/** Scratchpad entries for all descendants of a work item. */
export function descendantScratchpads(itemId: string) {
  const wg = getWorkGraph()
  const ids = new Set(wg.getDescendants(itemId).map((item) => item.id))
  return wg.getScratchpads().filter((entry) => ids.has(entry.workItemId))
}

/** Synthesis child item view (if exists). */
export function synthesisItem(db: Database, itemId: string, sliceStore: ISliceStore): ItemRowResult | null {
  const item = getWorkGraph().getChildren(itemId).find((child) => child.nodeType === "synthesis")
  return item ? itemRow(db, item, sliceStore) : null
}

/** Latest artifact from the synthesis child node. */
export function synthesisArtifact(db: Database, itemId: string) {
  const item = getWorkGraph().getChildren(itemId).find((child) => child.nodeType === "synthesis")
  if (!item) return null
  return artifactsForItem(db, item.id).at(-1) ?? null
}

// ---------------------------------------------------------------------------
// Execution planning helpers
// ---------------------------------------------------------------------------

/** Walk the dependency subtree from rootId, returning all non-done work items. */
function subtreeItems(wg: ReturnType<typeof getWorkGraph>, rootId: string): WorkItem[] {
  const root = wg.get(rootId)
  if (root?.nodeType === "mission") {
    return wg.getDescendants(rootId).filter((item) => itemIsActive(item) && item.status !== "done" && item.nodeType !== "mission")
  }
  const seen = new Set<string>()
  const walk = (id: string): WorkItem[] => {
    if (seen.has(id)) return []
    seen.add(id)
    const item = wg.get(id)
    if (!item || !itemIsActive(item) || item.status === "done") return []
    return [item, ...wg.getBlocking(id).flatMap((child) => walk(child.id))]
  }
  return walk(rootId)
}

export interface FocusResult {
  items: WorkItem[]
  ready: WorkItem[]
  hold: Set<string>
  blocked: Array<{ item_id: string; title: string; blocked_item_ids: string[] }>
}

/**
 * Compute ready/blocked/busy partitions for a mission's subtree.
 * Returns `ready` (can start now), `blocked` (external blockers), `hold` (set of item ids blocked internally).
 */
export function focusSubtree(wg: ReturnType<typeof getWorkGraph>, db: Database, rootId: string): FocusResult {
  const items = subtreeItems(wg, rootId)
  const ids = new Set(items.map((item) => item.id))
  const busy = activeRunItemIds(db)
  const out = new Map<string, { item_id: string; title: string; blocked_item_ids: Set<string> }>()
  const mark = (blocker: WorkItem, itemId: string) => {
    const entry = out.get(blocker.id) ?? { item_id: blocker.id, title: blocker.title, blocked_item_ids: new Set<string>() }
    entry.blocked_item_ids.add(itemId)
    out.set(blocker.id, entry)
  }
  for (const item of items) {
    if (busy.has(item.id) || item.status === "in_progress") mark(item, item.id)
    for (const dep of wg.getBlockedBy(item.id).filter((n) => n.status !== "done")) {
      if (ids.has(dep.id)) continue
      mark(dep, item.id)
    }
  }
  const hold = new Set(Array.from(out.values()).flatMap((item) => Array.from(item.blocked_item_ids)))
  const ready = items.filter((item) =>
    item.status === "open" &&
    !busy.has(item.id) &&
    !hold.has(item.id) &&
    wg.getBlockedBy(item.id).every((dep) => dep.status === "done"),
  )
  return {
    items,
    ready,
    hold,
    blocked: Array.from(out.values()).map((item) => ({
      item_id: item.item_id,
      title: item.title,
      blocked_item_ids: Array.from(item.blocked_item_ids),
    })),
  }
}

/**
 * Create a run snapshot: insert nodes, node-item mappings, scratchpad entries, and dependency edges.
 * Returns a nodeId → workItemId map.
 */
export function createSnapshot(
  db: Database,
  runId: string,
  items: WorkItem[],
  hold = new Set<string>(),
): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    const nodeId = `node_${ulid()}`
    map.set(item.id, nodeId)
    const status = hold.has(item.id) ? "blocked" : "pending"
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, role, kind, title, node_type, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [nodeId, runId, nodeRole(item.labels), item.labels[0] ?? item.nodeType, item.title || item.id, item.nodeType, status, 0],
    )
    db.run(
      "INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      [runId, nodeId, item.id],
    )
    const body = item.description || `Execute task: ${item.title || item.id}`
    db.run(
      "INSERT INTO scratchpad_entries (id, run_id, node_id, content, created_at, expires_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `sp_${ulid()}`,
        runId,
        nodeId,
        body,
        new Date().toISOString(),
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        new TextEncoder().encode(body).length,
      ],
    )
  }
  const ids = new Set(items.map((item) => item.id))
  const edges = getWorkGraph().getState().edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  for (const edge of edges) {
    const source = map.get(edge.source)
    const target = map.get(edge.target)
    if (!source || !target) continue
    db.run(
      "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
      [`edge_${ulid()}`, runId, source, target, "depends_on"],
    )
  }
  // Return nodeId → itemId map (flipped from map)
  return new Map(
    items
      .map((item) => {
        const nodeId = map.get(item.id)
        return nodeId ? ([nodeId, item.id] as const) : null
      })
      .filter(Boolean) as Array<readonly [string, string]>,
  )
}

/**
 * Record external blockers in run_blockers_current.
 * Replaces any existing blockers for the run.
 */
export function writeBlockers(
  db: Database,
  runId: string,
  blocked: Array<{ item_id: string; title: string; blocked_item_ids: string[] }>,
  nodeItemMap: Map<string, string>,
): void {
  db.run("DELETE FROM run_blockers_current WHERE run_id = ?", [runId])
  for (const blocker of blocked) {
    for (const targetItemId of blocker.blocked_item_ids) {
      // nodeItemMap is nodeId→itemId; we need itemId→nodeId
      const nodeId = Array.from(nodeItemMap.entries()).find(([, iid]) => iid === targetItemId)?.[0]
      if (!nodeId) continue
      db.run(
        "INSERT INTO run_blockers_current (run_id, work_item_id, target_node_id, title) VALUES (?, ?, ?, ?)",
        [runId, blocker.item_id, nodeId, blocker.title],
      )
    }
  }
}

/** Active (non-done) dependents of an item — used to check before delete. */
export function activeDependents(wg: ReturnType<typeof getWorkGraph>, itemId: string): WorkItem[] {
  return wg.getBlocking(itemId).filter((item) => itemIsActive(item) && item.status !== "done")
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

function encodeCursor(createdAt: string, itemId: string): string {
  return btoa(JSON.stringify({ ts: createdAt, id: itemId }))
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    return JSON.parse(atob(cursor))
  } catch {
    return null
  }
}

/** Cursor-paginate a list of item rows. Sorts by created_at ASC, item_id ASC. */
export function paginateItems(
  rows: ItemRowResult[],
  cursor: string | null | undefined,
  limit: number,
): { items: ItemRowResult[]; next_cursor: string | null } {
  const sorted = [...rows].sort((a, b) => {
    const tc = (a.created_at ?? "").localeCompare(b.created_at ?? "")
    if (tc !== 0) return tc
    return a.item_id.localeCompare(b.item_id)
  })
  let start = 0
  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (decoded) {
      const idx = sorted.findIndex(
        (r) =>
          (r.created_at ?? "") > decoded.ts ||
          ((r.created_at ?? "") === decoded.ts && r.item_id > decoded.id),
      )
      start = idx === -1 ? sorted.length : idx
    }
  }
  const page = sorted.slice(start, start + limit)
  const last = page.at(-1)
  const next_cursor =
    last && start + limit < sorted.length
      ? encodeCursor(last.created_at ?? "", last.item_id)
      : null
  return { items: page, next_cursor }
}
