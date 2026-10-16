import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "./constants"
import type { SandboxMachineClass, SandboxPhaseTiming, SandboxSecretBrokering, SandboxStartPhase } from "@claxedo/sandbox-contract"

export type { SandboxMachineClass, SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import {
  type SandboxCheckpointCaptureInput,
  type SandboxCheckpointRestoreInput,
  type SandboxCheckpointResult,
  type SandboxStopInput,
} from "./checkpoint-manager"
import type { SandboxLifecycleEvent } from "./lease-lifecycle"
import type { SandboxBrokeredSecret, SandboxEgressControl, SandboxEgressUnenforcedEvent, SandboxNetworkPolicy } from "./egress-policy"
import type { SandboxLeaseFailure } from "./lease-failure"

export { DEFAULT_WORKSPACE_RUNTIME_PORT }

export type SandboxRegion = string

export type SandboxCaptureScope = "none" | "same-resource" | "filesystem"
export type SandboxCaptureSourceBehavior = "not-applicable" | "preserved" | "stopped" | "deleted"
export type SandboxRestoreMountBehavior = "not-applicable" | "same-resource" | "new-resource"

export type SandboxPersistenceCapabilities = {
  resume: "same-sandbox" | "replacement-restore"
  capture: SandboxCaptureScope
  clone: boolean
  captureSource: SandboxCaptureSourceBehavior
  retention: "not-applicable" | "provider-managed" | "explicit"
  restoreMount: SandboxRestoreMountBehavior
}

export function validateSandboxPersistenceCapabilities(input: SandboxPersistenceCapabilities) {
  if (input.resume === "replacement-restore" && input.capture === "none") {
    return { valid: false as const, reason: "replacement restore requires a capture source" }
  }
  if (input.capture === "none" && input.captureSource !== "not-applicable") {
    return { valid: false as const, reason: "capture source behavior requires capture support" }
  }
  if (input.capture !== "none" && input.captureSource === "not-applicable") {
    return { valid: false as const, reason: "capture support requires source behavior" }
  }
  if (input.capture === "same-resource" && input.restoreMount !== "same-resource") {
    return { valid: false as const, reason: "same-resource capture requires same-resource restore" }
  }
  return { valid: true as const }
}

export type SandboxCheckpointReference = {
  id: string
  providerReference: string
  sourceEpoch: number
  capturedAt: number
  metadata: {
    scope: Exclude<SandboxCaptureScope, "none">
    sourceBehavior: Exclude<SandboxCaptureSourceBehavior, "not-applicable">
    restoreMount: Exclude<SandboxRestoreMountBehavior, "not-applicable">
  }
}

type SandboxRestoreIdentity = {
  checkpointId: string
  sourceEpoch: number
}

export type SandboxRestoreStatus =
  | (SandboxRestoreIdentity & { state: "pending"; requestedAt: number })
  | (SandboxRestoreIdentity & { state: "restoring"; requestedAt: number; startedAt: number })
  | (SandboxRestoreIdentity & { state: "ready"; requestedAt: number; startedAt: number; completedAt: number })
  | (SandboxRestoreIdentity & {
      state: "failed"
      requestedAt: number
      startedAt?: number
      failedAt: number
      error: string
    })

export type SandboxDriverMetadata = {
  /** Where the sandbox driver code can execute. This is not sandbox infrastructure. */
  driverRunsIn: Array<"worker" | "node" | "local">
  /** What `SandboxManager.stop()` actually does to the driver-owned resource. */
  hostStopBehavior: "not-supported" | "suspends-host" | "terminates-host"
  /** Whether a stopped/stale lease can resume the same driver-owned resource. */
  hostResumeBehavior: "same-host" | "replacement-host"
  /**
   * The host itself reads its runtime's idleness and stops once the idle
   * window has passed (the Cloudflare sandbox Worker). Absent, nothing on the
   * host does: the control plane's provisioner watches the runtime over the
   * relay and stops the host through the driver.
   */
  hostWatchesIdle?: true
  /** How the control plane reaches the sandbox target returned by the driver. */
  targetAccess: "relay" | "loopback"
  /**
   * How the driver can honor a `SandboxBrokeredSecret` — a credential the
   * sandbox may USE for outbound requests but must NEVER be able to READ.
   *
   * - `"native"` — the provider brokers it on egress to the allowlisted hosts
   *   with no extra infrastructure of ours: Vercel firewall header
   *   transforms, Cloudflare outbound handlers reading
   *   the value from KV. The driver installs it during `ensureHost`.
   * - `"none"` — no way to keep the value out of sandbox processes. The
   *   provider may still have an encrypted secret STORE (e.g. Modal secrets),
   *   but it is exposed as a readable env var, which cannot satisfy the
   *   never-readable contract.
   */
  secretBrokering: SandboxSecretBrokering
  /**
   * How the driver can enforce a RESTRICTED `SandboxNetworkPolicy` — i.e.
   * whether the sandbox's outbound network can actually be contained.
   *
   * A `SandboxNetworkPolicy` states the same allowance in up to two encodings:
   * `hosts` (names) and `cidrs` (addresses). A driver contains egress if it
   * enforces AT LEAST ONE encoding the policy carries and blocks everything
   * else; the encodings are alternatives, not additive requirements.
   *
   * - `"hosts-and-cidrs"` — the provider filters by name AND by address.
   * - `"hosts"` — the provider filters by hostname only (Vercel firewall).
   * - `"none"` — the driver cannot express an egress allowlist. This covers
   *   BOTH drivers that throw when handed a restricted policy (docker, boat,
   *   and modal for host policy) AND — more dangerously — drivers that
   *   silently ignore `net` and run wide open (cloudflare, the fetch bridge).
   *   Modal is `"none"` even though it can cut the network entirely: a total
   *   blackout is not an allowlist and cannot serve a workspace that has to
   *   clone a repo and reach a model provider.
   *
   * The manager reads this to decide what the driver is handed:
   * `sandboxEgressDisposition` enforces where it can and WITHHOLDS (loudly)
   * where it cannot. See `SandboxEgressDisposition` for the posture and
   * `public-docs/sandbox-egress.md` for the operator-facing consequence.
   */
  egressControl: SandboxEgressControl
  persistence: SandboxPersistenceCapabilities
  /** The machine classes the provider lets this driver choose at create; absent, the provider's one default. */
  machineClasses?: readonly SandboxMachineClass[]
}

export type SandboxExposure =
  | { kind: "loopback" }
  | { kind: "relay" }
  | { kind: "private-network" }
  | { kind: "embedded" }

export type SandboxLeaseStatus = "acquiring" | "ready" | "unavailable" | "stopped" | "destroyed"

export type SandboxLease = {
  workspaceId: string
  homeRegion: SandboxRegion
  driver: string
  epoch: number
  routingId?: string
  status: SandboxLeaseStatus
  retryCount: number
  updatedAt: number
  createdAt: number
  sandboxId?: string
  url?: string
  hostId?: string
  driverResourceId?: string
  nextRetryAt?: number
  lastError?: string
  lastHeartbeatAt?: number
  lastActivityAt?: number
  labels?: Record<string, string>
  checkpoint?: SandboxCheckpointReference
  persistence?: SandboxPersistenceCapabilities
  restore?: SandboxRestoreStatus
  /** This epoch's start, recorded while it boots; a new epoch starts without one. */
  start?: SandboxStartProgress
  /** The machine this epoch's sandbox runs on: the class its acquire named, else the one the host it resumes already has. */
  machineClass?: SandboxMachineClass
}

/**
 * One lease epoch's start as far as it has been observed. Persisted because a
 * start outlives the ensure call that began it: a driver that answers
 * "provisioning" is polled again from another request, often another isolate.
 *
 * `startedAt` is this epoch's boot, the interval the epoch is metered by;
 * `requestedAt`, `bootMode` and `failures` are the start the person is waiting
 * on, which an epoch that retries a failed attempt or takes over a stale one
 * inherits. A failure is recorded here as well as in the lease's `lastError`,
 * which the next epoch's acquire and the target it then records clear.
 */
export type SandboxStartProgress = {
  requestedAt: number
  startedAt: number
  bootMode: SandboxBootMode
  /** When the last phase the control plane itself observed ended; the next one is timed from here. */
  markedAt: number
  phases: SandboxStartPhase[]
  /** The epochs of this start that failed, in order, each with the reason the lease recorded. */
  failures?: SandboxStartFailure[]
}

export type SandboxStartFailure = { epoch: number; failedAt: number; error: string }

export type SandboxEpochStart = SandboxStartProgress & { epoch: number }

export type SandboxStartPhaseEvent = SandboxPhaseTiming<SandboxStartPhase> & {
  /** Since the start the person is waiting on began, across the epochs it took. */
  sinceStartMs: number
  workspaceId: string
  epoch: number
  driver: string
  homeRegion: SandboxRegion
  bootMode: SandboxBootMode
  labels: Record<string, string>
  repoSizeBytes?: number
}

export type SandboxLeaseAcquireInput = {
  homeRegion: SandboxRegion
  driver: string
  staleAfterMs: number
  now?: number
  /** The placement's labels, recorded on a fresh lease before the driver is asked for a resource; a resumed lease keeps its own. */
  labels?: Record<string, string>
  /** The machine the workspace names now; a held host is resumed onto it, and absent, keeps the machine it has. */
  machineClass?: SandboxMachineClass
  /** The start the new epoch continues, recorded on it before any driver step, so a poll from another isolate times from the same request. */
  start?: SandboxStartProgress
}

export type SandboxLeaseAcquireResult =
  | { acquired: true; lease: SandboxLease }
  | { acquired: false; lease: SandboxLease; retryAfterMs: number }

/**
 * The lease whose host, placement and size the next epoch keeps, so that
 * epoch resumes it: one stopped, or one whose attempt failed on a host the
 * driver had already reported. A destroyed lease's host is gone, and a lease
 * that never got one is placed afresh.
 */
export function sandboxLeaseHeldHost(lease: SandboxLease | undefined): SandboxLease | undefined {
  return lease?.sandboxId !== undefined && (lease.status === "stopped" || lease.status === "unavailable") ? lease : undefined
}

/**
 * What may be said about a lease after it exists: lifecycle state, liveness,
 * and the capture/restore record.
 *
 * Identity and labels are absent, and that absence is the whole ownership
 * mechanism. `sandboxId`, `url`, `hostId`, `driverResourceId` and `labels`
 * decide which provider resource every later checkpoint, snapshot, stop and
 * destroy acts on; if a patch could carry them, anything that can reach a
 * store — a status update, a heartbeat, a retry — could point one workspace's
 * lease at another workspace's sandbox. They enter a lease only through
 * `SandboxLeaseStore.recordTarget`, whose argument is a driver's resource report.
 */
export type SandboxLeasePatch = Partial<
  Pick<
    SandboxLease,
    | "status"
    | "retryCount"
    | "lastHeartbeatAt"
    | "lastActivityAt"
  >
> & {
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  nextRetryAt?: number | null
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  lastError?: string | null
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  checkpoint?: SandboxCheckpointReference | null
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  restore?: SandboxRestoreStatus | null
  start?: SandboxStartProgress
  /**
   * When the host this write takes the epoch off was last proven serving, for
   * a write that learns of its end after the fact; the boot it records ends
   * there rather than at the write. Not a lease field.
   */
  endedAt?: number
}

/**
 * Canonical SandboxLeasePatch merge semantics shared by every lease store driver:
 * absent/`undefined` keeps the current value, `null` clears it.
 */
export function applySandboxLeasePatch(current: SandboxLease, patch: SandboxLeasePatch, updatedAt: number): SandboxLease {
  return {
    ...current,
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.retryCount === undefined ? {} : { retryCount: patch.retryCount }),
    ...(patch.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: patch.lastHeartbeatAt }),
    ...(patch.lastActivityAt === undefined ? {} : { lastActivityAt: patch.lastActivityAt }),
    ...(patch.nextRetryAt === undefined ? {} : { nextRetryAt: patch.nextRetryAt ?? undefined }),
    ...(patch.lastError === undefined ? {} : { lastError: patch.lastError ?? undefined }),
    ...(patch.checkpoint === undefined ? {} : { checkpoint: patch.checkpoint ?? undefined }),
    ...(patch.restore === undefined ? {} : { restore: patch.restore ?? undefined }),
    ...(patch.start === undefined ? {} : { start: patch.start }),
    updatedAt,
  }
}

