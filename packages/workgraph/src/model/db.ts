import { Database } from "bun:sqlite"
import { existsSync, rmSync } from "node:fs"
import type { WorkItem, WorkEdge, WorkEvent, ScratchpadEntry } from "./types"

export function initDb(path?: string): Database {
  const fresh = !!path && !existsSync(path)
  try {
    return boot(path)
  } catch (err) {
    if (!path || !fresh || !retry(err)) throw err
    wipe(path)
    return boot(path)
  }
}

function boot(path?: string): Database {
  const db = new Database(path ?? ":memory:")
  try {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")

    db.exec(`
    CREATE TABLE IF NOT EXISTS wg_events (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

    db.exec(`
    CREATE TABLE IF NOT EXISTS wg_items (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      parent_id TEXT,
      repo_ref TEXT,
      repo_label TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      node_type TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL DEFAULT 'open',
      archived_at TEXT,
      archived_reason TEXT,
      deleted_at TEXT,
      deleted_reason TEXT,
      labels TEXT NOT NULL DEFAULT '[]',
      context TEXT,
      provider TEXT,
      provider_meta TEXT,
      provider_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
    ensureColumn(db, "wg_items", "source_id", "ALTER TABLE wg_items ADD COLUMN source_id TEXT")
    ensureColumn(db, "wg_items", "parent_id", "ALTER TABLE wg_items ADD COLUMN parent_id TEXT")
    ensureColumn(db, "wg_items", "repo_ref", "ALTER TABLE wg_items ADD COLUMN repo_ref TEXT")
    ensureColumn(db, "wg_items", "repo_label", "ALTER TABLE wg_items ADD COLUMN repo_label TEXT")
    ensureColumn(db, "wg_items", "node_type", "ALTER TABLE wg_items ADD COLUMN node_type TEXT NOT NULL DEFAULT 'task'")
    ensureColumn(db, "wg_items", "archived_at", "ALTER TABLE wg_items ADD COLUMN archived_at TEXT")
    ensureColumn(db, "wg_items", "archived_reason", "ALTER TABLE wg_items ADD COLUMN archived_reason TEXT")
    ensureColumn(db, "wg_items", "deleted_at", "ALTER TABLE wg_items ADD COLUMN deleted_at TEXT")
    ensureColumn(db, "wg_items", "deleted_reason", "ALTER TABLE wg_items ADD COLUMN deleted_reason TEXT")

    db.exec(`
    CREATE TABLE IF NOT EXISTS wg_edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (source, target)
    )
  `)

    db.exec(`
    CREATE TABLE IF NOT EXISTS wg_item_slices (
      item_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      PRIMARY KEY (item_id, slice_id)
    )
  `)

    db.exec(`
    INSERT OR IGNORE INTO wg_item_slices (item_id, slice_id)
    SELECT id, source_id
    FROM wg_items
    WHERE source_id IS NOT NULL
  `)

    db.exec(`
    CREATE TABLE IF NOT EXISTS wg_scratchpads (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'fyi',
      needs_review INTEGER NOT NULL DEFAULT 0,
      promoted_to_item_id TEXT,
      dismissed_at TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

    db.exec(`
    CREATE TABLE IF NOT EXISTS wg_sync_projection (
      binding_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_meta TEXT NOT NULL,
      last_status TEXT,
      blocked_hash TEXT,
      archive_hash TEXT,
      last_synced_at TEXT
    )
  `)

    db.exec(`
    CREATE TABLE IF NOT EXISTS wg_run_links (
      run_id  TEXT PRIMARY KEY,
      item_id TEXT NOT NULL
    )
  `)

    return db
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }
}

function retry(err: unknown) {
  const txt = err instanceof Error ? err.message : String(err)
  return txt.includes("SQLITE_IOERR_SHORT_READ") || txt.includes("disk I/O error")
}

function wipe(path: string) {
  try { rmSync(`${path}-shm`, { force: true }) } catch {}
  try { rmSync(`${path}-wal`, { force: true }) } catch {}
}

export function insertEvent(db: Database, event: WorkEvent): void {
  db.prepare(
    `INSERT INTO wg_events (id, seq, type, payload, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(event.id, event.seq, event.type, event.payload, event.actor, event.createdAt)
}

export function getEvents(db: Database, sinceSeq?: number): WorkEvent[] {
  const rows = sinceSeq != null
    ? db.prepare(`SELECT * FROM wg_events WHERE seq > ? ORDER BY seq ASC`).all(sinceSeq) as any[]
    : db.prepare(`SELECT * FROM wg_events ORDER BY seq ASC`).all() as any[]
  return rows.map(rowToEvent)
}

export function getMaxSeq(db: Database): number {
  const row = db.prepare(`SELECT MAX(seq) as max_seq FROM wg_events`).get() as any
  return row?.max_seq ?? 0
}

export function insertItem(db: Database, item: WorkItem): void {
  db.prepare(
    `INSERT INTO wg_items (id, source_id, parent_id, repo_ref, repo_label, title, description, node_type, status, archived_at, archived_reason, deleted_at, deleted_reason, labels, context, provider, provider_meta, provider_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.sourceId ?? null,
    item.parentId ?? null,
    item.repoRef ?? null,
    item.repoLabel ?? null,
    item.title,
    item.description,
    item.nodeType,
    item.status,
    item.archivedAt ?? null,
    item.archivedReason ?? null,
    item.deletedAt ?? null,
    item.deletedReason ?? null,
    JSON.stringify(item.labels),
    item.context ?? null,
    item.provider ?? null,
    item.providerMeta ? JSON.stringify(item.providerMeta) : null,
    item.providerUrl ?? null,
    item.createdAt,
    item.updatedAt,
  )
  if (item.sourceId) {
    linkItemSlice(db, item.id, item.sourceId)
  }
}

export function updateItem(db: Database, id: string, changes: Partial<WorkItem>): void {
  const sets: string[] = []
  const values: any[] = []

  if (changes.sourceId !== undefined) { sets.push("source_id = ?"); values.push(changes.sourceId) }
  if (changes.parentId !== undefined) { sets.push("parent_id = ?"); values.push(changes.parentId) }
  if (changes.repoRef !== undefined) { sets.push("repo_ref = ?"); values.push(changes.repoRef) }
  if (changes.repoLabel !== undefined) { sets.push("repo_label = ?"); values.push(changes.repoLabel) }
  if (changes.title !== undefined) { sets.push("title = ?"); values.push(changes.title) }
  if (changes.description !== undefined) { sets.push("description = ?"); values.push(changes.description) }
  if (changes.nodeType !== undefined) { sets.push("node_type = ?"); values.push(changes.nodeType) }
  if (changes.status !== undefined) { sets.push("status = ?"); values.push(changes.status) }
  if (changes.archivedAt !== undefined) { sets.push("archived_at = ?"); values.push(changes.archivedAt) }
  if (changes.archivedReason !== undefined) { sets.push("archived_reason = ?"); values.push(changes.archivedReason) }
  if (changes.deletedAt !== undefined) { sets.push("deleted_at = ?"); values.push(changes.deletedAt) }
  if (changes.deletedReason !== undefined) { sets.push("deleted_reason = ?"); values.push(changes.deletedReason) }
  if (changes.labels !== undefined) { sets.push("labels = ?"); values.push(JSON.stringify(changes.labels)) }
  if (changes.context !== undefined) { sets.push("context = ?"); values.push(changes.context) }
  if (changes.provider !== undefined) { sets.push("provider = ?"); values.push(changes.provider) }
  if (changes.providerMeta !== undefined) { sets.push("provider_meta = ?"); values.push(JSON.stringify(changes.providerMeta)) }
  if (changes.providerUrl !== undefined) { sets.push("provider_url = ?"); values.push(changes.providerUrl) }
  if (changes.updatedAt !== undefined) { sets.push("updated_at = ?"); values.push(changes.updatedAt) }

  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE wg_items SET ${sets.join(", ")} WHERE id = ?`).run(...values)
  if (changes.sourceId) {
    linkItemSlice(db, id, changes.sourceId)
  }
}

export function deleteItem(db: Database, id: string): void {
  db.prepare(`DELETE FROM wg_edges WHERE source = ? OR target = ?`).run(id, id)
  db.prepare(`DELETE FROM wg_item_slices WHERE item_id = ?`).run(id)
}

export function getItem(db: Database, id: string): WorkItem | undefined {
  const row = db.prepare(`SELECT * FROM wg_items WHERE id = ?`).get(id) as any
  return row ? rowToItem(row) : undefined
}

export function getAllItems(db: Database): WorkItem[] {
  const rows = db.prepare(`SELECT * FROM wg_items ORDER BY created_at ASC`).all() as any[]
  return rows.map(rowToItem)
}

export function insertEdge(db: Database, source: string, target: string): void {
  db.prepare(`INSERT INTO wg_edges (source, target) VALUES (?, ?)`).run(source, target)
}

export function deleteEdge(db: Database, source: string, target: string): void {
  db.prepare(`DELETE FROM wg_edges WHERE source = ? AND target = ?`).run(source, target)
}

export function getAllEdges(db: Database): WorkEdge[] {
  const rows = db.prepare(`SELECT * FROM wg_edges`).all() as any[]
  return rows.map((r) => ({ source: r.source, target: r.target }))
}

export function linkItemSlice(db: Database, itemId: string, sliceId: string): void {
  db.prepare(`INSERT OR IGNORE INTO wg_item_slices (item_id, slice_id) VALUES (?, ?)`).run(itemId, sliceId)
}

export function clearItemSlices(db: Database, itemId: string): void {
  db.prepare(`DELETE FROM wg_item_slices WHERE item_id = ?`).run(itemId)
}

export function getItemSlices(db: Database, itemId: string): string[] {
  return (db.prepare(`SELECT slice_id FROM wg_item_slices WHERE item_id = ? ORDER BY slice_id ASC`).all(itemId) as any[])
    .map((row) => row.slice_id)
}

export function getSliceItems(db: Database, sliceId: string): string[] {
  return (db.prepare(`SELECT item_id FROM wg_item_slices WHERE slice_id = ? ORDER BY item_id ASC`).all(sliceId) as any[])
    .map((row) => row.item_id)
}

// --- Scratchpad CRUD ---

export function insertScratchpad(db: Database, entry: ScratchpadEntry): void {
  db.prepare(
    `INSERT INTO wg_scratchpads (id, work_item_id, content, priority, needs_review, promoted_to_item_id, dismissed_at, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.workItemId,
    entry.content,
    entry.priority,
    entry.needsReview ? 1 : 0,
    entry.promotedToItemId ?? null,
    entry.dismissedAt ?? null,
    entry.actor,
    entry.createdAt,
  )
}

export function updateScratchpad(db: Database, id: string, changes: Partial<ScratchpadEntry>): void {
  const sets: string[] = []
  const values: any[] = []

  if (changes.promotedToItemId !== undefined) { sets.push("promoted_to_item_id = ?"); values.push(changes.promotedToItemId) }
  if (changes.dismissedAt !== undefined) { sets.push("dismissed_at = ?"); values.push(changes.dismissedAt) }

  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE wg_scratchpads SET ${sets.join(", ")} WHERE id = ?`).run(...values)
}

export function getScratchpadsByItem(db: Database, workItemId: string): ScratchpadEntry[] {
  const rows = db.prepare(`SELECT * FROM wg_scratchpads WHERE work_item_id = ? ORDER BY created_at ASC`).all(workItemId) as any[]
  return rows.map(rowToScratchpad)
}

export function getScratchpadsNeedingReview(db: Database): ScratchpadEntry[] {
  const rows = db.prepare(
    `SELECT * FROM wg_scratchpads WHERE needs_review = 1 AND promoted_to_item_id IS NULL AND dismissed_at IS NULL ORDER BY created_at ASC`,
  ).all() as any[]
  return rows.map(rowToScratchpad)
}

export function getAllScratchpads(db: Database): ScratchpadEntry[] {
  const rows = db.prepare(`SELECT * FROM wg_scratchpads ORDER BY created_at ASC`).all() as any[]
  return rows.map(rowToScratchpad)
}

export function getScratchpad(db: Database, id: string): ScratchpadEntry | undefined {
  const row = db.prepare(`SELECT * FROM wg_scratchpads WHERE id = ?`).get(id) as any
  return row ? rowToScratchpad(row) : undefined
}

// --- Run links CRUD ---

export function insertRunLink(db: Database, runId: string, itemId: string): void {
  db.prepare(`INSERT OR REPLACE INTO wg_run_links (run_id, item_id) VALUES (?, ?)`).run(runId, itemId)
}

export function deleteRunLink(db: Database, runId: string): void {
  db.prepare(`DELETE FROM wg_run_links WHERE run_id = ?`).run(runId)
}

export function getRunLinkByRunId(db: Database, runId: string): string | undefined {
  const row = db.prepare(`SELECT item_id FROM wg_run_links WHERE run_id = ?`).get(runId) as { item_id: string } | undefined
  return row?.item_id
}

export function getRunLinkByItemId(db: Database, itemId: string): string | undefined {
  const row = db.prepare(`SELECT run_id FROM wg_run_links WHERE item_id = ?`).get(itemId) as { run_id: string } | undefined
  return row?.run_id
}

export function getAllRunLinks(db: Database): Array<{ runId: string; itemId: string }> {
  const rows = db.prepare(`SELECT run_id, item_id FROM wg_run_links`).all() as Array<{ run_id: string; item_id: string }>
  return rows.map((r) => ({ runId: r.run_id, itemId: r.item_id }))
}

// --- Row mappers ---

function rowToItem(row: any): WorkItem {
  return {
    id: row.id,
    sourceId: row.source_id ?? undefined,
    parentId: row.parent_id ?? null,
    repoRef: row.repo_ref ?? null,
    repoLabel: row.repo_label ?? null,
    title: row.title,
    description: row.description,
    nodeType: row.node_type ?? "task",
    status: row.status,
    archivedAt: row.archived_at ?? undefined,
    archivedReason: row.archived_reason ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    deletedReason: row.deleted_reason ?? undefined,
    labels: JSON.parse(row.labels),
    context: row.context ?? undefined,
    provider: row.provider ?? undefined,
    providerMeta: row.provider_meta ? JSON.parse(row.provider_meta) : undefined,
    providerUrl: row.provider_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getSyncProjection(
  db: Database,
  key: string,
): {
  bindingKey: string
  provider: string
  providerMeta: Record<string, any>
  lastStatus?: string
  blockedHash?: string
  archiveHash?: string
  lastSyncedAt?: string
} | undefined {
  const row = db.prepare("SELECT * FROM wg_sync_projection WHERE binding_key = ?").get(key) as any
  if (!row) return
  return {
    bindingKey: row.binding_key,
    provider: row.provider,
    providerMeta: JSON.parse(row.provider_meta),
    lastStatus: row.last_status ?? undefined,
    blockedHash: row.blocked_hash ?? undefined,
    archiveHash: row.archive_hash ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
  }
}

export function upsertSyncProjection(
  db: Database,
  input: {
    bindingKey: string
    provider: string
    providerMeta: Record<string, any>
    lastStatus?: string
    blockedHash?: string
    archiveHash?: string
  },
): void {
  db.prepare(
    `INSERT INTO wg_sync_projection (binding_key, provider, provider_meta, last_status, blocked_hash, archive_hash, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(binding_key) DO UPDATE SET
       provider = excluded.provider,
       provider_meta = excluded.provider_meta,
       last_status = excluded.last_status,
       blocked_hash = excluded.blocked_hash,
       archive_hash = excluded.archive_hash,
       last_synced_at = excluded.last_synced_at`,
  ).run(
    input.bindingKey,
    input.provider,
    JSON.stringify(input.providerMeta),
    input.lastStatus ?? null,
    input.blockedHash ?? null,
    input.archiveHash ?? null,
    new Date().toISOString(),
  )
}

function ensureColumn(db: Database, table: string, col: string, sql: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (rows.some((row) => row.name === col)) return
  db.exec(sql)
}

function rowToEvent(row: any): WorkEvent {
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    actor: row.actor,
    createdAt: row.created_at,
  }
}

function rowToScratchpad(row: any): ScratchpadEntry {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    content: row.content,
    priority: row.priority,
    needsReview: row.needs_review === 1,
    promotedToItemId: row.promoted_to_item_id ?? undefined,
    dismissedAt: row.dismissed_at ?? undefined,
    actor: row.actor,
    createdAt: row.created_at,
  }
}
