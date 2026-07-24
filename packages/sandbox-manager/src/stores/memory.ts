import { applySandboxLeasePatch } from ".."
import type {
  SandboxLeaseAcquireInput,
  SandboxLeaseAcquireResult,
  SandboxLeasePatch,
  SandboxLeaseStore,
  SandboxLease,
  SandboxRegion,
} from ".."

export function createMemoryLeaseStore(seed: SandboxLease[] = []): SandboxLeaseStore {
  const leases = new Map(seed.map((lease) => [lease.workspaceId, { ...lease }]))

  return {
    async acquire(workspaceId: string, input: SandboxLeaseAcquireInput): Promise<SandboxLeaseAcquireResult> {
      const now = input.now ?? Date.now()
      const current = leases.get(workspaceId)
      if (current?.status === "ready") {
        return { acquired: false, lease: current, retryAfterMs: 0 }
      }
      if (current?.status === "acquiring" && now - current.updatedAt < input.staleAfterMs) {
        return {
          acquired: false,
          lease: current,
          retryAfterMs: Math.max(0, input.staleAfterMs - (now - current.updatedAt)),
        }
      }
      const resumable = current?.status === "stopped"
      const next: SandboxLease = {
        workspaceId,
        homeRegion: current?.homeRegion ?? input.homeRegion,
        driver: current?.driver ?? input.driver,
        epoch: (current?.epoch ?? 0) + 1,
        status: "acquiring",
        retryCount: current?.retryCount ?? 0,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        sandboxId: resumable ? current.sandboxId : undefined,
        url: resumable ? current.url : undefined,
        hostId: resumable ? current.hostId : undefined,
        driverResourceId: resumable ? current.driverResourceId : undefined,
        lastHeartbeatAt: resumable ? current.lastHeartbeatAt : undefined,
        lastActivityAt: resumable ? current.lastActivityAt : undefined,
        labels: resumable ? current.labels : undefined,
        checkpoint: current?.checkpoint,
        persistence: current?.persistence,
        restore: current?.restore,
      }
      leases.set(workspaceId, next)
      return { acquired: true, lease: next }
    },
    async update(workspaceId: string, expectedEpoch: number, patch: SandboxLeasePatch) {
      const current = leases.get(workspaceId)
      if (!current || current.epoch !== expectedEpoch) return
      const next = applySandboxLeasePatch(current, patch, Date.now())
      leases.set(workspaceId, next)
      return next
    },
    async recordFailure(workspaceId: string, expectedEpoch: number, error: string, nextRetryAt?: number) {
      const current = leases.get(workspaceId)
      if (!current || current.epoch !== expectedEpoch) return
      const next = {
        ...current,
        status: "unavailable" as const,
        retryCount: current.retryCount + 1,
        lastError: error,
        nextRetryAt,
        updatedAt: Date.now(),
      }
      leases.set(workspaceId, next)
      return next
    },
    async release(workspaceId: string) {
      leases.delete(workspaceId)
    },
    async get(workspaceId: string) {
      const lease = leases.get(workspaceId)
      return lease ? { ...lease, labels: lease.labels ? { ...lease.labels } : undefined } : undefined
    },
    async list() {
      return [...leases.values()].map((lease) => ({ ...lease }))
    },
  }
}

export function sandboxLease(input: Partial<SandboxLease> & { workspaceId: string; homeRegion?: SandboxRegion }): SandboxLease {
  return {
    workspaceId: input.workspaceId,
    homeRegion: input.homeRegion ?? "us-east",
    driver: input.driver ?? "test",
    epoch: input.epoch ?? 1,
    status: input.status ?? "ready",
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? Date.now(),
    updatedAt: input.updatedAt ?? Date.now(),
    sandboxId: input.sandboxId,
    url: input.url,
    hostId: input.hostId,
    driverResourceId: input.driverResourceId,
    nextRetryAt: input.nextRetryAt,
    lastError: input.lastError,
    lastHeartbeatAt: input.lastHeartbeatAt,
    lastActivityAt: input.lastActivityAt,
    labels: input.labels,
    checkpoint: input.checkpoint,
    persistence: input.persistence,
    restore: input.restore,
  }
}