/**
 * A provider resource may exist before it has a runtime URL. Persisting its
 * identity while acquiring lets the next ensure continue that same resource.
 */
export type SandboxProvisionedTarget = {
  sandboxId: string
  url?: string
  hostId: string
  driverResourceId?: string
  labels: Record<string, string>
  persistence?: SandboxPersistenceCapabilities
}

/** The lease after its epoch failed: unavailable, a retry counted, and the reason on the lease and on the start it was on. */
export function applySandboxLeaseFailure(current: SandboxLease, error: string, nextRetryAt: number | undefined, failedAt: number): SandboxLease {
  return {
    ...current,
    status: "unavailable",
    retryCount: current.retryCount + 1,
    lastError: error,
    nextRetryAt,
    updatedAt: failedAt,
    ...(current.start
      ? { start: { ...current.start, failures: [...current.start.failures ?? [], { epoch: current.epoch, failedAt, error }] } }
      : {}),
  }
}

export function applySandboxProvisionedTarget(
  current: SandboxLease,
  target: SandboxProvisionedTarget,
  updatedAt: number,
): SandboxLease {
  const sameTarget = current.status === "ready"
    && current.url === target.url
    && current.sandboxId === target.sandboxId
    && current.hostId === target.hostId
    && current.driverResourceId === target.driverResourceId
  return {
    ...current,
    status: target.url === undefined ? "acquiring" : "ready",
    routingId: sameTarget && current.routingId ? current.routingId : crypto.randomUUID(),
    sandboxId: target.sandboxId,
    url: target.url,
    hostId: target.hostId,
    driverResourceId: target.driverResourceId,
    labels: target.labels,
    ...(target.persistence === undefined ? {} : { persistence: target.persistence }),
    retryCount: 0,
    nextRetryAt: undefined,
    lastError: undefined,
    updatedAt,
  }
}

