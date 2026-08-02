/**
 * Drizzle schema + CRUD for prepared image and runtime snapshot tables.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { eq, and, desc } from "drizzle-orm"
import { ClaxedoDB } from "./db"

// ── Drizzle table definitions ──────────────────────────────────────────

export const ClaxedoPreparedImageTable = sqliteTable(
  "claxedo_prepared_image",
  {
    id: text().primaryKey().notNull(),
    workspace_key: text().notNull(),
    base_image_id: text().notNull(),
    prepared_image_id: text(),
    source_ref: text(),
    source_sha: text(),
    runtime_fingerprint: text(),
    profile_hash: text(),
    status: text().notNull().default("pending"),
    build_error: text(),
    build_duration_ms: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_prepared_image_workspace_key_idx").on(table.workspace_key),
    index("claxedo_prepared_image_status_idx").on(table.status),
    index("claxedo_prepared_image_updated_idx").on(table.updated_at),
  ],
)

export const ClaxedoRuntimeSnapshotTable = sqliteTable(
  "claxedo_runtime_snapshot",
  {
    id: text().primaryKey().notNull(),
    workspace_id: text().notNull(),
    runtime_snapshot_id: text().notNull(),
    driver_snapshot_id: text(),
    base_prepared_image_id: text(),
    source_sha: text(),
    reason: text().notNull(),
    size_bytes: integer(),
    status: text().notNull().default("pending"),
    created_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_runtime_snapshot_workspace_idx").on(table.workspace_id),
    index("claxedo_runtime_snapshot_status_idx").on(table.status),
  ],
)

// ── Type exports ───────────────────────────────────────────────────────

export type PreparedImageStatus = "pending" | "building" | "ready" | "failed" | "expired"
export type SnapshotStatus = "pending" | "capturing" | "ready" | "failed" | "expired"

export type PreparedImage = {
  id: string
  workspace_key: string
  base_image_id: string
  prepared_image_id: string | null
  source_ref: string | null
  source_sha: string | null
  runtime_fingerprint: string | null
  profile_hash: string | null
  status: PreparedImageStatus
  build_error: string | null
  build_duration_ms: number | null
  created_at: number
  updated_at: number
}

export type RuntimeSnapshot = {
  id: string
  workspace_id: string
  runtime_snapshot_id: string
  driver_snapshot_id: string | null
  base_prepared_image_id: string | null
  source_sha: string | null
  reason: string
  size_bytes: number | null
  status: SnapshotStatus
  created_at: number
}

function rowToSnapshot(row: typeof ClaxedoRuntimeSnapshotTable.$inferSelect): RuntimeSnapshot {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    runtime_snapshot_id: row.runtime_snapshot_id,
    driver_snapshot_id: row.driver_snapshot_id,
    base_prepared_image_id: row.base_prepared_image_id,
    source_sha: row.source_sha,
    reason: row.reason,
    size_bytes: row.size_bytes,
    status: row.status as SnapshotStatus,
    created_at: row.created_at,
  }
}

function snapshotToRow(snapshot: RuntimeSnapshot): typeof ClaxedoRuntimeSnapshotTable.$inferInsert {
  return {
    id: snapshot.id,
    workspace_id: snapshot.workspace_id,
    runtime_snapshot_id: snapshot.runtime_snapshot_id,
    driver_snapshot_id: snapshot.driver_snapshot_id,
    base_prepared_image_id: snapshot.base_prepared_image_id,
    source_sha: snapshot.source_sha,
    reason: snapshot.reason,
    size_bytes: snapshot.size_bytes,
    status: snapshot.status,
    created_at: snapshot.created_at,
  }
}

// ── Prepared image CRUD ────────────────────────────────────────────────

export function getPreparedImage(id: string): PreparedImage | undefined {
  return ClaxedoDB.use((db) => {
    return db
      .select()
      .from(ClaxedoPreparedImageTable)
      .where(eq(ClaxedoPreparedImageTable.id, id))
      .get() as PreparedImage | undefined
  })
}

export function getLatestPreparedImage(workspaceKey: string): PreparedImage | undefined {
  return ClaxedoDB.use((db) => {
    return db
      .select()
      .from(ClaxedoPreparedImageTable)
      .where(
        and(
          eq(ClaxedoPreparedImageTable.workspace_key, workspaceKey),
          eq(ClaxedoPreparedImageTable.status, "ready"),
        ),
      )
      .orderBy(desc(ClaxedoPreparedImageTable.created_at))
      .limit(1)
      .get() as PreparedImage | undefined
  })
}

export function listPreparedImages(workspaceKey: string): PreparedImage[] {
  return ClaxedoDB.use((db) => {
    return db
      .select()
      .from(ClaxedoPreparedImageTable)
      .where(eq(ClaxedoPreparedImageTable.workspace_key, workspaceKey))
      .orderBy(desc(ClaxedoPreparedImageTable.created_at))
      .all() as PreparedImage[]
  })
}

export function upsertPreparedImage(image: PreparedImage): void {
  ClaxedoDB.use((db) => {
    db.insert(ClaxedoPreparedImageTable)
      .values(image)
      .onConflictDoUpdate({
        target: ClaxedoPreparedImageTable.id,
        set: {
          prepared_image_id: image.prepared_image_id,
          source_ref: image.source_ref,
          source_sha: image.source_sha,
          runtime_fingerprint: image.runtime_fingerprint,
          profile_hash: image.profile_hash,
          status: image.status,
          build_error: image.build_error,
          build_duration_ms: image.build_duration_ms,
          updated_at: image.updated_at,
        },
      })
      .run()
  })
}

export function deletePreparedImage(id: string): void {
  ClaxedoDB.use((db) => {
    db.delete(ClaxedoPreparedImageTable)
      .where(eq(ClaxedoPreparedImageTable.id, id))
      .run()
  })
}

// ── Runtime snapshot CRUD ──────────────────────────────────────────────

export function getSnapshot(id: string): RuntimeSnapshot | undefined {
  return ClaxedoDB.use((db) => {
    const row = db
      .select()
      .from(ClaxedoRuntimeSnapshotTable)
      .where(eq(ClaxedoRuntimeSnapshotTable.id, id))
      .get()
    return row ? rowToSnapshot(row) : undefined
  })
}

export function getLatestSnapshot(workspaceId: string): RuntimeSnapshot | undefined {
  return ClaxedoDB.use((db) => {
    const row = db
      .select()
      .from(ClaxedoRuntimeSnapshotTable)
      .where(
        and(
          eq(ClaxedoRuntimeSnapshotTable.workspace_id, workspaceId),
          eq(ClaxedoRuntimeSnapshotTable.status, "ready"),
        ),
      )
      .orderBy(desc(ClaxedoRuntimeSnapshotTable.created_at))
      .limit(1)
      .get()
    return row ? rowToSnapshot(row) : undefined
  })
}

export function listSnapshots(workspaceId: string): RuntimeSnapshot[] {
  return ClaxedoDB.use((db) => {
    return db
      .select()
      .from(ClaxedoRuntimeSnapshotTable)
      .where(eq(ClaxedoRuntimeSnapshotTable.workspace_id, workspaceId))
      .orderBy(desc(ClaxedoRuntimeSnapshotTable.created_at))
      .all()
      .map(rowToSnapshot)
  })
}

export function insertSnapshot(snapshot: RuntimeSnapshot): void {
  ClaxedoDB.use((db) => {
    db.insert(ClaxedoRuntimeSnapshotTable)
      .values(snapshotToRow(snapshot))
      .run()
  })
}

export function updateSnapshotStatus(id: string, status: SnapshotStatus): void {
  ClaxedoDB.use((db) => {
    db.update(ClaxedoRuntimeSnapshotTable)
      .set({ status })
      .where(eq(ClaxedoRuntimeSnapshotTable.id, id))
      .run()
  })
}

export function deleteSnapshot(id: string): void {
  ClaxedoDB.use((db) => {
    db.delete(ClaxedoRuntimeSnapshotTable)
      .where(eq(ClaxedoRuntimeSnapshotTable.id, id))
      .run()
  })
}

export function deleteSnapshotsByWorkspace(workspaceId: string): void {
  ClaxedoDB.use((db) => {
    db.delete(ClaxedoRuntimeSnapshotTable)
      .where(eq(ClaxedoRuntimeSnapshotTable.workspace_id, workspaceId))
      .run()
  })
}
