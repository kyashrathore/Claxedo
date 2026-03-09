import { Database } from "bun:sqlite"
import type { WorkItem, WorkEdge, WorkEvent, ScratchpadEntry } from "./types"

export function initDb(path?: string): Database {
  const db = new Database(path ?? ":memory:")
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
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      labels TEXT NOT NULL DEFAULT '[]',
      context TEXT,
      provider TEXT,
      provider_meta TEXT,
      provider_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS wg_edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (source, target)
    )
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

  return db
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
    `INSERT INTO wg_items (id, title, description, status, labels, context, provider, provider_meta, provider_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.title,
    item.description,
    item.status,
    JSON.stringify(item.labels),
    item.context ?? null,
    item.provider ?? null,
    item.providerMeta ? JSON.stringify(item.providerMeta) : null,
    item.providerUrl ?? null,
    item.createdAt,
    item.updatedAt,
  )
}

export function updateItem(db: Database, id: string, changes: Partial<WorkItem>): void {
  const sets: string[] = []
  const values: any[] = []

  if (changes.title !== undefined) { sets.push("title = ?"); values.push(changes.title) }
  if (changes.description !== undefined) { sets.push("description = ?"); values.push(changes.description) }
  if (changes.status !== undefined) { sets.push("status = ?"); values.push(changes.status) }
  if (changes.labels !== undefined) { sets.push("labels = ?"); values.push(JSON.stringify(changes.labels)) }
  if (changes.context !== undefined) { sets.push("context = ?"); values.push(changes.context) }
  if (changes.provider !== undefined) { sets.push("provider = ?"); values.push(changes.provider) }
  if (changes.providerMeta !== undefined) { sets.push("provider_meta = ?"); values.push(JSON.stringify(changes.providerMeta)) }
  if (changes.providerUrl !== undefined) { sets.push("provider_url = ?"); values.push(changes.providerUrl) }
  if (changes.updatedAt !== undefined) { sets.push("updated_at = ?"); values.push(changes.updatedAt) }

  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE wg_items SET ${sets.join(", ")} WHERE id = ?`).run(...values)
}

export function deleteItem(db: Database, id: string): void {
  db.prepare(`DELETE FROM wg_items WHERE id = ?`).run(id)
  db.prepare(`DELETE FROM wg_edges WHERE source = ? OR target = ?`).run(id, id)
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

// --- Row mappers ---

function rowToItem(row: any): WorkItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    labels: JSON.parse(row.labels),
    context: row.context ?? undefined,
    provider: row.provider ?? undefined,
    providerMeta: row.provider_meta ? JSON.parse(row.provider_meta) : undefined,
    providerUrl: row.provider_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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

