import type {
  SandboxCheckpointReference,
  SandboxEnsureResult,
  SandboxLease,
  SandboxLeaseStore,
  SandboxManagerInput,
  SandboxSnapshotManagerResult,
  SandboxTargetResult,
} from "."

export type SandboxCheckpointRuntime = {
  freeze: (policy: "drain" | "interrupt") => Promise<void>
  flush: () => Promise<void>
  scrub: () => Promise<void>
  resume: () => Promise<void>
  reconcile: (input: { epoch: number; checkpointId: string }) => Promise<void>
}

export type SandboxCheckpointCaptureInput = {
  runtime: SandboxCheckpointRuntime
  policy?: "drain" | "interrupt"
  retentionExpiresAt?: number
}

export type SandboxCheckpointRestoreInput = {
  runtime: SandboxCheckpointRuntime
  checkpointId?: string
  ensure?: Omit<SandboxManagerInput, "homeRegion">
}

export type SandboxCheckpointResult =
  | { status: "ready"; lease: SandboxLease; checkpoint: SandboxCheckpointReference }
  | { status: "provisioning"; lease: SandboxLease; checkpoint: SandboxCheckpointReference; retryAfterMs: number }

export async function captureSandboxCheckpoint(input: {
  workspaceId: string
  request: SandboxCheckpointCaptureInput
  leaseStore: SandboxLeaseStore
  target: (workspaceId: string) => Promise<SandboxTargetResult>
  snapshot: (workspaceId: string) => Promise<SandboxSnapshotManagerResult>
  now?: () => number
  checkpointId?: () => string
}): Promise<SandboxCheckpointResult> {
  const lease = await requireLease(input.leaseStore, input.workspaceId)
  if (lease.status !== "ready") throw new Error("workspace_checkpoint_lease_not_ready")
  const persistence = lease.persistence
  if (!persistence || persistence.capture === "none") throw new Error("workspace_checkpoint_unsupported")
  const target = await input.target(input.workspaceId)
  if (target.status !== "ready") throw new Error(target.reason)
  await input.request.runtime.freeze(input.request.policy ?? "drain")
  let capturedSource = false
  try {
    await input.request.runtime.flush()
    await input.request.runtime.scrub()
    const captured = persistence.capture === "same-resource"
      ? { ok: true as const, snapshotId: target.driverResourceId ?? target.sandboxId }
      : await input.snapshot(input.workspaceId)
    if (!captured.ok) throw new Error(captured.reason)
    capturedSource = true
    const capturedAt = (input.now ?? Date.now)()
    const checkpoint: SandboxCheckpointReference = {
      id: input.checkpointId?.() ?? `cp_${lease.epoch}_${crypto.randomUUID()}`,
      providerReference: captured.snapshotId,
      sourceEpoch: lease.epoch,
      capturedAt,
      metadata: {
        scope: persistence.capture,
        sourceBehavior: requireCaptureSource(persistence.captureSource),
        ...(input.request.retentionExpiresAt === undefined
          ? {}
          : { retentionExpiresAt: input.request.retentionExpiresAt }),
        restoreMount: requireRestoreMount(persistence.restoreMount),
      },
    }
    const updated = await input.leaseStore.update(input.workspaceId, lease.epoch, {
      checkpoint,
      restore: null,
      ...(persistence.captureSource === "stopped" || persistence.captureSource === "deleted"
        ? { status: "stopped" as const }
        : {}),
    })
    if (!updated) throw new Error("workspace_checkpoint_epoch_fenced")
    return { status: "ready", lease: updated, checkpoint }
  } finally {
    // A provider can stop/delete the source only after a successful capture.
    // Any earlier failure must thaw the still-live runtime.
    if (!capturedSource || persistence.captureSource === "preserved") {
      await input.request.runtime.resume()
    }
  }
}