export type SandboxLeaseStore = {
  acquire: (workspaceId: string, input: SandboxLeaseAcquireInput) => Promise<SandboxLeaseAcquireResult>
  /** The one writer of lease identity. Fenced on the epoch the driver was asked for. */
  recordTarget: (
    workspaceId: string,
    expectedEpoch: number,
    target: SandboxProvisionedTarget,
  ) => Promise<SandboxLease | undefined>
  update: (workspaceId: string, expectedEpoch: number, patch: SandboxLeasePatch, expectedStatus?: SandboxLeaseStatus) => Promise<SandboxLease | undefined>
  recordFailure: (
    workspaceId: string,
    expectedEpoch: number,
    error: string,
    nextRetryAt?: number,
  ) => Promise<SandboxLease | undefined>
  release: (workspaceId: string) => Promise<void>
  get: (workspaceId: string) => Promise<SandboxLease | undefined>
  list: () => Promise<SandboxLease[]>
}

export type SandboxBootSource =
  | { kind: "image"; image: string }
  | { kind: "driver-snapshot"; snapshotId: string }
  | { kind: "default" }

export type SandboxSource = { kind: "git"; repoUrl: string; branch?: string } | { kind: "empty" }

export type SandboxDriverEnsureInput = {
  /** Await before readiness polling so the manager can durably fence the resource identity. */
  onResource?: (resource: Omit<SandboxProvisionedTarget, "url" | "persistence">) => Promise<void>
  /** Called by a driver whose provider machine, created or resumed, takes commands before the image is prepared on it. */
  onMachineReady?: () => Promise<void>
  /** Called by a driver that sees its sandbox running from the image or snapshot before the runtime is up. */
  onImageReady?: () => Promise<void>
  workspaceId: string
  hostId?: string
  homeRegion: SandboxRegion
  epoch: number
  labels: Record<string, string>
  bootSource?: SandboxBootSource
  workspaceRoot?: string
  runtimeCwd?: string
  workspaceRuntimePort?: number
  env?: Record<string, string>
  /** Brokered secrets: injected on egress, never readable inside the sandbox. */
  secrets?: SandboxBrokeredSecret[]
  source?: SandboxSource
  exposure?: SandboxExposure
  /** The machine to create the sandbox on; one the driver declared, or nothing for the provider's default. */
  machineClass?: SandboxMachineClass
  /**
   * Egress policy. Omitted means allow-all, which is only appropriate for a
   * single-tenant deployment the operator already trusts.
   *
   * A driver can rely on this being ABSENT whenever it declares
   * `egressControl: "none"`: the manager withholds the policy rather than hand
   * it to a driver that would either throw on it or silently drop it. A driver
   * that receives a restricted policy here is one that declared it can enforce
   * it. @see SandboxEgressDisposition
   */
  net?: SandboxNetworkPolicy
  /** Optional snapshot/image to boot from (user-supplied or pre-built). */
  snapshot?: string
}

