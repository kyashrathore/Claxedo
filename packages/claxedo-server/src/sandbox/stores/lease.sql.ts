/**
 * Drizzle schema + CRUD for workspace lease and hold tables.
 *
 * These tables back the durable workspace authority — one lease row
 * per workspace, many hold rows per workspace.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { eq } from "drizzle-orm"
import { ClaxedoDB } from "../../platform/db"
import type {
  SandboxCheckpointReference,
  SandboxPersistenceCapabilities,
  SandboxRestoreStatus,
} from "@claxedo/sandbox-manager"
import type { SandboxHoldRow, SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"

// ── Drizzle table definitions ──────────────────────────────────────────

export const ClaxedoWorkspaceLeaseTable = sqliteTable(
  "claxedo_workspace_lease",
  {
    workspace_id: text().primaryKey().notNull(),
    lease_id: text().notNull(),
    home_region: text().notNull().default("us-east"),
    epoch: integer().notNull().default(1),
    status: text().notNull().default("pending"),
    driver: text().notNull(),
    driver_resource_id: text(),
    driver_snapshot_id: text(),
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
    labels: text(),
    checkpoint: text(),
    persistence_capabilities: text(),
    restore_status: text(),
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

/**
 * Runs a lease read+write sequence inside a single SQLite transaction so the
 * epoch compare-and-set is genuinely transactional (plan §8: every mutation
 * is transactional or single-statement).
 */
export function leaseTransaction<T>(fn: () => T): T {
  return ClaxedoDB.transaction(() => fn())
}

function rowToLease(row: typeof ClaxedoWorkspaceLeaseTable.$inferSelect): SandboxLeaseRow {
  return {
    workspace_id: row.workspace_id,
    lease_id: row.lease_id,
    home_region: row.home_region,
    epoch: row.epoch,
    status: row.status as SandboxLeaseRow["status"],
    driver: row.driver as SandboxLeaseRow["driver"],
    driver_resource_id: row.driver_resource_id,
    driver_snapshot_id: row.driver_snapshot_id,
    sandbox_id: row.sandbox_id,
    url: row.runtime_url,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at,
    last_heartbeat_at: row.last_heartbeat_at,
    last_activity_at: row.last_activity_at,
    last_health_failure_at: row.last_health_failure_at,
    last_error: row.last_error,
    compute_class: row.compute_class as SandboxLeaseRow["compute_class"],
    accel_base_image_id: row.accel_base_image_id,
    accel_prepared_image_id: row.accel_prepared_image_id,
    accel_snapshot_id: row.accel_runtime_snapshot_id,
    labels: row.labels ? JSON.parse(row.labels) as Record<string, string> : null,
    checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) as SandboxCheckpointReference : null,
    persistence: row.persistence_capabilities
      ? JSON.parse(row.persistence_capabilities) as SandboxPersistenceCapabilities
      : null,
    restore: row.restore_status ? JSON.parse(row.restore_status) as SandboxRestoreStatus : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function getLease(workspaceId: string): SandboxLeaseRow | undefined {
  return ClaxedoDB.use((db) => {
    const row = db
      .select()
      .from(ClaxedoWorkspaceLeaseTable)
      .where(eq(ClaxedoWorkspaceLeaseTable.workspace_id, workspaceId))
      .get()
    return row ? rowToLease(row) : undefined
  })
}

export function listLeases(): SandboxLeaseRow[] {
  return ClaxedoDB.use((db) => {
    return db.select().from(ClaxedoWorkspaceLeaseTable).all().map(rowToLease)
  })
}

export function upsertLease(lease: SandboxLeaseRow): void {
  ClaxedoDB.use((db) => {
    db.insert(ClaxedoWorkspaceLeaseTable)
      .values({
        workspace_id: lease.workspace_id,
        lease_id: lease.lease_id,
        home_region: lease.home_region ?? "us-east",
        epoch: lease.epoch,
        status: lease.status,
        driver: lease.driver,
        driver_resource_id: lease.driver_resource_id,
        driver_snapshot_id: lease.driver_snapshot_id,
        sandbox_id: lease.sandbox_id,
        runtime_url: lease.url,
        retry_count: lease.retry_count,
        next_retry_at: lease.next_retry_at,
        last_heartbeat_at: lease.last_heartbeat_at,
        last_activity_at: lease.last_activity_at,
        last_health_failure_at: lease.last_health_failure_at,
        last_error: lease.last_error,
        compute_class: lease.compute_class,
        accel_base_image_id: lease.accel_base_image_id,
        accel_prepared_image_id: lease.accel_prepared_image_id,
        accel_runtime_snapshot_id: lease.accel_snapshot_id,
        labels: lease.labels ? JSON.stringify(lease.labels) : null,
        checkpoint: lease.checkpoint ? JSON.stringify(lease.checkpoint) : null,
        persistence_capabilities: lease.persistence ? JSON.stringify(lease.persistence) : null,
        restore_status: lease.restore ? JSON.stringify(lease.restore) : null,
        created_at: lease.created_at,
        updated_at: lease.updated_at,
      })
      .onConflictDoUpdate({
        target: ClaxedoWorkspaceLeaseTable.workspace_id,
        set: {
          lease_id: lease.lease_id,
          home_region: lease.home_region ?? "us-east",
          epoch: lease.epoch,
          status: lease.status,
          driver: lease.driver,
          driver_resource_id: lease.driver_resource_id,
          driver_snapshot_id: lease.driver_snapshot_id,
          sandbox_id: lease.sandbox_id,
          runtime_url: lease.url,
          retry_count: lease.retry_count,
          next_retry_at: lease.next_retry_at,
          last_heartbeat_at: lease.last_heartbeat_at,
          last_activity_at: lease.last_activity_at,
          last_health_failure_at: lease.last_health_failure_at,
          last_error: lease.last_error,
          compute_class: lease.compute_class,
          accel_base_image_id: lease.accel_base_image_id,
          accel_prepared_image_id: lease.accel_prepared_image_id,
          accel_runtime_snapshot_id: lease.accel_snapshot_id,
          labels: lease.labels ? JSON.stringify(lease.labels) : null,
          checkpoint: lease.checkpoint ? JSON.stringify(lease.checkpoint) : null,
          persistence_capabilities: lease.persistence ? JSON.stringify(lease.persistence) : null,
          restore_status: lease.restore ? JSON.stringify(lease.restore) : null,
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

function rowToHold(row: typeof ClaxedoWorkspaceHoldTable.$inferSelect): SandboxHoldRow {
  return {
    hold_id: row.hold_id,
    workspace_id: row.workspace_id,
    owner_type: row.owner_type as SandboxHoldRow["owner_type"],
    owner_id: row.owner_id,
    reason: row.reason,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
  }
}

export function getHold(holdId: string): SandboxHoldRow | undefined {
  return ClaxedoDB.use((db) => {
    const row = db
      .select()
      .from(ClaxedoWorkspaceHoldTable)
      .where(eq(ClaxedoWorkspaceHoldTable.hold_id, holdId))
      .get()
    return row ? rowToHold(row) : undefined
  })
}

export function getHoldsByWorkspace(workspaceId: string): SandboxHoldRow[] {
  return ClaxedoDB.use((db) => {
    return db
      .select()
      .from(ClaxedoWorkspaceHoldTable)
      .where(eq(ClaxedoWorkspaceHoldTable.workspace_id, workspaceId))
      .all()
      .map(rowToHold)
  })
}

export function upsertHold(hold: SandboxHoldRow): void {
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