export async function restoreSandboxCheckpoint(input: {
  workspaceId: string
  request: SandboxCheckpointRestoreInput
  leaseStore: SandboxLeaseStore
  ensure: (workspaceId: string, input: SandboxManagerInput) => Promise<SandboxEnsureResult>
  now?: () => number
}): Promise<SandboxCheckpointResult> {
  const lease = await requireLease(input.leaseStore, input.workspaceId)
  const checkpoint = lease.checkpoint
  if (!checkpoint || (input.request.checkpointId && checkpoint.id !== input.request.checkpointId)) {
    throw new Error("workspace_checkpoint_not_found")
  }
  if (lease.restore?.state === "ready" && lease.restore.checkpointId === checkpoint.id) {
    return { status: "ready", lease, checkpoint }
  }

  const requestedAt = lease.restore?.checkpointId === checkpoint.id
    ? lease.restore.requestedAt
    : (input.now ?? Date.now)()
  const restoring = lease.restore?.checkpointId === checkpoint.id && lease.restore.state !== "pending"
    ? lease.restore
    : {
        checkpointId: checkpoint.id,
        sourceEpoch: checkpoint.sourceEpoch,
        state: "restoring" as const,
        requestedAt,
        startedAt: (input.now ?? Date.now)(),
      }
  const staged = lease.status === "ready" && lease.epoch === checkpoint.sourceEpoch
    ? await input.leaseStore.update(input.workspaceId, lease.epoch, { status: "stopped", restore: restoring })
    : await input.leaseStore.update(input.workspaceId, lease.epoch, { restore: restoring })
  if (!staged) throw new Error("workspace_restore_epoch_fenced")

  const result = await input.ensure(input.workspaceId, {
    homeRegion: staged.homeRegion,
    ...input.request.ensure,
    bootSource: checkpoint.metadata.restoreMount === "same-resource"
      ? { kind: "default" }
      : { kind: "driver-snapshot", snapshotId: checkpoint.providerReference },
  })
  const current = await requireLease(input.leaseStore, input.workspaceId)
  if (result.status === "provisioning") {
    return { status: "provisioning", lease: current, checkpoint, retryAfterMs: result.retryAfterMs }
  }
  if (result.status !== "ready") {
    const failedAt = (input.now ?? Date.now)()
    await input.leaseStore.update(input.workspaceId, current.epoch, {
      restore: {
        checkpointId: checkpoint.id,
        sourceEpoch: checkpoint.sourceEpoch,
        state: "failed",
        requestedAt,
        startedAt: "startedAt" in restoring ? restoring.startedAt : undefined,
        failedAt,
        error: result.error ?? "workspace_restore_unavailable",
      },
    })
    throw new Error(result.error ?? "workspace_restore_unavailable")
  }
  await input.request.runtime.reconcile({ epoch: result.epoch, checkpointId: checkpoint.id })
  const ready = await input.leaseStore.update(input.workspaceId, result.epoch, {
    restore: {
      checkpointId: checkpoint.id,
      sourceEpoch: checkpoint.sourceEpoch,
      state: "ready",
      requestedAt,
      startedAt: "startedAt" in restoring && restoring.startedAt !== undefined
        ? restoring.startedAt
        : (input.now ?? Date.now)(),
      completedAt: (input.now ?? Date.now)(),
    },
  })
  if (!ready) throw new Error("workspace_restore_epoch_fenced")
  return { status: "ready", lease: ready, checkpoint }
}

async function requireLease(store: SandboxLeaseStore, workspaceId: string) {
  const lease = await store.get(workspaceId)
  if (!lease) throw new Error("workspace_checkpoint_lease_missing")
  return lease
}

function requireCaptureSource(value: string) {
  if (value === "preserved" || value === "stopped" || value === "deleted") return value
  throw new Error("workspace_checkpoint_capabilities_invalid")
}

function requireRestoreMount(value: string) {
  if (value === "same-resource" || value === "copy-on-write" || value === "new-resource") return value
  throw new Error("workspace_checkpoint_capabilities_invalid")
}
