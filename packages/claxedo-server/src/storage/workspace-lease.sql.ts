/**
 * Drizzle schema + CRUD for workspace lease and hold tables.
 *
 * These tables back the durable workspace authority — one lease row
 * per workspace, many hold rows per workspace.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { eq } from "drizzle-orm"
import { ClaxedoDB } from "./db"
import type { WorkspaceLease, WorkspaceHold } from "../cloud/authority-types"

// ── Drizzle table definitions ──────────────────────────────────────────

export const ClaxedoWorkspaceLeaseTable = sqliteTable(
  "claxedo_workspace_lease",
  {
    workspace_id: text().primaryKey().notNull(),
    lease_id: text().notNull(),
    epoch: integer().notNull().default(1),
    status: text().notNull().default("pending"),
    provider: text().notNull(),
    provider_object_id: text(),
    provider_snapshot_id: text(),
    sandbox_id: text(),
    runtime_url: text(),
    retry_count: integer().notNull().default(0),
    next_retry_at: integer(),
    last_heartbeat_at: integer(),
    last_activity_at: integer(),
    last_health_failure_at: integer(),
    last_error: text(),
    compute_class: text(),
    accel_base_image_id: text(),
    accel_prepared_image_id: text(),
    accel_runtime_snapshot_id: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_workspace_lease_status_idx").on(table.status),
    index("claxedo_workspace_lease_sandbox_idx").on(table.sandbox_id),
    index("claxedo_workspace_lease_updated_idx").on(table.updated_at),
  ],
)

export const ClaxedoWorkspaceHoldTable = sqliteTable(
  "claxedo_workspace_hold",
  {
    hold_id: text().primaryKey().notNull(),
    workspace_id: text().notNull(),
    owner_type: text().notNull(),
    owner_id: text().notNull(),
    reason: text().notNull(),
    expires_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_workspace_hold_workspace_idx").on(table.workspace_id),
    index("claxedo_workspace_hold_expires_idx").on(table.expires_at),
  ],
)

// ── Lease CRUD ─────────────────────────────────────────────────────────

function rowToLease(row: typeof ClaxedoWorkspaceLeaseTable.$inferSelect): WorkspaceLease {
  return {
    workspace_id: row.workspace_id,
    lease_id: row.lease_id,
    epoch: row.epoch,
    status: row.status as WorkspaceLease["status"],
    provider: row.provider as WorkspaceLease["provider"],
    provider_object_id: row.provider_object_id,
    provider_snapshot_id: row.provider_snapshot_id,
    sandbox_id: row.sandbox_id,
    runtime_url: row.runtime_url,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at,
    last_heartbeat_at: row.last_heartbeat_at,
    last_activity_at: row.last_activity_at,
    last_health_failure_at: row.last_health_failure_at,
    last_error: row.last_error,
    compute_class: row.compute_class as WorkspaceLease["compute_class"],
    accel_base_image_id: row.accel_base_image_id,
    accel_prepared_image_id: row.accel_prepared_image_id,
    accel_runtime_snapshot_id: row.accel_runtime_snapshot_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function getLease(workspaceId: string): WorkspaceLease | undefined {
  return ClaxedoDB.use((db) => {
    const row = db
      .select()
      .from(ClaxedoWorkspaceLeaseTable)
      .where(eq(ClaxedoWorkspaceLeaseTable.workspace_id, workspaceId))
      .get()
    return row ? rowToLease(row) : undefined
  })
}

export function listLeases(): WorkspaceLease[] {
  return ClaxedoDB.use((db) => {
    return db.select().from(ClaxedoWorkspaceLeaseTable).all().map(rowToLease)
  })
}

export function upsertLease(lease: WorkspaceLease): void {
  ClaxedoDB.use((db) => {
    db.insert(ClaxedoWorkspaceLeaseTable)
      .values({
        workspace_id: lease.workspace_id,
        lease_id: lease.lease_id,
        epoch: lease.epoch,
        status: lease.status,
        provider: lease.provider,
        provider_object_id: lease.provider_object_id,
        provider_snapshot_id: lease.provider_snapshot_id,
        sandbox_id: lease.sandbox_id,
        runtime_url: lease.runtime_url,
        retry_count: lease.retry_count,
        next_retry_at: lease.next_retry_at,
        last_heartbeat_at: lease.last_heartbeat_at,
        last_activity_at: lease.last_activity_at,
        last_health_failure_at: lease.last_health_failure_at,
        last_error: lease.last_error,
        compute_class: lease.compute_class,
        accel_base_image_id: lease.accel_base_image_id,
        accel_prepared_image_id: lease.accel_prepared_image_id,
        accel_runtime_snapshot_id: lease.accel_runtime_snapshot_id,
        created_at: lease.created_at,
        updated_at: lease.updated_at,
      })
      .onConflictDoUpdate({
        target: ClaxedoWorkspaceLeaseTable.workspace_id,
        set: {
          lease_id: lease.lease_id,
          epoch: lease.epoch,
          status: lease.status,
          provider: lease.provider,
          provider_object_id: lease.provider_object_id,
          provider_snapshot_id: lease.provider_snapshot_id,
          sandbox_id: lease.sandbox_id,
          runtime_url: lease.runtime_url,
          retry_count: lease.retry_count,
          next_retry_at: lease.next_retry_at,
          last_heartbeat_at: lease.last_heartbeat_at,
          last_activity_at: lease.last_activity_at,
          last_health_failure_at: lease.last_health_failure_at,
          last_error: lease.last_error,
          compute_class: lease.compute_class,
          accel_base_image_id: lease.accel_base_image_id,
          accel_prepared_image_id: lease.accel_prepared_image_id,
          accel_runtime_snapshot_id: lease.accel_runtime_snapshot_id,
          updated_at: lease.updated_at,
        },
      })
      .run()
  })
}

export function deleteLease(workspaceId: string): void {
  ClaxedoDB.use((db) => {
    db.delete(ClaxedoWorkspaceLeaseTable)
      .where(eq(ClaxedoWorkspaceLeaseTable.workspace_id, workspaceId))
      .run()
  })
}

// ── Hold CRUD ──────────────────────────────────────────────────────────

function rowToHold(row: typeof ClaxedoWorkspaceHoldTable.$inferSelect): WorkspaceHold {
  return {
    hold_id: row.hold_id,
    workspace_id: row.workspace_id,
    owner_type: row.owner_type as WorkspaceHold["owner_type"],
    owner_id: row.owner_id,
    reason: row.reason,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
  }
}

export function getHold(holdId: string): WorkspaceHold | undefined {
  return ClaxedoDB.use((db) => {
    const row = db
      .select()
      .from(ClaxedoWorkspaceHoldTable)
      .where(eq(ClaxedoWorkspaceHoldTable.hold_id, holdId))
      .get()
    return row ? rowToHold(row) : undefined
  })
}

export function getHoldsByWorkspace(workspaceId: string): WorkspaceHold[] {
  return ClaxedoDB.use((db) => {
    return db
      .select()
      .from(ClaxedoWorkspaceHoldTable)
      .where(eq(ClaxedoWorkspaceHoldTable.workspace_id, workspaceId))
      .all()
      .map(rowToHold)
  })
}

export function upsertHold(hold: WorkspaceHold): void {
  ClaxedoDB.use((db) => {
    db.insert(ClaxedoWorkspaceHoldTable)
      .values({
        hold_id: hold.hold_id,
        workspace_id: hold.workspace_id,
        owner_type: hold.owner_type,
        owner_id: hold.owner_id,
        reason: hold.reason,
        expires_at: hold.expires_at,
        updated_at: hold.updated_at,
      })
      .onConflictDoUpdate({
        target: ClaxedoWorkspaceHoldTable.hold_id,
        set: {
          owner_type: hold.owner_type,
          owner_id: hold.owner_id,
          reason: hold.reason,
          expires_at: hold.expires_at,
          updated_at: hold.updated_at,
        },
      })
      .run()
  })
}

export function deleteHold(holdId: string): void {
  ClaxedoDB.use((db) => {
    db.delete(ClaxedoWorkspaceHoldTable)
      .where(eq(ClaxedoWorkspaceHoldTable.hold_id, holdId))
      .run()
  })
}

export function deleteHoldsByWorkspace(workspaceId: string): void {
  ClaxedoDB.use((db) => {
    db.delete(ClaxedoWorkspaceHoldTable)
      .where(eq(ClaxedoWorkspaceHoldTable.workspace_id, workspaceId))
      .run()
  })
}