export type SandboxTarget = {
  workspaceId?: string
  sandboxId: string
  url: string
  hostId: string
  driverResourceId?: string
  labels?: Record<string, string>
  driver?: {
    id: string
    resourceId: string
    metadata?: Record<string, string>
  }
}

export type SandboxResource = Omit<SandboxTarget, "url"> & { url?: string }

/** What the provider says of a host: running or booting, held but not running, or no longer had. */
export type SandboxHostState = "serving" | "stopped" | "gone"

export type SandboxSnapshotResult = { snapshotId: string }
export type SandboxCommandResult = { stdout: string; stderr: string; exitCode: number }

// A driver places and manages the sandbox process. It is deliberately
// not a sandbox remote-control API; files, PTYs, sessions, and agent work go
// through @claxedo/workspace-runtime over the relay.
/** The label a target records the image its runtime booted from, when the control plane chose that image. */
export const SANDBOX_IMAGE_LABEL = "image"

export type SandboxDriver = {
  id: string
  metadata: SandboxDriverMetadata
  /** The image this driver's next boot runs, when the control plane chooses it. */
  image?: string
  ensureHost: (
    input: SandboxDriverEnsureInput,
  ) => Promise<SandboxTarget | { provisioning: true; retryAfterMs: number }>
  resumeHost?: (input: {
    lease: SandboxLease
    ensure: SandboxDriverEnsureInput
  }) => Promise<SandboxTarget | { provisioning: true; retryAfterMs: number }>
  list?: () => Promise<SandboxTarget[]>
  touch?: (target: SandboxTarget) => Promise<void>
  /** A host whose runtime never published a URL is suspended all the same: a boot that failed on it still holds it. */
  suspend?: (target: SandboxResource) => Promise<void>
  /**
   * Stops the host; given `epoch`, a host that a newer lease generation already
   * took over keeps running. `checkpoint` names the snapshot the lease references.
   */
  stop?: (target: SandboxResource & { epoch?: number; checkpoint?: string }) => Promise<void>
  destroy?: (target: SandboxResource) => Promise<void>
  /** `committed` names the snapshot the lease references now; a driver tracking uncommitted snapshots drops the rest. */
  snapshot?: (target: SandboxTarget, committed?: string) => Promise<SandboxSnapshotResult>
  /** Deletes a snapshot `snapshot` returned; implemented by drivers whose snapshots outlive their sandbox. */
  deleteSnapshot?: (target: SandboxResource, snapshotId: string) => Promise<void>
  inspect?: (target: SandboxTarget) => Promise<SandboxHostState>
  exec?: (target: SandboxTarget, command: string) => Promise<SandboxCommandResult>
  clone?: (target: SandboxTarget, input: { name: string }) => Promise<SandboxTarget>
}

