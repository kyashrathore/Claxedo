import { randomUUID } from "crypto"
import type { SandboxLease, SandboxTarget } from "@claxedo/sandbox-manager"
import { nextSandboxRetryAt } from "@claxedo/sandbox-manager/lease-policy"
import type { SandboxHoldRow, SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"
import {
  deleteHold,
  deleteHoldsByWorkspace,
  deleteLease,
  getHoldsByWorkspace,
  getLease,
  listLeases,
  upsertHold,
  upsertLease,
} from "./lease.sql"
import { createSqliteLeaseStore } from "./sqlite"
import { sandboxLeaseStatus } from "./lease-status"
export { sandboxLeaseStatus }

// SQLite-only compatibility adapter for local supervisor row/hold state.
// Keep raw row operations here so workspace-supervisor does not become a
// parallel sandbox lease authority. New lifecycle decisions belong in
// SandboxManager and SandboxLeaseStore.

export type SupervisorSandboxLeaseResult = { ok: true; lease: SandboxLeaseRow } | { ok: false; error: string }

export function createSupervisorSandboxLeaseStore() {
  return createSqliteLeaseStore()
}

export function getSupervisorSandboxLease(workspaceId: string) {
  return getLease(workspaceId)
}

export function listSupervisorSandboxLeases() {
  return listLeases()
}

export function sandboxLeaseUrl(lease: SandboxLeaseRow | undefined) {
  return lease?.url ?? undefined
}

export function sandboxTargetFromLease(lease: SandboxLeaseRow | undefined): SandboxTarget | undefined {
  const sandboxId = lease?.sandbox_id ?? lease?.driver_resource_id
  const hostId = lease?.lease_id || sandboxId
  const url = sandboxLeaseUrl(lease)
  if (!lease || !url || !sandboxId || !hostId) return
  return {
    workspaceId: lease.workspace_id,
    sandboxId,
    url,
    hostId,
    driverResourceId: lease.driver_resource_id ?? sandboxId,
    driver: {
      id: lease.driver,
      resourceId: lease.driver_resource_id ?? sandboxId,
    },
  }
}

export function sandboxLeaseFromRow(lease: SandboxLeaseRow): SandboxLease {
  return {
    workspaceId: lease.workspace_id,
    homeRegion: (lease.home_region ?? "us-east") as SandboxLease["homeRegion"],
    driver: lease.driver,
    epoch: lease.epoch,
    status: sandboxLeaseStatus(lease.status),
    retryCount: lease.retry_count,
    updatedAt: lease.updated_at,
    createdAt: lease.created_at,
    sandboxId: lease.sandbox_id ?? undefined,
    url: sandboxLeaseUrl(lease),
    hostId: lease.lease_id || undefined,
    driverResourceId: lease.driver_resource_id ?? undefined,
    nextRetryAt: lease.next_retry_at ?? undefined,
    lastError: lease.last_error ?? undefined,
    lastHeartbeatAt: lease.last_heartbeat_at ?? undefined,
    lastActivityAt: lease.last_activity_at ?? undefined,
    labels: lease.labels ?? undefined,
    checkpoint: lease.checkpoint ?? undefined,
    persistence: lease.persistence ?? undefined,
    restore: lease.restore ?? undefined,
  }
}



export function pendingSandboxLease(
  workspaceId: string,
  driver: SandboxLeaseRow["driver"],
  timestamp = Date.now(),
): SandboxLeaseRow {
  return {
    workspace_id: workspaceId,
    lease_id: "",
    epoch: 0,
    status: "pending",
    driver,
    driver_resource_id: null,
    driver_snapshot_id: null,
    sandbox_id: null,
    url: null,
    retry_count: 0,
    next_retry_at: null,
    last_heartbeat_at: null,
    last_activity_at: null,
    last_health_failure_at: null,
    last_error: null,
    compute_class: null,
    accel_base_image_id: null,
    accel_prepared_image_id: null,
    accel_snapshot_id: null,
    labels: null,
    checkpoint: null,
    persistence: null,
    restore: null,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

export function updateSupervisorSandboxLease(workspaceId: string, patch: Partial<SandboxLeaseRow>) {
  const prev = getLease(workspaceId)
  if (!prev) return
  const next = { ...prev, ...patch, updated_at: Date.now() }
  upsertLease(next)
  return next
}

export function releaseSupervisorSandboxLease(workspaceId: string) {
  const had = !!getLease(workspaceId)
  deleteLease(workspaceId)
  deleteHoldsByWorkspace(workspaceId)
  return had
}

export function acquireSupervisorSandboxHold(
  workspaceId: string,
  ownerType: SandboxHoldRow["owner_type"],
  ownerId: string,
  reason: string,
  expiresAt?: number,
) {
  const hold = {
    hold_id: randomUUID(),
    workspace_id: workspaceId,
    owner_type: ownerType,
    owner_id: ownerId,
    reason,
    expires_at: expiresAt ?? null,
    updated_at: Date.now(),
  } satisfies SandboxHoldRow
  upsertHold(hold)
  return hold
}

export function releaseSupervisorSandboxHold(holdId: string) {
  deleteHold(holdId)
}

export function cleanExpiredSupervisorSandboxHolds(workspaceId: string) {
  const now = Date.now()
  const expired = getHoldsByWorkspace(workspaceId)
    .filter((hold) => hold.expires_at !== null && hold.expires_at <= now)
  for (const hold of expired) deleteHold(hold.hold_id)
  return expired.length
}

export function markSupervisorSandboxLeaseFailed(workspaceId: string, error: string): SupervisorSandboxLeaseResult {
  const lease = updateSupervisorSandboxLease(workspaceId, {
    status: "failed",
    last_error: error,
    next_retry_at: null,
  })
  if (!lease) return { ok: false, error: "workspace not found" }
  return { ok: true, lease }
}

export function recordSupervisorSandboxLeaseFailure(
  workspaceId: string,
  error: string,
  nextRetryAt: number | null,
): SandboxLeaseRow | undefined {
  const prev = getLease(workspaceId)
  if (!prev) return
  return updateSupervisorSandboxLease(workspaceId, {
    status: nextRetryAt ? "backoff" : "failed",
    retry_count: prev.retry_count + 1,
    next_retry_at: nextRetryAt,
    last_error: error,
    last_health_failure_at: Date.now(),
  })
}

export function recordSupervisorSandboxStartFailure(workspaceId: string, error: string): SupervisorSandboxLeaseResult {
  const lease = getLease(workspaceId)
  if (!lease) return { ok: false, error: "workspace not found" }
  const updated = recordSupervisorSandboxLeaseFailure(workspaceId, error, nextSandboxRetryAt(lease.retry_count + 1, Date.now()))
  if (!updated) return { ok: false, error: "workspace not found" }
  return { ok: true, lease: updated }
}

export function recordSupervisorSandboxLeaseReady(input: {
  workspaceId: string
  driver: SandboxLeaseRow["driver"]
  sandboxId?: string | null
  url: string
  hostId?: string | null
  driverResourceId?: string | null
}) {
  const ts = Date.now()
  const prev = getLease(input.workspaceId)
  const lease: SandboxLeaseRow = {
    workspace_id: input.workspaceId,
    lease_id: input.hostId ?? prev?.lease_id ?? randomUUID(),
    home_region: prev?.home_region ?? "us-east",
    epoch: prev?.epoch ?? 1,
    status: "ready",
    driver: prev?.driver ?? input.driver,
    driver_resource_id: input.driverResourceId ?? prev?.driver_resource_id ?? input.sandboxId ?? null,
    driver_snapshot_id: prev?.driver_snapshot_id ?? null,
    sandbox_id: input.sandboxId ?? prev?.sandbox_id ?? null,
    url: input.url,
    retry_count: 0,
    next_retry_at: null,
    last_heartbeat_at: ts,
    last_activity_at: ts,
    last_health_failure_at: prev?.last_health_failure_at ?? null,
    last_error: null,
    compute_class: prev?.compute_class ?? null,
    accel_base_image_id: prev?.accel_base_image_id ?? null,
    accel_prepared_image_id: prev?.accel_prepared_image_id ?? null,
    accel_snapshot_id: prev?.accel_snapshot_id ?? null,
    checkpoint: prev?.checkpoint ?? null,
    persistence: prev?.persistence ?? null,
    restore: prev?.restore ?? null,
    created_at: prev?.created_at ?? ts,
    updated_at: ts,
  }
  upsertLease(lease)
  return lease
}
