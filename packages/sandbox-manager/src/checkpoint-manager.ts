import type {
  SandboxCheckpointReference,
  SandboxEnsureResult,
  SandboxLease,
  SandboxLeaseStore,
  SandboxManagerInput,
  SandboxResource,
  SandboxSnapshotManagerResult,
  SandboxTargetResult,
} from "./contract"
import { publicApiFailure } from "@claxedo/helpers/api-error"

export type SandboxCheckpointRuntime = {
  freeze: (policy: "drain" | "interrupt", options: { idleBefore?: number }) => Promise<void>
  flush: () => Promise<void>
  scrub: () => Promise<void>
  resume: () => Promise<void>
  reconcile: (input: { epoch: number; checkpointId: string }) => Promise<void>
}

export type SandboxCheckpointCaptureInput = {
  runtime: SandboxCheckpointRuntime
  policy?: "drain" | "interrupt"
  /** Capture only a workspace that has had no work since this time; the runtime refuses the freeze otherwise. */
  idleBefore?: number
}

export type SandboxStopInput = {
  /** Present when the workspace's state is captured before its host stops. */
  runtime?: SandboxCheckpointRuntime
  idleBefore?: number
  expectedEpoch?: number
  /** The caller is the host: it stops itself once the lease says stopped, so the manager stops no host. */
  hostStopsItself?: boolean
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
  snapshot: (workspaceId: string, committed?: string) => Promise<SandboxSnapshotManagerResult>
  deleteSnapshot?: (target: SandboxResource, snapshotId: string) => Promise<void>
  /** The capture ends this lease: its commit stops it, and the runtime stays frozen for the host stop that follows. */
  endsLease?: boolean
  now?: () => number
  checkpointId?: () => string
}): Promise<SandboxCheckpointResult> {
  const lease = await requireLease(input.leaseStore, input.workspaceId)
  if (lease.status !== "ready") throw publicApiFailure("workspace_checkpoint_conflict", "workspace_checkpoint_lease_not_ready")
  const persistence = lease.persistence
  if (!persistence || persistence.capture === "none") throw publicApiFailure("workspace_checkpoint_conflict", "workspace_checkpoint_unsupported")
  const target = await input.target(input.workspaceId)
  if (target.status !== "ready") throw publicApiFailure("workspace_checkpoint_unavailable", target.reason)
  const discard = persistence.capture === "same-resource" ? undefined : input.deleteSnapshot
  let capturedSource = false
  let committed = false
  try {
    await input.request.runtime.freeze(input.request.policy ?? "drain", { idleBefore: input.request.idleBefore })
    await input.request.runtime.flush()
    await input.request.runtime.scrub()
    const captured = persistence.capture === "same-resource"
      ? { ok: true as const, snapshotId: target.driverResourceId ?? target.sandboxId }
      : await input.snapshot(input.workspaceId, (await input.leaseStore.get(input.workspaceId))?.checkpoint?.providerReference)
    if (!captured.ok) throw publicApiFailure("workspace_checkpoint_conflict", captured.reason)
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
        restoreMount: requireRestoreMount(persistence.restoreMount),
      },
    }
    const replaced = (await input.leaseStore.get(input.workspaceId))?.checkpoint
    const updated = await input.leaseStore.update(input.workspaceId, lease.epoch, {
      checkpoint,
      restore: null,
      ...(input.endsLease || persistence.captureSource === "stopped" || persistence.captureSource === "deleted"
        ? { status: "stopped" as const }
        : {}),
    })
    if (!updated) {
      await discardSnapshot(discard, target, captured.snapshotId)
      throw publicApiFailure("workspace_checkpoint_conflict", "workspace_checkpoint_epoch_fenced")
    }
    committed = true
    // A lease references one checkpoint, so the one it replaced is no longer restorable from anywhere.
    if (replaced && replaced.providerReference !== captured.snapshotId) {
      await discardSnapshot(discard, target, replaced.providerReference)
    }
    return { status: "ready", lease: updated, checkpoint }
  } finally {
    // A provider can stop/delete the source only after a successful capture.
    // Any earlier failure must thaw the still-live runtime.
    if (!(committed && input.endsLease) && (!capturedSource || persistence.captureSource === "preserved")) {
      await input.request.runtime.resume()
    }
  }
}

/** Deletes a provider snapshot no lease references; a failure leaks storage, never the checkpoint just taken. */
export async function discardSnapshot(
  discard: ((target: SandboxResource, snapshotId: string) => Promise<void>) | undefined,
  target: SandboxResource,
  snapshotId: string,
) {
  await discard?.(target, snapshotId).catch((error: unknown) => {
    console.warn("A superseded sandbox snapshot could not be deleted", { workspaceId: target.workspaceId, snapshotId, error: String(error) })
  })
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
    throw publicApiFailure("workspace_checkpoint_conflict", "workspace_checkpoint_not_found")
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
  if (!staged) throw publicApiFailure("workspace_checkpoint_conflict", "workspace_restore_epoch_fenced")

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
    throw publicApiFailure("workspace_checkpoint_unavailable", result.error ?? "workspace_restore_unavailable")
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
  if (!ready) throw publicApiFailure("workspace_checkpoint_conflict", "workspace_restore_epoch_fenced")
  return { status: "ready", lease: ready, checkpoint }
}

async function requireLease(store: SandboxLeaseStore, workspaceId: string) {
  const lease = await store.get(workspaceId)
  if (!lease) throw publicApiFailure("workspace_checkpoint_conflict", "workspace_checkpoint_lease_missing")
  return lease
}

function requireCaptureSource(value: string) {
  if (value === "preserved" || value === "stopped" || value === "deleted") return value
  throw publicApiFailure("workspace_checkpoint_conflict", "workspace_checkpoint_capabilities_invalid")
}

function requireRestoreMount(value: string) {
  if (value === "same-resource" || value === "copy-on-write" || value === "new-resource") return value
  throw publicApiFailure("workspace_checkpoint_conflict", "workspace_checkpoint_capabilities_invalid")
}