export type SandboxManager = {
  /** Takes or continues the workspace's lease and runs the driver for it until it answers. */
  ensure: (workspaceId: string, input: SandboxManagerInput) => Promise<SandboxEnsureResult>
  /**
   * The lease decision of `ensure` alone: `provisioning` names the epoch a
   * caller that schedules its own driver work now holds and owes `provision`.
   */
  acquire: (workspaceId: string, input: SandboxManagerInput) => Promise<SandboxEnsureResult>
  /**
   * The driver work of `ensure` for the lease `acquire` handed out at `epoch`;
   * another epoch answers `runtime_lease_changed`. A lease whose attempt failed
   * is not driven again: once its retry is due, the next attempt takes a fresh
   * epoch, which the answer names, keeping the host the failed one holds.
   */
  provision: (workspaceId: string, epoch: number, input: SandboxManagerInput) => Promise<SandboxEnsureResult>
  register: (workspaceId: string, input: SandboxRuntimeSnapshotInput) => Promise<SandboxMutationResult>
  heartbeat: (workspaceId: string, input: SandboxRuntimeSnapshotInput) => Promise<SandboxMutationResult>
  target: (workspaceId: string) => Promise<SandboxTargetResult>
  touch: (workspaceId: string) => Promise<SandboxTouchResult>
  snapshot: (workspaceId: string, committed?: string) => Promise<SandboxSnapshotManagerResult>
  checkpoint: (workspaceId: string, input: SandboxCheckpointCaptureInput) => Promise<SandboxCheckpointResult>
  restore: (workspaceId: string, input: SandboxCheckpointRestoreInput) => Promise<SandboxCheckpointResult>
  stop: (workspaceId: string, input?: SandboxStopInput) => Promise<SandboxMutationResult>
  /**
   * Ends the serving lease at `epoch` when the provider says its host is not
   * running: `stopped` (held, not running) ends it stopped, so the next start
   * resumes that host; `gone` ends it destroyed. Nothing while the host
   * serves, the epoch moved on, or the driver cannot inspect its hosts.
   */
  endIfHostDown: (workspaceId: string, epoch: number) => Promise<Exclude<SandboxHostState, "serving"> | undefined>
  destroy: (workspaceId: string) => Promise<SandboxMutationResult>
  /**
   * A person's Start fresh: drops the stopped workspace's checkpoint so its
   * next start boots the image and clones the repository. Refused while the
   * workspace runs or a start is in flight (`workspace_running`), and for a
   * driver whose checkpoint is the host itself or that keeps none
   * (`start_fresh_unsupported`).
   */
  startFresh: (workspaceId: string) => Promise<SandboxMutationResult>
  release: (workspaceId: string) => Promise<{ released: boolean }>
  garbageCollect: () => Promise<SandboxGarbageCollectResult>
  list: () => Promise<SandboxLease[]>
  /** Phases the runtime timed inside its sandbox, recorded into that epoch's start once each. */
  recordStartPhases: (workspaceId: string, input: SandboxStartPhasesReport) => Promise<void>
  /**
   * Ends `phase` now, timed from the start's last observed phase. `notBefore`
   * is when the evidence for it came into being; evidence older than the start
   * belongs to an earlier one and records nothing.
   */
  markStartPhase: (workspaceId: string, input: { epoch: number; phase: SandboxStartPhase; notBefore: number }) => Promise<void>
}

