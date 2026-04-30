/**
 * WorkspaceAuthority — per-workspace durable state manager.
 *
 * This is the "live brain" for one workspace. It owns:
 * - lease state (epoch, sandbox identity, status, retry)
 * - explicit holds
 * - heartbeat validation
 * - reconnect acceptance/rejection
 *
 * Persistence is delegated to the lease-store (SQLite).
 * Side effects (provider calls, broadcasts) are NOT done here —
 * the lifecycle decision engine and supervisor handle those.
 */

import { randomUUID } from "crypto"
import type {
  WorkspaceLease,
  WorkspaceHold,
  LeaseStatus,
  EpochEnvelope,
  HeartbeatResult,
  ReconnectResult,
  AcquireResult,
  HoldOwnerType,
  AuthorityEvent,
} from "./authority-types"
import * as leaseStore from "../storage/workspace-lease.sql"

type Subscriber = (event: AuthorityEvent) => void

const subscribers = new Set<Subscriber>()

function emit(event: AuthorityEvent) {
  for (const fn of subscribers) {
    try { fn(event) } catch {}
  }
}

export function subscribe(fn: Subscriber) {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

// ── Lease operations ───────────────────────────────────────────────────

export function getLease(workspaceId: string): WorkspaceLease | undefined {
  return leaseStore.getLease(workspaceId)
}

export function listLeases(): WorkspaceLease[] {
  return leaseStore.listLeases()
}

export function listActiveLeases(): WorkspaceLease[] {
  return leaseStore.listLeases().filter(
    (l) => l.status !== "stopped" && l.status !== "failed",
  )
}

/**
 * Acquire or re-acquire ownership of a workspace.
 * Bumps epoch on every acquisition — this is the fencing boundary.
 */
export function acquire(
  workspaceId: string,
  input: Pick<WorkspaceLease, "provider" | "compute_class">,
): AcquireResult {
  const existing = leaseStore.getLease(workspaceId)
  const now = Date.now()

  if (existing) {
    const old_epoch = existing.epoch
    const new_epoch = old_epoch + 1
    const lease: WorkspaceLease = {
      ...existing,
      epoch: new_epoch,
      status: "acquiring",
      provider: input.provider,
      compute_class: input.compute_class,
      retry_count: 0,
      next_retry_at: null,
      last_error: null,
      updated_at: now,
    }
    leaseStore.upsertLease(lease)
    emit({ type: "epoch_bumped", workspace_id: workspaceId, old_epoch, new_epoch })
    emit({ type: "lease_updated", lease, changed: ["epoch", "status", "provider", "compute_class"] })
    return { lease, bumped_epoch: true }
  }

  const lease: WorkspaceLease = {
    workspace_id: workspaceId,
    lease_id: randomUUID(),
    epoch: 1,
    status: "acquiring",
    provider: input.provider,
    provider_object_id: null,
    provider_snapshot_id: null,
    sandbox_id: null,
    runtime_url: null,
    retry_count: 0,
    next_retry_at: null,
    last_heartbeat_at: null,
    last_activity_at: null,
    last_health_failure_at: null,
    last_error: null,
    compute_class: input.compute_class,
    accel_base_image_id: null,
    accel_prepared_image_id: null,
    accel_runtime_snapshot_id: null,
    created_at: now,
    updated_at: now,
  }
  leaseStore.upsertLease(lease)
  emit({ type: "lease_acquired", lease })
  return { lease, bumped_epoch: false }
}

/**
 * Update specific fields on an existing lease.
 * Returns the updated lease or undefined if not found.
 */
export function updateLease(
  workspaceId: string,
  patch: Partial<Omit<WorkspaceLease, "workspace_id" | "lease_id" | "epoch" | "created_at">>,
): WorkspaceLease | undefined {
  const existing = leaseStore.getLease(workspaceId)
  if (!existing) return undefined

  const changed: (keyof WorkspaceLease)[] = []
  for (const [k, v] of Object.entries(patch)) {
    if ((existing as any)[k] !== v) changed.push(k as keyof WorkspaceLease)
  }
  if (changed.length === 0) return existing

  const lease: WorkspaceLease = {
    ...existing,
    ...patch,
    updated_at: Date.now(),
  }
  leaseStore.upsertLease(lease)
  if (changed.length > 0) {
    emit({ type: "lease_updated", lease, changed })
  }
  return lease
}

/**
 * Transition lease status with side-effect tracking.
 */
export function transition(
  workspaceId: string,
  status: LeaseStatus,
  extra?: Partial<Omit<WorkspaceLease, "workspace_id" | "lease_id" | "epoch" | "created_at" | "status">>,
): WorkspaceLease | undefined {
  return updateLease(workspaceId, { status, ...extra })
}

/**
 * Record a sandbox assignment on the lease.
 */
export function assignSandbox(
  workspaceId: string,
  sandboxId: string,
  runtimeUrl: string | null,
  providerObjectId: string | null,
): WorkspaceLease | undefined {
  return updateLease(workspaceId, {
    sandbox_id: sandboxId,
    runtime_url: runtimeUrl,
    provider_object_id: providerObjectId,
    status: "starting",
  })
}

/**
 * Mark workspace as ready.
 */
export function markReady(workspaceId: string, runtimeUrl: string): WorkspaceLease | undefined {
  return updateLease(workspaceId, {
    status: "ready",
    runtime_url: runtimeUrl,
    retry_count: 0,
    next_retry_at: null,
    last_error: null,
    last_heartbeat_at: Date.now(),
    last_activity_at: Date.now(),
  })
}

/**
 * Record a crash/failure and apply backoff.
 */
export function recordFailure(
  workspaceId: string,
  error: string,
  nextRetryAt: number | null,
): WorkspaceLease | undefined {
  const existing = leaseStore.getLease(workspaceId)
  if (!existing) return undefined
  return updateLease(workspaceId, {
    status: nextRetryAt ? "backoff" : "failed",
    retry_count: existing.retry_count + 1,
    next_retry_at: nextRetryAt,
    last_error: error,
    last_health_failure_at: Date.now(),
  })
}

/**
 * Release a lease (workspace deleted or permanently stopped).
 */
export function releaseLease(workspaceId: string, reason: string): boolean {
  const existing = leaseStore.getLease(workspaceId)
  if (!existing) return false
  leaseStore.deleteLease(workspaceId)
  leaseStore.deleteHoldsByWorkspace(workspaceId)
  emit({ type: "lease_released", workspace_id: workspaceId, reason })
  return true
}

// ── Epoch fencing ──────────────────────────────────────────────────────

/**
 * Validate an epoch-fenced heartbeat from a workspace-host.
 */
export function heartbeat(envelope: EpochEnvelope): HeartbeatResult {
  const lease = leaseStore.getLease(envelope.workspace_id)
  if (!lease) return { accepted: false, reason: "unknown_workspace" }
  if (lease.lease_id !== envelope.lease_id) return { accepted: false, reason: "wrong_lease" }
  if (lease.epoch !== envelope.epoch) {
    emit({
      type: "heartbeat_rejected",
      workspace_id: envelope.workspace_id,
      envelope,
      reason: "stale_epoch",
    })
    return { accepted: false, reason: "stale_epoch" }
  }
  updateLease(envelope.workspace_id, {
    last_heartbeat_at: Date.now(),
    last_activity_at: Date.now(),
  })
  return { accepted: true }
}

/**
 * Validate a reconnect from a workspace-host after restart.
 */
export function reconnect(envelope: EpochEnvelope): ReconnectResult {
  const lease = leaseStore.getLease(envelope.workspace_id)
  if (!lease) return { accepted: false, reason: "unknown_workspace" }
  if (lease.lease_id !== envelope.lease_id) return { accepted: false, reason: "wrong_lease" }
  if (lease.epoch !== envelope.epoch) return { accepted: false, reason: "stale_epoch" }
  if (lease.sandbox_id !== envelope.sandbox_id) return { accepted: false, reason: "wrong_sandbox" }
  updateLease(envelope.workspace_id, {
    last_heartbeat_at: Date.now(),
  })
  return { accepted: true, lease }
}

// ── Hold operations ────────────────────────────────────────────────────

export function acquireHold(
  workspaceId: string,
  ownerType: HoldOwnerType,
  ownerId: string,
  reason: string,
  expiresAt?: number,
): WorkspaceHold {
  const hold: WorkspaceHold = {
    hold_id: randomUUID(),
    workspace_id: workspaceId,
    owner_type: ownerType,
    owner_id: ownerId,
    reason,
    expires_at: expiresAt ?? null,
    updated_at: Date.now(),
  }
  leaseStore.upsertHold(hold)
  emit({ type: "hold_acquired", hold })
  return hold
}

export function releaseHold(holdId: string): boolean {
  const hold = leaseStore.getHold(holdId)
  if (!hold) return false
  leaseStore.deleteHold(holdId)
  emit({ type: "hold_released", hold_id: holdId, workspace_id: hold.workspace_id })
  return true
}

export function getHolds(workspaceId: string): WorkspaceHold[] {
  return leaseStore.getHoldsByWorkspace(workspaceId)
}

export function getActiveHoldCount(workspaceId: string): number {
  const now = Date.now()
  return leaseStore.getHoldsByWorkspace(workspaceId)
    .filter((h) => !h.expires_at || h.expires_at > now)
    .length
}

/**
 * Clean up expired holds for a workspace.
 * Returns the number of holds removed.
 */
export function cleanExpiredHolds(workspaceId: string): number {
  const now = Date.now()
  const holds = leaseStore.getHoldsByWorkspace(workspaceId)
  let removed = 0
  for (const hold of holds) {
    if (hold.expires_at && hold.expires_at <= now) {
      leaseStore.deleteHold(hold.hold_id)
      emit({ type: "hold_released", hold_id: hold.hold_id, workspace_id: workspaceId })
      removed++
    }
  }
  return removed
}
