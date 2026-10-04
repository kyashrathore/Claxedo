import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "./constants"
import type { SandboxPhaseTiming, SandboxSecretBrokering, SandboxStartPhase } from "@claxedo/sandbox-contract"

export type { SandboxProvisionerID, SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import {
  type SandboxCheckpointCaptureInput,
  type SandboxCheckpointRestoreInput,
  type SandboxCheckpointResult,
  type SandboxStopInput,
} from "./checkpoint-manager"

export { DEFAULT_WORKSPACE_RUNTIME_PORT }

export type SandboxRegion = string

export type SandboxCaptureScope = "none" | "same-resource" | "filesystem" | "directories"
export type SandboxCaptureSourceBehavior = "not-applicable" | "preserved" | "stopped" | "deleted"
export type SandboxRestoreMountBehavior = "not-applicable" | "same-resource" | "copy-on-write" | "new-resource"

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
  if (input.restoreMount === "copy-on-write" && input.capture !== "directories") {
    return { valid: false as const, reason: "copy-on-write restore requires directory capture" }
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
}

/** @see SandboxDriverMetadata.egressControl */
export type SandboxEgressControl = "none" | "hosts" | "hosts-and-cidrs"

/**
 * What the manager does with a caller's `net` for a given driver: enforce
 * where the driver can, and say so loudly rather than refuse where it cannot.
 *
 *  - `"enforce"` — the driver gets the policy verbatim and contains the
 *    sandbox. Also the answer when the caller asked for no containment
 *    (absent / `allow-all`), which is nothing to enforce.
 *  - `"withhold"` — the driver declares `egressControl: "none"`, so there is no
 *    containment to be had. The policy is NOT handed down: half the `"none"`
 *    drivers throw on a restricted policy (docker, modal, boat) and the
 *    other half silently drop it (cloudflare, the fetch bridge). Withholding at
 *    the manager means the throwing drivers never see one — their throws stay
 *    in place as their own last line of defence — and the silently-dropping
 *    ones stop pretending. The sandbox comes up with UNRESTRICTED egress, which
 *    is a real exposure, so the manager warns (see `onEgressUnenforced`).
 *  - `"refuse"` — the driver HAS egress control but cannot express this
 *    particular policy's encoding (a hosts-only driver handed an address-only
 *    allowlist). Deliberately still fail-closed: this is a composition mistake
 *    on an otherwise-enforcing driver, and degrading it to "withhold" would
 *    weaken the enforcing path. `hostedSandboxNetworkPolicy` only ever emits
 *    hosts, so no production path reaches it.
 *
 * Pure, like `validateSandboxPersistenceCapabilities`, so the manager, the
 * composition layer, and tests can all ask the same question.
 */
export type SandboxEgressDisposition =
  | { action: "enforce" }
  | { action: "withhold"; reason: "sandbox_egress_uncontained" }
  | { action: "refuse"; reason: "sandbox_egress_policy_unenforceable" }

/** @see SandboxEgressDisposition */
export function sandboxEgressDisposition(
  control: SandboxEgressControl,
  net: SandboxNetworkPolicy | undefined,
): SandboxEgressDisposition {
  if (!net || net.mode === "allow-all") return { action: "enforce" }
  if (control === "none") return { action: "withhold", reason: "sandbox_egress_uncontained" }
  const hosts = net.hosts?.length ?? 0
  const cidrs = net.cidrs?.length ?? 0
  // Deny-all: no allowance to express, and every non-"none" driver can block.
  if (hosts === 0 && cidrs === 0) return { action: "enforce" }
  if (hosts > 0) return { action: "enforce" }
  return control === "hosts-and-cidrs"
    ? { action: "enforce" }
    : { action: "refuse", reason: "sandbox_egress_policy_unenforceable" }
}

/**
 * Emitted whenever a restricted egress policy is withheld because the composed
 * driver declares no egress control: an unrestricted sandbox that nobody was
 * told about is the exposure, so the degrade is never silent.
 *
 * Two phases, because a per-create line is easy to miss in request logs:
 *  - `"composition"` — once per `createSandboxManager` per driver, at boot.
 *  - `"ensure"` — every time a caller's policy is actually withheld, naming the
 *    workspace and the allowlist that did not take effect.
 */
export type SandboxEgressUnenforcedEvent = {
  phase: "composition" | "ensure"
  reason: "sandbox_egress_uncontained"
  /** `SandboxDriver.id` of the composed driver. */
  driver: string
  /** Always `"none"` today — carried so a sink can group without re-deriving. */
  egressControl: SandboxEgressControl
  /** Ready-to-log sentence. Sinks that only forward text can use this alone. */
  message: string
  /** Present on `"ensure"`. */
  workspaceId?: string
  /** The allowlist the caller asked for and did NOT get. Present on `"ensure"`. */
  requested?: SandboxNetworkPolicy
}

/**
 * A credential the SANDBOX must be able to USE for outbound requests but must
 * NEVER be able to READ. Unlike `env` (plaintext, readable — reserved for
 * credentials the agent is trusted with, e.g. the user's own model
 * subscription), a brokered secret's `value` never enters the sandbox: the
 * provider injects it on egress to `hosts` only. Non-model credentials
 * (connection tokens, deploy tokens) belong here.
 *
 * Guarantees enforced by the manager: brokered secrets are never written to
 * labels, never logged, and never captured in a driver snapshot. A driver
 * whose `metadata.secretBrokering` is not `"native"` cannot honor them and the
 * manager refuses to provision (fail-closed).
 */
export type SandboxBrokeredSecret = {
  /** Env var name the sandbox references. */
  name: string
  /** The secret material. Never enters the sandbox in plaintext. */
  value: string
  /** Egress allowlist: the only hosts for which the value is substituted/injected. */
  hosts: string[]
  /**
   * The HTTP header the value is injected as on egress to `hosts`. Every
   * native driver needs one and refuses a secret without it.
   */
  header?: string
  /**
   * The authentication scheme `header` carries, when it has one (`Bearer`).
   *
   * A driver that WRITES the whole header composes `"<scheme> <value>"`; one
   * that SUBSTITUTES a placeholder the sandbox already wrote after the scheme
   * ignores it, because the scheme is in the request before the value is.
   */
  scheme?: string
  /**
   * The methods and path prefixes the credential may be attached to, on top of
   * `hosts`. A vendor host serves far more than the routes a turn needs —
   * api.anthropic.com also answers the organization-admin API — and everything
   * sharing the sandbox reaches the same host.
   *
   * Optional so a producer that has not been taught to state a policy still
   * type-checks, and fails closed instead: a driver that can express them
   * attaches the credential only within them, so an absent or empty policy
   * names a host and nothing else, and nothing is spendable at a host alone. A
   * driver whose provider cannot express them documents that it drops them,
   * and the host allowlist is all the containment there is.
   */
  methods?: readonly string[]
  pathPrefixes?: readonly string[]
}

/**
 * What the sandbox presents so a header-injecting driver recognizes the request
 * as one asking for that secret.
 *
 * Carries no authority: the value is attached at the edge, keyed by the host
 * and this string, and the string itself is never accepted by a vendor. The
 * Cloudflare sandbox Worker is deployed on its own and cannot depend on this
 * package, so it matches on its own copy of the prefix; a driver minting
 * anything else sends every brokered request upstream bare, which is what
 * `brokered-placeholder.test.ts` exists to catch.
 */
export function brokeredSecretPlaceholder(name: string) {
  return `claxedo-broker:${name}`
}

/** The environment a header-injecting driver must add so the sandbox can present each secret. */
export function brokeredPlaceholderEnv(
  secrets: readonly SandboxBrokeredSecret[] | undefined,
): Record<string, string> {
  return Object.fromEntries((secrets ?? []).map((secret) => [secret.name, brokeredSecretPlaceholder(secret.name)]))
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
}

/**
 * One lease epoch's start as far as it has been observed. Persisted because a
 * start outlives the ensure call that began it: a driver that answers
 * "provisioning" is polled again from another request, often another isolate.
 */
export type SandboxStartProgress = {
  startedAt: number
  bootMode: SandboxBootMode
  /** When the last phase the control plane itself observed ended; the next one is timed from here. */
  markedAt: number
  phases: SandboxStartPhase[]
}

export type SandboxStartPhaseEvent = SandboxPhaseTiming<SandboxStartPhase> & {
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
}

export type SandboxLeaseAcquireResult =
  | { acquired: true; lease: SandboxLease }
  | { acquired: false; lease: SandboxLease; retryAfterMs: number }

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

export type SandboxNetworkPolicy = {
  mode: "allow-all" | "restricted"
  hosts?: string[]
  cidrs?: string[]
}

/** Brokered destinations are the minimum egress needed to use the credential. */
export function sandboxNetworkPolicyWithBrokeredHosts(
  policy: SandboxNetworkPolicy,
  secrets: readonly SandboxBrokeredSecret[] | undefined,
): SandboxNetworkPolicy {
  if (policy.mode !== "restricted" || !secrets?.length) return policy
  const hosts = [...new Set([
    ...(policy.hosts ?? []),
    ...secrets.flatMap((secret) => secret.hosts),
  ])].toSorted()
  return {
    ...policy,
    ...(hosts.length ? { hosts } : {}),
  }
}

export type SandboxBootSource =
  | { kind: "image"; image: string }
  | { kind: "driver-snapshot"; snapshotId: string }
  | { kind: "default" }

export type SandboxSource = { kind: "git"; repoUrl: string; branch?: string } | { kind: "empty" }

export type SandboxDriverEnsureInput = {
  /** Await before readiness polling so the manager can durably fence the resource identity. */
  onResource?: (resource: Omit<SandboxProvisionedTarget, "url" | "persistence">) => Promise<void>
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

export type SandboxSnapshotResult = { snapshotId: string }
export type SandboxCommandResult = { stdout: string; stderr: string; exitCode: number }

// A driver places and manages the sandbox process. It is deliberately
// not a sandbox remote-control API; files, PTYs, sessions, and agent work go
// through @claxedo/workspace-runtime over the relay.
export type SandboxDriver = {
  id: string
  metadata: SandboxDriverMetadata
  ensureHost: (
    input: SandboxDriverEnsureInput,
  ) => Promise<SandboxTarget | { provisioning: true; retryAfterMs: number }>
  resumeHost?: (input: {
    lease: SandboxLease
    ensure: SandboxDriverEnsureInput
  }) => Promise<SandboxTarget | { provisioning: true; retryAfterMs: number }>
  list?: () => Promise<SandboxTarget[]>
  touch?: (target: SandboxTarget) => Promise<void>
  suspend?: (target: SandboxTarget) => Promise<void>
  /**
   * Stops the host; given `epoch`, a host that a newer lease generation already
   * took over keeps running. `checkpoint` names the snapshot the lease references.
   */
  stop?: (target: SandboxTarget & { epoch?: number; checkpoint?: string }) => Promise<void>
  destroy?: (target: SandboxResource) => Promise<void>
  /** `committed` names the snapshot the lease references now; a driver tracking uncommitted snapshots drops the rest. */
  snapshot?: (target: SandboxTarget, committed?: string) => Promise<SandboxSnapshotResult>
  /** Deletes a snapshot `snapshot` returned; implemented by drivers whose snapshots outlive their sandbox. */
  deleteSnapshot?: (target: SandboxResource, snapshotId: string) => Promise<void>
  inspect?: (target: SandboxTarget) => Promise<SandboxTarget | undefined>
  exec?: (target: SandboxTarget, command: string) => Promise<SandboxCommandResult>
  clone?: (target: SandboxTarget, input: { name: string }) => Promise<SandboxTarget>
}

export type SandboxManager = {
  ensure: (workspaceId: string, input: SandboxManagerInput) => Promise<SandboxEnsureResult>
  register: (workspaceId: string, input: SandboxRuntimeSnapshotInput) => Promise<SandboxMutationResult>
  heartbeat: (workspaceId: string, input: SandboxRuntimeSnapshotInput) => Promise<SandboxMutationResult>
  target: (workspaceId: string) => Promise<SandboxTargetResult>
  touch: (workspaceId: string) => Promise<SandboxTouchResult>
  snapshot: (workspaceId: string, committed?: string) => Promise<SandboxSnapshotManagerResult>
  checkpoint: (workspaceId: string, input: SandboxCheckpointCaptureInput) => Promise<SandboxCheckpointResult>
  restore: (workspaceId: string, input: SandboxCheckpointRestoreInput) => Promise<SandboxCheckpointResult>
  stop: (workspaceId: string, input?: SandboxStopInput) => Promise<SandboxMutationResult>
  destroy: (workspaceId: string) => Promise<SandboxMutationResult>
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
  source?: SandboxSource
  exposure?: SandboxExposure
  /**
   * @see SandboxDriverEnsureInput.net — enforced by a capable driver, withheld
   * (with a warning) by one that declares `egressControl: "none"`.
   */
  net?: SandboxNetworkPolicy
  snapshot?: string
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
  | { status: "unavailable"; retryAfterMs?: number; error?: string; epoch?: number; homeRegion: SandboxRegion }

export type SandboxTargetResult =
  | ({ status: "ready" } & SandboxTarget & { epoch: number; routingId?: string; homeRegion: SandboxRegion })
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

/**
 * A driver's ensure throws this shape when the runtime process exited before it
 * was ever ready. The cause is in the boot itself (a repository credential that
 * is gone, a branch that does not exist), so polling the driver again cannot
 * heal it. Structural for the reason `SandboxListingUnsupported` is.
 */
export type SandboxRuntimeBootFailure = { runtimeBootFailed: true; message: string }

export function isSandboxRuntimeBootFailure(err: unknown): err is SandboxRuntimeBootFailure {
  return !!err && typeof err === "object" && (err as { runtimeBootFailed?: unknown }).runtimeBootFailed === true
}

export class SandboxRuntimeBootError extends Error implements SandboxRuntimeBootFailure {
  readonly runtimeBootFailed = true as const
  constructor(reason: string) {
    super(reason)
    this.name = "SandboxRuntimeBootError"
  }
}

/** Leads the error an ensure reports, and a lease keeps, for a runtime whose boot failed. */
const RUNTIME_BOOT_FAILED = "runtime_boot_failed: "

export function sandboxRuntimeBootFailedError(reason: string) {
  return `${RUNTIME_BOOT_FAILED}${reason}`
}

/** The boot's own reason when an ensure error says a runtime's boot failed. */
export function sandboxRuntimeBootFailure(error: string | undefined) {
  return error?.startsWith(RUNTIME_BOOT_FAILED) ? error.slice(RUNTIME_BOOT_FAILED.length) : undefined
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
}