export type SandboxStartPhasesReport = {
  epoch: number
  phases: readonly SandboxPhaseTiming<SandboxStartPhase>[]
  repoSizeBytes?: number
}

export type SandboxManagerInput = {
  homeRegion: SandboxRegion
  hostId?: string
  labels?: Record<string, string>
  bootSource?: SandboxBootSource
  workspaceRoot?: string
  runtimeCwd?: string
  workspaceRuntimePort?: number
  env?: Record<string, string>
  /** Brokered secrets: injected on egress, never readable inside the sandbox. */
  secrets?: SandboxBrokeredSecret[]
  /**
   * Env minted for the lease the driver boots, joined to `env`: a credential
   * bound to one lease generation and host can only be minted once the start
   * has settled which epoch it runs, and a failed attempt's retry takes a new
   * one.
   */
  leaseEnv?: (lease: { epoch: number; hostId: string }) => Promise<Record<string, string>>
  /** The machine the workspace chose; refused before a lease is taken when its driver declares no such class. */
  machineClass?: SandboxMachineClass
  source?: SandboxSource
  exposure?: SandboxExposure
  /**
   * @see SandboxDriverEnsureInput.net — enforced by a capable driver, withheld
   * (with a warning) by one that declares `egressControl: "none"`.
   */
  net?: SandboxNetworkPolicy
  snapshot?: string
  /**
   * Called by the one ensure whose acquire created the workspace's first
   * lease, before its driver is asked for anything; a concurrent start that
   * lost the acquire is not called.
   */
  onLeaseOpened?: () => void
}

