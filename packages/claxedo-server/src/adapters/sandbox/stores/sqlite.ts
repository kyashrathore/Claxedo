import { deleteLease, getLease, leaseTransaction, listLeases, upsertLease } from "../../storage/workspace-lease.sql"
import { applySandboxLeasePatch } from "@claxedo/sandbox-manager"
import type { SandboxLeaseAcquireInput, SandboxLeaseAcquireResult, SandboxLeasePatch, SandboxLeaseStore, SandboxLease } from "@claxedo/sandbox-manager"
import { normalizeClaxedoRegion } from "../../../region"
import { sandboxLeaseStatus } from "./lease-status"

type StoredLeaseStatus =
  | "pending"
  | "acquiring"
  | "starting"
  | "ready"
  | "unhealthy"
  | "backoff"
  | "failed"
  | "stopping"
  | "stopped"
  | "destroyed"

/**
 * Stored row status -> port status. Delegates to `sandboxLeaseStatus` so this
 * adapter and the supervisor-state compatibility layer cannot disagree.
 *
 * They previously diverged on `"stopping"`: this file fell through to
 * `"acquiring"` (coming UP) while sibling mapped it to `"stopped"` (going
 * DOWN) — opposite meanings for the same row. No writer emits `"stopping"`
 * today, so the split never fired, but two hand-maintained copies of one
 * conversion is how it would.
 */
function status(input: StoredLeaseStatus): SandboxLease["status"] {
  return sandboxLeaseStatus(input as Parameters<typeof sandboxLeaseStatus>[0])
}

type StoredLease = NonNullable<ReturnType<typeof getLease>>

function storedStatus(input: SandboxLease): StoredLeaseStatus {
  if (input.status === "ready" || input.status === "stopped") return input.status
  if (input.status === "unavailable") return input.nextRetryAt === undefined ? "failed" : "backoff"
  if (input.status === "destroyed") return "destroyed"
  return "acquiring"
}

function toSandboxLease(input: StoredLease): SandboxLease {
  return {
    workspaceId: input.workspace_id,
    homeRegion: normalizeClaxedoRegion(input.home_region),
    driver: input.driver,
    epoch: input.epoch,
    status: status(input.status),
    retryCount: input.retry_count,
    createdAt: input.created_at,
    updatedAt: input.updated_at,
    sandboxId: input.sandbox_id ?? undefined,
    url: input.url ?? undefined,
    hostId: input.lease_id,
    driverResourceId: input.driver_resource_id ?? undefined,
    nextRetryAt: input.next_retry_at ?? undefined,
    lastError: input.last_error ?? undefined,
    lastHeartbeatAt: input.last_heartbeat_at ?? undefined,
    lastActivityAt: input.last_activity_at ?? undefined,
    labels: input.labels ?? undefined,
    checkpoint: input.checkpoint ?? undefined,
    persistence: input.persistence ?? undefined,
    restore: input.restore ?? undefined,
  }
}

function write(input: SandboxLease, current?: StoredLease, options?: { lastHealthFailureAt?: number }) {
  upsertLease({
    workspace_id: input.workspaceId,
    lease_id: input.hostId ?? current?.lease_id ?? `${input.workspaceId}:${input.epoch}`,
    home_region: input.homeRegion,
    epoch: input.epoch,
    status: storedStatus(input),
    driver: input.driver as never,
    driver_resource_id: input.driverResourceId ?? null,
    driver_snapshot_id: current?.driver_snapshot_id ?? null,
    sandbox_id: input.sandboxId ?? null,
    url: input.url ?? null,
    retry_count: input.retryCount,
    next_retry_at: input.nextRetryAt ?? null,
    last_heartbeat_at: input.lastHeartbeatAt ?? null,
    last_activity_at: input.lastActivityAt ?? null,
    last_health_failure_at: options?.lastHealthFailureAt ?? current?.last_health_failure_at ?? null,
    last_error: input.lastError ?? null,
    compute_class: current?.compute_class ?? null,
    accel_base_image_id: current?.accel_base_image_id ?? null,
    accel_prepared_image_id: current?.accel_prepared_image_id ?? null,
    accel_snapshot_id: current?.accel_snapshot_id ?? null,
    labels: input.labels ?? null,
    checkpoint: input.checkpoint ?? null,
    persistence: input.persistence ?? null,
    restore: input.restore ?? null,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  })
}

export function createSqliteLeaseStore(): SandboxLeaseStore {
  return {
    async acquire(workspaceId: string, input: SandboxLeaseAcquireInput): Promise<SandboxLeaseAcquireResult> {
      return leaseTransaction(() => {
        const now = input.now ?? Date.now()
        const current = getLease(workspaceId)
        const currentLease = current ? toSandboxLease(current) : undefined
        if (currentLease?.status === "ready") return { acquired: false, lease: currentLease, retryAfterMs: 0 }
        if (currentLease?.status === "acquiring" && now - currentLease.updatedAt < input.staleAfterMs) {
          return {
            acquired: false,
            lease: currentLease,
            retryAfterMs: Math.max(0, input.staleAfterMs - (now - currentLease.updatedAt)),
          }
        }
        const resumable = currentLease?.status === "stopped"
        const next: SandboxLease = {
          workspaceId,
          homeRegion: currentLease?.homeRegion ?? input.homeRegion,
          driver: currentLease?.driver ?? input.driver,
          epoch: (currentLease?.epoch ?? 0) + 1,
          status: "acquiring",
          retryCount: currentLease?.retryCount ?? 0,
          createdAt: currentLease?.createdAt ?? now,
          updatedAt: now,
          sandboxId: resumable ? currentLease.sandboxId : undefined,
          url: resumable ? currentLease.url : undefined,
          hostId: resumable ? currentLease.hostId : undefined,
          driverResourceId: resumable ? currentLease.driverResourceId : undefined,
          lastHeartbeatAt: resumable ? currentLease.lastHeartbeatAt : undefined,
          lastActivityAt: resumable ? currentLease.lastActivityAt : undefined,
          labels: resumable ? currentLease.labels : undefined,
          checkpoint: currentLease?.checkpoint,
          persistence: currentLease?.persistence,
          restore: currentLease?.restore,
        }
        write(next, current)
        return { acquired: true, lease: next }
      })
    },
    async update(workspaceId: string, expectedEpoch: number, patch: SandboxLeasePatch) {
      return leaseTransaction(() => {
        const current = getLease(workspaceId)
        if (!current || current.epoch !== expectedEpoch) return
        const next = applySandboxLeasePatch(toSandboxLease(current), patch, Date.now())
        write(next, current)
        return next
      })
    },
    async recordFailure(workspaceId: string, expectedEpoch: number, error: string, nextRetryAt?: number) {
      return leaseTransaction(() => {
        const current = getLease(workspaceId)
        if (!current || current.epoch !== expectedEpoch) return
        const failedAt = Date.now()
        const next = {
          ...toSandboxLease(current),
          status: "unavailable" as const,
          retryCount: current.retry_count + 1,
          lastError: error,
          nextRetryAt,
          updatedAt: failedAt,
        }
        write(next, current, { lastHealthFailureAt: failedAt })
        return next
      })
    },
    async release(workspaceId: string) {
      deleteLease(workspaceId)
    },
    async get(workspaceId: string) {
      const current = getLease(workspaceId)
      return current ? toSandboxLease(current) : undefined
    },
    async list() {
      return listLeases().map(toSandboxLease)
    },
  }
}
