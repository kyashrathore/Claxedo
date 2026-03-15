import { Database } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { eq, gt, asc, and, or, isNull } from "drizzle-orm"
import { existsSync, rmSync } from "node:fs"
import type { WorkItem, WorkEdge, WorkEvent, ScratchpadEntry } from "./types"
import type { WorkGraphRepo, SyncProjection } from "./repo"

// To swap SQLite drivers (e.g. bun:sqlite → better-sqlite3), update the two
// imports above and this alias. The class below is unchanged.
type Db = BunSQLiteDatabase

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const wg_events = sqliteTable("wg_events", {
  id: text("id").primaryKey(),
  seq: integer("seq").notNull().unique(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  actor: text("actor").notNull(),
  created_at: text("created_at").notNull(),
})

const wg_items = sqliteTable("wg_items", {
  id: text("id").primaryKey(),
  source_id: text("source_id"),
  parent_id: text("parent_id"),
  repo_ref: text("repo_ref"),
  repo_label: text("repo_label"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  node_type: text("node_type").notNull().default("task"),
  status: text("status").notNull().default("open"),
  archived_at: text("archived_at"),
  archived_reason: text("archived_reason"),
  deleted_at: text("deleted_at"),
  deleted_reason: text("deleted_reason"),
  labels: text("labels").notNull().default("[]"),
  context: text("context"),
  provider: text("provider"),
  provider_meta: text("provider_meta"),
  provider_url: text("provider_url"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
})

const wg_edges = sqliteTable("wg_edges", {
  source: text("source").notNull(),
  target: text("target").notNull(),
})

const wg_item_slices = sqliteTable("wg_item_slices", {
  item_id: text("item_id").notNull(),
  slice_id: text("slice_id").notNull(),
})

const wg_scratchpads = sqliteTable("wg_scratchpads", {
  id: text("id").primaryKey(),
  work_item_id: text("work_item_id").notNull(),
  content: text("content").notNull(),
  priority: text("priority").notNull().default("fyi"),
  needs_review: integer("needs_review").notNull().default(0),
  promoted_to_item_id: text("promoted_to_item_id"),
  dismissed_at: text("dismissed_at"),
  actor: text("actor").notNull(),
  created_at: text("created_at").notNull(),
})

const wg_sync_projection = sqliteTable("wg_sync_projection", {
  binding_key: text("binding_key").primaryKey(),
  provider: text("provider").notNull(),
  provider_meta: text("provider_meta").notNull(),
  last_status: text("last_status"),
  blocked_hash: text("blocked_hash"),
  archive_hash: text("archive_hash"),
  last_synced_at: text("last_synced_at"),
})

// ---------------------------------------------------------------------------
// SQLite implementation of WorkGraphRepo
// ---------------------------------------------------------------------------

class SqliteWorkGraphRepo implements WorkGraphRepo {
  constructor(private db: Db) {}

  close(): void {
    this.db.$client.close()
  }

  // Events

  insertEvent(event: WorkEvent): void {
    this.db.insert(wg_events).values({
      id: event.id,
      seq: event.seq,
      type: event.type,
      payload: event.payload,
      actor: event.actor,
      created_at: event.createdAt,
    }).run()
  }

  getEvents(sinceSeq?: number): WorkEvent[] {
    const rows = sinceSeq != null
      ? this.db.select().from(wg_events).where(gt(wg_events.seq, sinceSeq)).orderBy(asc(wg_events.seq)).all()
      : this.db.select().from(wg_events).orderBy(asc(wg_events.seq)).all()
    return rows.map((r) => ({ id: r.id, seq: r.seq, type: r.type, payload: r.payload, actor: r.actor, createdAt: r.created_at }))
  }

  getMaxSeq(): number {
    const row = this.db.select({ seq: wg_events.seq }).from(wg_events).orderBy(asc(wg_events.seq)).all().at(-1)
    return row?.seq ?? 0
  }

  // Items

  insertItem(item: WorkItem): void {
    this.db.insert(wg_items).values({
      id: item.id,
      source_id: item.sourceId ?? null,
      parent_id: item.parentId ?? null,
      repo_ref: item.repoRef ?? null,
      repo_label: item.repoLabel ?? null,
      title: item.title,
      description: item.description,
      node_type: item.nodeType,
      status: item.status,
      archived_at: item.archivedAt ?? null,
      archived_reason: item.archivedReason ?? null,
      deleted_at: item.deletedAt ?? null,
      deleted_reason: item.deletedReason ?? null,
      labels: JSON.stringify(item.labels),
      context: item.context ?? null,
      provider: item.provider ?? null,
      provider_meta: item.providerMeta ? JSON.stringify(item.providerMeta) : null,
      provider_url: item.providerUrl ?? null,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    }).run()
    if (item.sourceId) this.linkItemSlice(item.id, item.sourceId)
  }

  updateItem(id: string, changes: Omit<Partial<WorkItem>, "updatedAt">): void {
    this.db.update(wg_items).set({
      source_id: changes.sourceId,
      parent_id: changes.parentId,
      repo_ref: changes.repoRef,
      repo_label: changes.repoLabel,
      title: changes.title,
      description: changes.description,
      node_type: changes.nodeType,
      status: changes.status,
      archived_at: changes.archivedAt,
      archived_reason: changes.archivedReason,
      deleted_at: changes.deletedAt,
      deleted_reason: changes.deletedReason,
      labels: changes.labels !== undefined ? JSON.stringify(changes.labels) : undefined,
      context: changes.context,
      provider: changes.provider,
      provider_meta: changes.providerMeta !== undefined ? JSON.stringify(changes.providerMeta) : undefined,
      provider_url: changes.providerUrl,
      updated_at: new Date().toISOString(),
    }).where(eq(wg_items.id, id)).run()
    if (changes.sourceId) this.linkItemSlice(id, changes.sourceId)
  }

  deleteItem(id: string): void {
    this.db.delete(wg_edges).where(or(eq(wg_edges.source, id), eq(wg_edges.target, id))).run()
    this.db.delete(wg_item_slices).where(eq(wg_item_slices.item_id, id)).run()
  }

  getItem(id: string): WorkItem | undefined {
    const row = this.db.select().from(wg_items).where(eq(wg_items.id, id)).get()
    return row ? rowToItem(row) : undefined
  }

  getAllItems(): WorkItem[] {
    return this.db.select().from(wg_items).orderBy(asc(wg_items.created_at)).all().map(rowToItem)
  }

  // Edges

  insertEdge(source: string, target: string): void {
    this.db.insert(wg_edges).values({ source, target }).run()
  }

  deleteEdge(source: string, target: string): void {
    this.db.delete(wg_edges).where(and(eq(wg_edges.source, source), eq(wg_edges.target, target))).run()
  }

  getAllEdges(): WorkEdge[] {
    return this.db.select().from(wg_edges).all().map((r) => ({ source: r.source, target: r.target }))
  }

  // Slices

  linkItemSlice(itemId: string, sliceId: string): void {
    this.db.insert(wg_item_slices).values({ item_id: itemId, slice_id: sliceId }).onConflictDoNothing().run()
  }

  clearItemSlices(itemId: string): void {
    this.db.delete(wg_item_slices).where(eq(wg_item_slices.item_id, itemId)).run()
  }

  getItemSlices(itemId: string): string[] {
    return this.db.select({ slice_id: wg_item_slices.slice_id })
      .from(wg_item_slices)
      .where(eq(wg_item_slices.item_id, itemId))
      .orderBy(asc(wg_item_slices.slice_id))
      .all()
      .map((r) => r.slice_id)
  }

  getSliceItems(sliceId: string): string[] {
    return this.db.select({ item_id: wg_item_slices.item_id })
      .from(wg_item_slices)
      .where(eq(wg_item_slices.slice_id, sliceId))
      .orderBy(asc(wg_item_slices.item_id))
      .all()
      .map((r) => r.item_id)
  }

  // Scratchpads

  insertScratchpad(entry: ScratchpadEntry): void {
    this.db.insert(wg_scratchpads).values({
      id: entry.id,
      work_item_id: entry.workItemId,
      content: entry.content,
      priority: entry.priority,
      needs_review: entry.needsReview ? 1 : 0,
      promoted_to_item_id: entry.promotedToItemId ?? null,
      dismissed_at: entry.dismissedAt ?? null,
      actor: entry.actor,
      created_at: entry.createdAt,
    }).run()
  }

  updateScratchpad(id: string, changes: Partial<ScratchpadEntry>): void {
    this.db.update(wg_scratchpads).set({
      promoted_to_item_id: changes.promotedToItemId,
      dismissed_at: changes.dismissedAt,
    }).where(eq(wg_scratchpads.id, id)).run()
  }

  getScratchpadsByItem(workItemId: string): ScratchpadEntry[] {
    return this.db.select().from(wg_scratchpads)
      .where(eq(wg_scratchpads.work_item_id, workItemId))
      .orderBy(asc(wg_scratchpads.created_at))
      .all()
      .map(rowToScratchpad)
  }

  getScratchpadsNeedingReview(): ScratchpadEntry[] {
    return this.db.select().from(wg_scratchpads)
      .where(and(
        eq(wg_scratchpads.needs_review, 1),
        isNull(wg_scratchpads.promoted_to_item_id),
        isNull(wg_scratchpads.dismissed_at),
      ))
      .orderBy(asc(wg_scratchpads.created_at))
      .all()
      .map(rowToScratchpad)
  }

  getAllScratchpads(): ScratchpadEntry[] {
    return this.db.select().from(wg_scratchpads).orderBy(asc(wg_scratchpads.created_at)).all().map(rowToScratchpad)
  }

  getScratchpad(id: string): ScratchpadEntry | undefined {
    const row = this.db.select().from(wg_scratchpads).where(eq(wg_scratchpads.id, id)).get()
    return row ? rowToScratchpad(row) : undefined
  }

  // Sync projection

  getSyncProjection(key: string): SyncProjection | undefined {
    const row = this.db.select().from(wg_sync_projection).where(eq(wg_sync_projection.binding_key, key)).get()
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

  upsertSyncProjection(input: Omit<SyncProjection, "lastSyncedAt">): void {
    this.db.insert(wg_sync_projection).values({
      binding_key: input.bindingKey,
      provider: input.provider,
      provider_meta: JSON.stringify(input.providerMeta),
      last_status: input.lastStatus ?? null,
      blocked_hash: input.blockedHash ?? null,
      archive_hash: input.archiveHash ?? null,
      last_synced_at: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: wg_sync_projection.binding_key,
      set: {
        provider: input.provider,
        provider_meta: JSON.stringify(input.providerMeta),
        last_status: input.lastStatus ?? null,
        blocked_hash: input.blockedHash ?? null,
        archive_hash: input.archiveHash ?? null,
        last_synced_at: new Date().toISOString(),
      },
    }).run()
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function openSqlite(path?: string): WorkGraphRepo {
  const fresh = !!path && !existsSync(path)
  try {
    return new SqliteWorkGraphRepo(boot(path))
  } catch (err) {
    if (!path || !fresh || !retry(err)) throw err
    wipe(path)
    return new SqliteWorkGraphRepo(boot(path))
  }
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

function boot(path?: string): Db {
  const sqlite = new Database(path ?? ":memory:")
  try {
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA foreign_keys = ON")

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    sqlite.exec(`
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
    ensureColumn(sqlite, "wg_items", "source_id", "ALTER TABLE wg_items ADD COLUMN source_id TEXT")
    ensureColumn(sqlite, "wg_items", "parent_id", "ALTER TABLE wg_items ADD COLUMN parent_id TEXT")
    ensureColumn(sqlite, "wg_items", "repo_ref", "ALTER TABLE wg_items ADD COLUMN repo_ref TEXT")
    ensureColumn(sqlite, "wg_items", "repo_label", "ALTER TABLE wg_items ADD COLUMN repo_label TEXT")
    ensureColumn(sqlite, "wg_items", "node_type", "ALTER TABLE wg_items ADD COLUMN node_type TEXT NOT NULL DEFAULT 'task'")
    ensureColumn(sqlite, "wg_items", "archived_at", "ALTER TABLE wg_items ADD COLUMN archived_at TEXT")
    ensureColumn(sqlite, "wg_items", "archived_reason", "ALTER TABLE wg_items ADD COLUMN archived_reason TEXT")
    ensureColumn(sqlite, "wg_items", "deleted_at", "ALTER TABLE wg_items ADD COLUMN deleted_at TEXT")
    ensureColumn(sqlite, "wg_items", "deleted_reason", "ALTER TABLE wg_items ADD COLUMN deleted_reason TEXT")

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_edges (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        PRIMARY KEY (source, target)
      )
    `)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS wg_item_slices (
        item_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        PRIMARY KEY (item_id, slice_id)
      )
    `)
    sqlite.exec(`
      INSERT OR IGNORE INTO wg_item_slices (item_id, slice_id)
      SELECT id, source_id FROM wg_items WHERE source_id IS NOT NULL
    `)
    sqlite.exec(`
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
    sqlite.exec(`
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

    return drizzle(sqlite)
  } catch (err) {
    try { sqlite.close() } catch {}
    throw err
  }
}

function retry(err: unknown) {
  const txt = err instanceof Error ? err.message : String(err)
  return txt.includes("SQLITE_IOERR_SHORT_READ") || txt.includes("disk I/O error")
}

function wipe(path: string) {
  try { rmSync(path, { force: true }) } catch {}
  try { rmSync(`${path}-shm`, { force: true }) } catch {}
  try { rmSync(`${path}-wal`, { force: true }) } catch {}
}

function ensureColumn(db: Database, table: string, col: string, sql: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (rows.some((row) => row.name === col)) return
  db.exec(sql)
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToItem(row: typeof wg_items.$inferSelect): WorkItem {
  return {
    id: row.id,
    sourceId: row.source_id ?? undefined,
    parentId: row.parent_id ?? null,
    repoRef: row.repo_ref ?? null,
    repoLabel: row.repo_label ?? null,
    title: row.title,
    description: row.description,
    nodeType: (row.node_type ?? "task") as WorkItem["nodeType"],
    status: row.status as WorkItem["status"],
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

function rowToScratchpad(row: typeof wg_scratchpads.$inferSelect): ScratchpadEntry {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    content: row.content,
    priority: row.priority as ScratchpadEntry["priority"],
    needsReview: row.needs_review === 1,
    promotedToItemId: row.promoted_to_item_id ?? undefined,
    dismissedAt: row.dismissed_at ?? undefined,
    actor: row.actor,
    createdAt: row.created_at,
  }
}