/**
 * What a running sandbox may report about itself: liveness and activity.
 *
 * Identity — `sandboxId`, `url`, `hostId`, `driverResourceId` — is absent on
 * purpose. `provision()` writes it from the driver's answer and nothing else
 * does, because every later lifecycle call resolves its provider target from
 * those fields: a snapshot able to restate them lets the reporting sandbox
 * point this workspace's checkpoint, snapshot and destroy at a resource
 * belonging to another workspace.
 *
 * `epoch` is required and never defaulted. Reading the lease's own epoch when
 * the reporter omits one makes the fence agree with whatever it is handed.
 */
export type SandboxRuntimeSnapshotInput = {
  epoch: number
  /** Whether the runtime is serving. How a reporter words that is its own. */
  ok: boolean
  active?: boolean
  now?: number
}

/**
 * What a provisioning cycle is actually doing, for honest progress UI.
 * `restore` = booting a replacement restored from the workspace's snapshot
 * (files come back), `resume` = restarting the same paused resource,
 * `cold-start` = a fresh sandbox with no prior state to bring back (first
 * boot, or nothing snapshot-able survived).
 */
export type SandboxBootMode = "restore" | "resume" | "cold-start"

export type SandboxEnsureResult =
  | ({ status: "ready" } & SandboxTarget & {
      epoch: number
      routingId?: string
      homeRegion: SandboxRegion
      /**
       * Set when the driver call for this ensure failed on a lease that was
       * already serving: the returned target predates this ensure's inputs.
       * A caller that handed new brokered secrets must not record them as
       * delivered — the provider edge still holds the previous set.
       */
      stale?: true
    })
  | { status: "provisioning"; retryAfterMs: number; epoch: number; homeRegion: SandboxRegion; bootMode?: SandboxBootMode }
  | {
      status: "unavailable"
      retryAfterMs?: number
      error?: string
      epoch?: number
      homeRegion: SandboxRegion
      /** The start's retry budget is spent: `retryAfterMs` is the cooldown every start waits out, which nothing drives. */
      exhausted?: true
    }

export type SandboxTargetResult =
  | ({ status: "ready" } & SandboxTarget & {
      epoch: number
      routingId?: string
      homeRegion: SandboxRegion
      /** The runtime booted from an image other than the driver's current one; its next ensure boots the current one. */
      imageOutdated?: true
      /** The start that brought this epoch up, as observed; the run still delivering its settings is timed from it. */
      start?: SandboxEpochStart
    })
  | {
      status: "unavailable"
      reason: string
      /**
       * The lease's own lifecycle word when a lease exists (`"acquiring"`,
       * `"stopped"`, `"unavailable"`, `"destroyed"`); absent when none does.
       * `target()` deliberately does not collapse these — a read path needs to
       * tell "a start is already in flight" apart from "nothing is running".
       */
      leaseStatus?: SandboxLeaseStatus
      /** Delay until the lease's own next scheduled retry, when it carries one. */
      retryAfterMs?: number
      /** What the lease's last start or health report failed on, when it is unavailable for that reason. */
      failure?: SandboxLeaseFailure
      /** The start the lease is on while it is acquiring or waiting out a retry, as far as it has been observed. */
      start?: SandboxEpochStart
      /** The epoch and host an acquiring lease is booting, once the driver has handed it a host. */
      booting?: { epoch: number; hostId: string }
    }

export type SandboxTouchResult = { touched: boolean; status: SandboxLeaseStatus | "missing" }
/** A stop's answer names the snapshot the stopped lease references (`checkpoint`), so a host that stops itself keeps it. */
export type SandboxMutationResult = { ok: true; status: SandboxLeaseStatus; checkpoint?: string } | { ok: false; reason: string }
export type SandboxSnapshotManagerResult =
  | ({ ok: true } & SandboxSnapshotResult)
  | { ok: false; reason: string }
export type SandboxGarbageCollectResult = {
  destroyed: SandboxTarget[]
  kept: SandboxTarget[]
  skipped: Array<{ target: SandboxTarget; reason: string }>
  failed: Array<{ target: SandboxTarget; error: string }>
  /**
   * Set when the driver cannot enumerate provider state, so the four arrays
   * above mean "we could not look" rather than "nothing is orphaned". Absent on
   * a real sweep. Callers must treat it as a FAILED sweep: four empty arrays
   * reported as success is the exact defect finding B1 names.
   */
  listingUnsupported?: true
  /** Driver id, so an ops report can name which driver could not look. */
  driver?: string
  /** Provider accounts a sweep over several keys could not open, so nothing on them was examined. */
  unreachable?: Array<{ driver: string; error: string }>
}

/**
 * A driver's `list()` may throw this shape to say "my backing service cannot
 * enumerate", as distinct from "listing failed this time". `garbageCollect()`
 * converts it into `listingUnsupported` (a loud, non-fatal capability gap);
 * every other error propagates as a real sweep failure.
 *
 * Structural rather than an `instanceof` check on purpose: drivers are published
 * as separate entry points and bundlers duplicate class identities, so a
 * nominal check would silently fall through to "transient failure" in exactly
 * the deployment that needs the distinction.
 */
export type SandboxListingUnsupported = { listingUnsupported: true }

export function isSandboxListingUnsupported(err: unknown): err is SandboxListingUnsupported {
  return !!err && typeof err === "object" && (err as { listingUnsupported?: unknown }).listingUnsupported === true
}

export type SandboxManagerOptions = {
  leaseStore: SandboxLeaseStore
  driver: SandboxDriver
  staleAfterMs?: number
  retryAfterMs?: number
  retryDelayMs?: (retryCount: number) => number
  maxRetryCount?: number
  retryCapCooldownMs?: number
  now?: () => number
  // Value written to the `app` label on every sandbox this manager provisions,
  // and the ownership filter for garbage collection: GC only ever destroys
  // sandboxes whose `app` label equals this value. Defaults to "claxedo" for
  // compatibility with already-provisioned sandboxes; set your own product id
  // when embedding the manager outside Claxedo.
  appLabel?: string
  /**
   * Sink for the loud half of "enforce where we can, document where we can't".
   * Called at composition time and again every time a restricted policy is
   * withheld from a driver that cannot enforce it.
   *
   * Defaults to `console.warn(event.message)`. Pass your own to route the gap
   * into a telemetry pipeline instead — but note the default is deliberately
   * unconditional: an operator who never wires a sink still gets the warning.
   * Pass `() => {}` only if you have another way to surface it.
   */
  onEgressUnenforced?: (event: SandboxEgressUnenforcedEvent) => void
  /** Receives each start phase as it ends; a sink that throws is ignored. */
  onStartPhase?: (event: SandboxStartPhaseEvent) => void
  onLifecycle?: (event: SandboxLifecycleEvent) => void
}

