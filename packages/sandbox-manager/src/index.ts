import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "./constants"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"

export type { SandboxProvisionerID, SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import {
  captureSandboxCheckpoint,
  restoreSandboxCheckpoint,
  type SandboxCheckpointCaptureInput,
  type SandboxCheckpointRestoreInput,
  type SandboxCheckpointResult,
} from "./checkpoint-manager"
import { applySandboxRuntimeSnapshot } from "./runtime-snapshot"
import { workspaceRuntimeIdentityEnvConflicts } from "./runtime-env"

export { DEFAULT_WORKSPACE_RUNTIME_PORT }
export * from "./checkpoint-manager"
export * from "./hosted-network-policy"
export * from "./runtime-snapshot"

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
    retentionExpiresAt?: number
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
   *   with no extra infrastructure of ours: Daytona secret placeholders,
   *   Vercel firewall header transforms, Cloudflare outbound handlers reading
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
   * - `"hosts-and-cidrs"` — the provider filters by name AND by address
   *   (Daytona: `domainAllowList` + `networkAllowList`).
   * - `"hosts"` — the provider filters by hostname only (Vercel firewall).
   * - `"none"` — the driver cannot express an egress allowlist. This covers
   *   BOTH drivers that throw when handed a restricted policy (exe, docker,
   *   box, and modal for host policy) AND — more dangerously — drivers that
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
 *    drivers throw on a restricted policy (exe, docker, modal, box) and the
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

function egressUnenforcedMessage(input: {
  phase: "composition" | "ensure"
  driver: string
  workspaceId?: string
  requested?: SandboxNetworkPolicy
}) {
  const scope = input.workspaceId ? `workspace ${input.workspaceId}` : "every sandbox it provisions"
  const withheld = input.requested
    ? ` The requested allowlist (${(input.requested.hosts ?? []).length} host(s), ` +
      `${(input.requested.cidrs ?? []).length} cidr(s)) was withheld, not applied.`
    : ""
  return (
    `[sandbox-manager] SANDBOX EGRESS IS UNRESTRICTED: driver "${input.driver}" declares ` +
    `egressControl: "none", so ${scope} can reach ANY host on the internet, including ` +
    `attacker-controlled buckets — agent-authored code inside the sandbox has an unmonitored ` +
    `exfiltration path.${withheld} Select a driver that can enforce egress (daytona, vercel) ` +
    `to close it. See public-docs/sandbox-egress.md.`
  )
}

/**
 * Drivers already warned about at composition time, so a control plane that
 * composes its services per request (the hosted Worker does) logs the boot
 * warning once per isolate instead of once per request. Keyed by driver id +
 * declared capability, never by workspace: the per-create `"ensure"` warning is
 * deliberately NOT deduped.
 */
const compositionEgressWarnings = new Set<string>()

function defaultEgressUnenforcedSink(event: SandboxEgressUnenforcedEvent) {
  console.warn(event.message)
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
  /** Env var name the sandbox references (Daytona placeholder key). */
  name: string
  /** The secret material. Never enters the sandbox in plaintext. */
  value: string
  /** Egress allowlist: the only hosts for which the value is substituted/injected. */
  hosts: string[]
  /**
   * When set, the value is injected as this HTTP header on egress to `hosts`
   * (required for the Vercel firewall-transform model). When omitted, the
   * driver exposes the credential via its native placeholder mechanism for
   * the sandbox to attach itself (Daytona).
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

/**
 * The environment a header-injecting driver must add so the sandbox can present
 * each secret. Daytona is absent from this: its own mount fills the same
 * variables with the placeholder it substitutes, and an env entry would shadow
 * it with a string Daytona does not know.
 */
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
}

export type SandboxLeaseAcquireInput = {
  homeRegion: SandboxRegion
  driver: string
  staleAfterMs: number
  now?: number
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
 * `SandboxLeaseStore.recordTarget`, whose argument is a driver's answer.
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
    updatedAt,
  }
}

/**
 * The provider resource a driver answered with, and the only shape that can
 * put identity on a lease. Every field is the driver's, taken from one
 * `ensureHost`/`resumeHost` answer, so a lease's identity is always one
 * coherent record of one provisioning cycle rather than fields accumulated
 * from separate callers.
 */
export type SandboxProvisionedTarget = {
  sandboxId: string
  url: string
  hostId: string
  driverResourceId?: string
  labels: Record<string, string>
  persistence?: SandboxPersistenceCapabilities
}

/**
 * Canonical "this lease now serves this resource" transition, shared by every
 * lease store driver: identity, the labels it was placed with, and the end of
 * whatever retry state the acquire was in.
 */
export function applySandboxProvisionedTarget(
  current: SandboxLease,
  target: SandboxProvisionedTarget,
  updatedAt: number,
): SandboxLease {
  return {
    ...current,
    status: "ready",
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
  stop?: (target: SandboxTarget) => Promise<void>
  destroy?: (target: SandboxTarget) => Promise<void>
  snapshot?: (target: SandboxTarget) => Promise<SandboxSnapshotResult>
  inspect?: (target: SandboxTarget) => Promise<SandboxTarget | undefined>
  exec?: (target: SandboxTarget, command: string) => Promise<SandboxCommandResult>
  clone?: (target: SandboxTarget, input: { name: string }) => Promise<SandboxTarget>
}

/**
 * The lifecycle operations that coalesce per workspace. Two result shapes cover
 * all four kinds, which is what lets a joining caller be typed without an
 * assertion.
 */
type LifecycleOperation =
  | { kind: "checkpoint" | "restore"; promise: Promise<SandboxCheckpointResult> }
  | { kind: "stop" | "destroy"; promise: Promise<SandboxMutationResult> }

export type SandboxManager = {
  ensure: (workspaceId: string, input: SandboxManagerInput) => Promise<SandboxEnsureResult>
  register: (workspaceId: string, input: SandboxRuntimeSnapshotInput) => Promise<SandboxMutationResult>
  heartbeat: (workspaceId: string, input: SandboxRuntimeSnapshotInput) => Promise<SandboxMutationResult>
  target: (workspaceId: string) => Promise<SandboxTargetResult>
  touch: (workspaceId: string) => Promise<SandboxTouchResult>
  snapshot: (workspaceId: string) => Promise<SandboxSnapshotManagerResult>
  checkpoint: (workspaceId: string, input: SandboxCheckpointCaptureInput) => Promise<SandboxCheckpointResult>
  restore: (workspaceId: string, input: SandboxCheckpointRestoreInput) => Promise<SandboxCheckpointResult>
  stop: (workspaceId: string) => Promise<SandboxMutationResult>
  destroy: (workspaceId: string) => Promise<SandboxMutationResult>
  release: (workspaceId: string) => Promise<{ released: boolean }>
  garbageCollect: () => Promise<SandboxGarbageCollectResult>
  list: () => Promise<SandboxLease[]>
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
  | ({ status: "ready" } & SandboxTarget & { epoch: number; homeRegion: SandboxRegion })
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
export type SandboxMutationResult = { ok: true; status: SandboxLeaseStatus } | { ok: false; reason: string }
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
}

const DEFAULT_APP_LABEL = "claxedo"

function sandboxId(driver: string, workspaceId: string) {
  return `${driver}-${workspaceId}`
}

/**
 * Build the driver-facing ensure input.
 *
 * This is the ONLY place a `SandboxDriverEnsureInput` is constructed, which is
 * what makes the egress guarantee structural rather than a promise kept by each
 * call site: `net` is copied across only when `sandboxEgressDisposition` says
 * the driver can enforce it. A driver declaring `egressControl: "none"` — every
 * driver that throws on a restricted policy, plus the two that silently drop it
 * — cannot be reached by one through any path.
 */
function ensureHostInput(input: {
  driver: SandboxDriver
  workspaceId: string
  lease: SandboxLease
  homeRegion: SandboxRegion
  managerInput?: SandboxManagerInput
  appLabel: string
}): SandboxDriverEnsureInput {
  const egress = sandboxEgressDisposition(input.driver.metadata.egressControl, input.managerInput?.net)
  const labels = {
    app: input.appLabel,
    workspaceId: input.workspaceId,
    epoch: String(input.lease.epoch),
    homeRegion: input.homeRegion,
    ...input.managerInput?.labels,
  }
  return {
    workspaceId: input.workspaceId,
    hostId: input.managerInput?.hostId ?? input.lease.hostId ?? sandboxId(input.driver.id, input.workspaceId),
    homeRegion: input.homeRegion,
    epoch: input.lease.epoch,
    labels,
    bootSource: input.managerInput?.bootSource
      ?? (
        input.lease.checkpoint
        && input.lease.status !== "ready"
        && input.driver.metadata.persistence.resume === "replacement-restore"
          ? { kind: "driver-snapshot", snapshotId: input.lease.checkpoint.providerReference }
          : { kind: "default" }
      ),
    workspaceRoot: input.managerInput?.workspaceRoot ?? "/workspace",
    runtimeCwd: input.managerInput?.runtimeCwd,
    workspaceRuntimePort: input.managerInput?.workspaceRuntimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT,
    env: input.managerInput?.env ?? {},
    // Brokered secrets ride their own channel — NEVER merged into labels or env.
    // Presence of the key, not its length, is the signal: `[]` is the caller
    // withdrawing every brokered secret, and dropping it would reach the driver
    // as "preserve what you have".
    ...(input.managerInput?.secrets ? { secrets: input.managerInput.secrets } : {}),
    source: input.managerInput?.source,
    exposure:
      input.managerInput?.exposure ??
      (input.driver.metadata.targetAccess === "loopback" ? { kind: "loopback" } : { kind: "relay" }),
    // Withheld, never downgraded: `undefined` here is the same shape a caller
    // that asked for no containment produces, so the throwing drivers take
    // their allow-all path and their throws stay intact for anyone who hands
    // them a policy directly.
    ...(egress.action === "enforce" && input.managerInput?.net
      ? { net: sandboxNetworkPolicyWithBrokeredHosts(input.managerInput.net, input.managerInput.secrets) }
      : {}),
    snapshot: input.managerInput?.snapshot,
  }
}

export function createSandboxManager(options: SandboxManagerOptions): SandboxManager {
  const persistence = validateSandboxPersistenceCapabilities(options.driver.metadata.persistence)
  if (!persistence.valid) throw new Error(`Invalid sandbox persistence capabilities: ${persistence.reason}`)
  const staleAfterMs = options.staleAfterMs ?? 60_000
  const retryAfterMs = options.retryAfterMs ?? 2_000
  const now = options.now ?? Date.now
  const retryDelayMs =
    options.retryDelayMs ?? ((retryCount) => Math.min(60_000, 1_000 * 2 ** Math.max(0, retryCount - 1)))
  const maxRetryCount = options.maxRetryCount ?? Number.POSITIVE_INFINITY
  const retryCapCooldownMs = options.retryCapCooldownMs ?? 10 * 60_000
  const egressControl = options.driver.metadata.egressControl
  const onEgressUnenforced = options.onEgressUnenforced ?? defaultEgressUnenforcedSink
  /**
   * At most one lifecycle operation per workspace: a second request of the SAME
   * kind joins the one in flight, a different kind queues behind it. The entry
   * pairs the kind with a promise of that kind's result, so a joining caller
   * gets the right type from the overloads on `lifecycle` instead of an
   * assertion about a promise nobody re-checked.
   */
  const lifecycleOperations = new Map<string, LifecycleOperation>()

  function reportEgressUnenforced(input: { workspaceId: string; requested: SandboxNetworkPolicy }) {
    onEgressUnenforced({
      phase: "ensure",
      reason: "sandbox_egress_uncontained",
      driver: options.driver.id,
      egressControl,
      message: egressUnenforcedMessage({
        phase: "ensure",
        driver: options.driver.id,
        workspaceId: input.workspaceId,
        requested: input.requested,
      }),
      workspaceId: input.workspaceId,
      requested: input.requested,
    })
  }

  // Boot-time half of the warning. A per-create line lands in request logs and
  // is easy to miss; this one lands wherever the process starts, so an operator
  // who composed cloudflare/exe/box/docker/modal learns that this deployment
  // runs sandboxes with unrestricted egress BEFORE the first workspace exists.
  if (egressControl === "none") {
    const key = `${options.driver.id}|${egressControl}`
    if (!compositionEgressWarnings.has(key)) {
      compositionEgressWarnings.add(key)
      onEgressUnenforced({
        phase: "composition",
        reason: "sandbox_egress_uncontained",
        driver: options.driver.id,
        egressControl,
        message: egressUnenforcedMessage({ phase: "composition", driver: options.driver.id }),
      })
    }
  }

  /** A different kind queues behind whatever is already running for the workspace. */
  function lifecycleQueue(current: LifecycleOperation | undefined) {
    return current?.promise.catch(() => undefined) ?? Promise.resolve()
  }

  function lifecycleSettle<T>(workspaceId: string, entry: LifecycleOperation, operation: Promise<T>) {
    lifecycleOperations.set(workspaceId, entry)
    return operation.finally(() => {
      if (lifecycleOperations.get(workspaceId) === entry) lifecycleOperations.delete(workspaceId)
    })
  }

  function checkpointLifecycle(
    workspaceId: string,
    kind: "checkpoint" | "restore",
    run: () => Promise<SandboxCheckpointResult>,
  ): Promise<SandboxCheckpointResult> {
    const current = lifecycleOperations.get(workspaceId)
    if (current?.kind === kind) return current.promise
    const operation = lifecycleQueue(current).then(run)
    return lifecycleSettle(workspaceId, { kind, promise: operation }, operation)
  }

  function mutationLifecycle(
    workspaceId: string,
    kind: "stop" | "destroy",
    run: () => Promise<SandboxMutationResult>,
  ): Promise<SandboxMutationResult> {
    const current = lifecycleOperations.get(workspaceId)
    if (current?.kind === kind) return current.promise
    const operation = lifecycleQueue(current).then(run)
    return lifecycleSettle(workspaceId, { kind, promise: operation }, operation)
  }

  async function leaseTarget(lease: SandboxLease): Promise<SandboxTargetResult> {
    if (lease.status !== "ready" || !lease.sandboxId || !lease.url || !lease.hostId) {
      return {
        status: "unavailable",
        reason: "runtime_lease_not_ready",
        leaseStatus: lease.status,
        ...(lease.nextRetryAt !== undefined ? { retryAfterMs: Math.max(0, lease.nextRetryAt - now()) } : {}),
      }
    }
    return {
      status: "ready",
      sandboxId: lease.sandboxId,
      url: lease.url,
      workspaceId: lease.workspaceId,
      hostId: lease.hostId,
      driverResourceId: lease.driverResourceId,
      labels: lease.labels,
      driver: {
        id: lease.driver,
        resourceId: lease.driverResourceId ?? lease.sandboxId,
      },
      epoch: lease.epoch,
      homeRegion: lease.homeRegion,
    }
  }

  // The boot path this lease is on, derived from the lease row alone. Used by
  // the early-return provisioning branches (in-flight backoff, lost acquire
  // race) that answer BEFORE provision() runs — i.e. most polls after the
  // first — so the connect UI keeps its honest label across the whole wait.
  // Mirrors the predicates provision() uses when no caller bootSource is set:
  // ensureHostInput's driver-snapshot default and provision()'s `resuming`.
  function leaseBootMode(lease: SandboxLease): SandboxBootMode {
    const restoring =
      Boolean(lease.checkpoint)
      && lease.status !== "ready"
      && options.driver.metadata.persistence.resume === "replacement-restore"
    if (restoring) return "restore"
    if (lease.sandboxId && options.driver.resumeHost) return "resume"
    return "cold-start"
  }

  // Runs driver ensure/resume for an owned lease epoch and records the
  // outcome. Shared by the fresh-acquire path, the ready-lease resume path,
  // and the in-flight provisioning re-poll path.
  async function provision(
    workspaceId: string,
    lease: SandboxLease,
    homeRegion: SandboxRegion,
    managerInput?: SandboxManagerInput,
  ): Promise<SandboxEnsureResult> {
    try {
      const ensure = ensureHostInput({
        driver: options.driver,
        workspaceId,
        homeRegion,
        lease,
        managerInput,
        appLabel: options.appLabel ?? DEFAULT_APP_LABEL,
      })
      // Fail-closed: a brokered secret must never be downgraded to readable
      // plaintext env. Daytona, Vercel and Cloudflare all keep the value out of
      // the sandbox through their own provider edge, and ONLY an explicit
      // `"native"` declaration means the driver can do the same — a missing or
      // unrecognized capability refuses here rather than expose the credential.
      //
      // An EMPTY list is a withdrawal, not a delivery, and passes: a driver
      // that cannot broker has nothing to withdraw either.
      if (ensure.secrets?.length && options.driver.metadata.secretBrokering !== "native") {
        return {
          status: "unavailable",
          error: "secret_brokering_unsupported",
          epoch: lease.epoch,
          homeRegion,
        }
      }
      const resuming = Boolean(lease.sandboxId && ensure.bootSource?.kind === "default" && options.driver.resumeHost)
      const target = resuming
        ? await options.driver.resumeHost!({ lease, ensure })
        : await options.driver.ensureHost(ensure)
      if ("provisioning" in target) {
        await options.leaseStore.update(workspaceId, lease.epoch, {
          status: "acquiring",
          nextRetryAt: now() + target.retryAfterMs,
        })
        return {
          status: "provisioning",
          retryAfterMs: target.retryAfterMs,
          epoch: lease.epoch,
          homeRegion,
          // Honest progress for the connect UI: which of the three boot paths
          // this cycle is on. Derived from the same inputs that CHOSE the path
          // above, so it cannot drift from what actually ran.
          bootMode: resuming ? "resume" : ensure.bootSource?.kind === "driver-snapshot" ? "restore" : "cold-start",
        }
      }
      const updated = await options.leaseStore.recordTarget(workspaceId, lease.epoch, {
        sandboxId: target.sandboxId,
        url: target.url,
        hostId: target.hostId,
        driverResourceId: target.driverResourceId,
        // The placement labels win over anything the driver echoed back: `app`,
        // `workspaceId` and `epoch` are what garbage collection reads to decide
        // whether a live sandbox belongs to this deployment, and a driver that
        // returned its own label set would otherwise decide that answer.
        labels: { ...target.labels, ...ensure.labels },
        persistence: options.driver.metadata.persistence,
      })
      if (!updated) return { status: "unavailable", error: "runtime_lease_changed", epoch: lease.epoch, homeRegion }
      const resolved = await leaseTarget(updated)
      if (resolved.status === "ready") return resolved
      return {
        status: "unavailable",
        error: resolved.reason,
        epoch: lease.epoch,
        homeRegion,
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (lease.status === "ready") {
        // A single resume blip must not demote a serving lease: the existing
        // ready target keeps resolving for relay routing while we record the
        // error for observability only. Cold-create/acquiring failures below
        // keep the demotion + backoff behaviour.
        const updated = await options.leaseStore.update(workspaceId, lease.epoch, { lastError: error }, "ready")
        if (updated) {
          const resolved = await leaseTarget(updated)
          if (resolved.status === "ready") return { ...resolved, stale: true }
        }
      }
      const nextRetryCount = lease.retryCount + 1
      const retryCapped = nextRetryCount >= maxRetryCount
      const failed = await options.leaseStore.recordFailure(
        workspaceId,
        lease.epoch,
        error,
        now() + (retryCapped ? retryCapCooldownMs : retryDelayMs(nextRetryCount)),
      )
      return {
        status: "unavailable",
        retryAfterMs: failed?.nextRetryAt ? Math.max(0, failed.nextRetryAt - now()) : retryAfterMs,
        error,
        epoch: lease.epoch,
        homeRegion,
      }
    }
  }

  return {
    async ensure(workspaceId, input) {
      // Egress disposition, decided BEFORE a lease is acquired.
      //
      // A caller that hands us a restricted policy is stating that this sandbox
      // must not reach the open internet. That is honoured where the driver can
      // honour it and made LOUD — not fatal — where it cannot: refusing the
      // create outright would take the most likely production driver
      // (cloudflare, preferred by `defaultSandboxDriverName`) offline entirely.
      //
      // The withholding itself happens in `ensureHostInput`; the warning is
      // raised here so it fires exactly once per create rather than once per
      // driver retry.
      const egress = sandboxEgressDisposition(options.driver.metadata.egressControl, input.net)
      if (egress.action === "withhold" && input.net) {
        reportEgressUnenforced({ workspaceId, requested: input.net })
      }
      if (egress.action === "refuse") {
        // Still fail-closed, and deliberately so: this driver DOES enforce
        // egress, it just cannot express this policy's encoding. Degrading an
        // enforcing driver to "unrestricted" would weaken the path that does
        // enforce. Not a provisioning failure
        // either — a composition mistake must not burn a lease epoch or enter
        // retry backoff.
        return { status: "unavailable", error: egress.reason, homeRegion: input.homeRegion }
      }
      // Caller env restating the identity the driver's target reports — and
      // `recordTarget` persists — is the same class of composition mistake as
      // the egress refusal: the runtime would boot bound to a hostId the
      // lease never authorized. Refused before a lease is touched; the driver
      // rejects it again at compose time for callers that reach it directly.
      const identityConflicts = workspaceRuntimeIdentityEnvConflicts(input.env)
      if (identityConflicts.length) {
        return {
          status: "unavailable",
          error: `sandbox env cannot set runtime identity: ${identityConflicts.join(", ")}`,
          homeRegion: input.homeRegion,
        }
      }
      const existing = await options.leaseStore.get(workspaceId)
      if (existing?.nextRetryAt && existing.nextRetryAt > now()) {
        if (existing.status === "acquiring") {
          return {
            status: "provisioning",
            retryAfterMs: existing.nextRetryAt - now(),
            epoch: existing.epoch,
            homeRegion: existing.homeRegion,
            bootMode: leaseBootMode(existing),
          }
        }
        return {
          status: "unavailable",
          retryAfterMs: existing.nextRetryAt - now(),
          error: existing.lastError,
          epoch: existing.epoch,
          homeRegion: existing.homeRegion,
        }
      }
      if (
        existing?.status === "unavailable" &&
        existing.retryCount >= maxRetryCount &&
        existing.nextRetryAt === undefined
      ) {
        // Capped lease without a cooldown timestamp (legacy rows): stay
        // unavailable until an operator releases the lease.
        return {
          status: "unavailable",
          error: existing.lastError ?? "runtime_retry_cap_exceeded",
          epoch: existing.epoch,
          homeRegion: existing.homeRegion,
        }
      }
      if (existing?.status === "ready") {
        // Lazy resume: sandbox services can auto-stop/sleep runtimes, so a ready lease
        // must still be re-ensured through the driver (same epoch).
        return provision(workspaceId, existing, existing.homeRegion, input)
      }
      if (
        existing?.status === "acquiring" &&
        existing.nextRetryAt !== undefined &&
        now() - existing.updatedAt < staleAfterMs
      ) {
        // The driver reported provisioning earlier and the retry time has
        // arrived: continue the in-flight provision on the same epoch instead
        // of waiting for staleness (which would bump the epoch and orphan the
        // first sandbox).
        return provision(workspaceId, existing, existing.homeRegion, input)
      }
      const acquired = await options.leaseStore.acquire(workspaceId, {
        homeRegion: input.homeRegion,
        driver: options.driver.id,
        staleAfterMs,
        now: now(),
      })
      if (!acquired.acquired) {
        return {
          status: "provisioning",
          retryAfterMs: acquired.retryAfterMs,
          epoch: acquired.lease.epoch,
          homeRegion: acquired.lease.homeRegion,
          bootMode: leaseBootMode(acquired.lease),
        }
      }
      return provision(workspaceId, acquired.lease, input.homeRegion, input)
    },
    async register(workspaceId, input) {
      return await runtimeSnapshot(workspaceId, input)
    },
    async heartbeat(workspaceId, input) {
      return await runtimeSnapshot(workspaceId, input)
    },
    async target(workspaceId) {
      const lease = await options.leaseStore.get(workspaceId)
      if (!lease) return { status: "unavailable", reason: "runtime_lease_missing" }
      return leaseTarget(lease)
    },
    async touch(workspaceId) {
      const target = await this.target(workspaceId)
      if (target.status !== "ready") return { touched: false, status: "missing" }
      await options.driver.touch?.(target)
      return { touched: true, status: "ready" }
    },
    async snapshot(workspaceId) {
      const target = await this.target(workspaceId)
      if (target.status !== "ready") return { ok: false, reason: target.reason }
      if (!options.driver.snapshot) return { ok: false, reason: "snapshot_unsupported" }
      return { ok: true, ...(await options.driver.snapshot(target)) }
    },
    async checkpoint(workspaceId, input) {
      return await checkpointLifecycle(workspaceId, "checkpoint", () => captureSandboxCheckpoint({
        workspaceId,
        request: input,
        leaseStore: options.leaseStore,
        target: (id) => this.target(id),
        snapshot: (id) => this.snapshot(id),
        now,
      }))
    },
    async restore(workspaceId, input) {
      return await checkpointLifecycle(workspaceId, "restore", () => restoreSandboxCheckpoint({
        workspaceId,
        request: input,
        leaseStore: options.leaseStore,
        ensure: (id, next) => this.ensure(id, next),
        now,
      }))
    },
    async stop(workspaceId) {
      return await mutationLifecycle(workspaceId, "stop", async () => {
        const lease = await options.leaseStore.get(workspaceId)
        if (lease?.status === "stopped") return { ok: true as const, status: "stopped" as const }
        const target = await this.target(workspaceId)
        if (target.status !== "ready") return { ok: false as const, reason: target.reason }
        if (options.driver.metadata.hostStopBehavior !== "not-supported") {
          await (options.driver.suspend ?? options.driver.stop)?.(target)
        } else {
          await options.driver.stop?.(target)
        }
        await options.leaseStore.update(workspaceId, target.epoch, { status: "stopped" })
        return { ok: true as const, status: "stopped" as const }
      })
    },
    async destroy(workspaceId) {
      return await mutationLifecycle(workspaceId, "destroy", async () => {
        const lease = await options.leaseStore.get(workspaceId)
        if (lease?.status === "destroyed") return { ok: true as const, status: "destroyed" as const }
        const target = await this.target(workspaceId)
        if (target.status !== "ready") return { ok: false as const, reason: target.reason }
        await options.driver.destroy?.(target)
        await options.leaseStore.update(workspaceId, target.epoch, { status: "destroyed" })
        return { ok: true as const, status: "destroyed" as const }
      })
    },
    async release(workspaceId) {
      const lease = await options.leaseStore.get(workspaceId)
      if (!lease) return { released: false }
      await options.leaseStore.release(workspaceId)
      return { released: true }
    },
    async garbageCollect() {
      if (!options.driver.list) {
        // A driver that cannot enumerate provider state cannot answer "what is
        // running that shouldn't be?" — so it must not answer "nothing".
        return {
          destroyed: [],
          kept: [],
          skipped: [],
          failed: [],
          listingUnsupported: true as const,
          driver: options.driver.id,
        }
      }
      // Enumerate BEFORE reading leases, and treat a declared listing gap the
      // same as a missing `list()`. A driver whose backing service cannot
      // enumerate (e.g. a sandbox Worker predating its registry route) must not
      // reach the sweep below with an empty list, or every live sandbox looks
      // like an orphan and GC destroys the fleet.
      let listed: SandboxTarget[]
      try {
        listed = await options.driver.list()
      } catch (err) {
        if (!isSandboxListingUnsupported(err)) throw err
        return {
          destroyed: [],
          kept: [],
          skipped: [],
          failed: [],
          listingUnsupported: true as const,
          driver: options.driver.id,
        }
      }
      const leases = new Map((await options.leaseStore.list()).map((lease) => [lease.workspaceId, lease]))
      const result: SandboxGarbageCollectResult = {
        destroyed: [],
        kept: [],
        skipped: [],
        failed: [],
      }
      const appLabel = options.appLabel ?? DEFAULT_APP_LABEL
      for (const target of listed) {
        if (target.labels?.app !== appLabel) {
          result.skipped.push({ target, reason: "unmanaged_app_label" })
          continue
        }
        const workspaceId = target.labels.workspaceId
        const epoch = target.labels.epoch
        if (!workspaceId || !epoch) {
          result.skipped.push({ target, reason: "missing_runtime_labels" })
          continue
        }
        const lease = leases.get(workspaceId)
        // Provider labels are create-time state: a driver that reuses a
        // resource across an epoch bump (a restore that keeps the same
        // Daytona sandbox, a resume after stop) cannot retag it atomically
        // with the reuse, so `labels.epoch` can lag the lease even after the
        // driver rewrote it — the sweep can simply land first. The lease
        // store is authoritative for which provider resource a workspace
        // owns: a listed sandbox the lease still names is in service whatever
        // its labels claim. Only a "destroyed" lease disclaims the resource —
        // a remnant of it is exactly what this sweep exists to finish.
        const leaseOwnsResource =
          lease !== undefined && lease.status !== "destroyed" && (
            lease.sandboxId === target.sandboxId ||
            (lease.driverResourceId !== undefined && lease.driverResourceId === target.driverResourceId)
          )
        if (leaseOwnsResource) {
          result.kept.push(target)
          continue
        }
        if (lease?.status === "acquiring" && String(lease.epoch) === epoch) {
          // An in-flight provision for the current epoch is live even though
          // the lease does not carry host/sandbox identity yet.
          result.kept.push(target)
          continue
        }
        if (!options.driver.destroy) {
          result.skipped.push({ target, reason: "destroy_unsupported" })
          continue
        }
        try {
          await options.driver.destroy(target)
          result.destroyed.push(target)
        } catch (err) {
          result.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return result
    },
    list: () => options.leaseStore.list(),
  }

  // A manager's only observer of the sandbox is the sandbox itself, so an
  // unhealthy report demotes the lease and spends no retry budget.
  function runtimeSnapshot(workspaceId: string, snapshot: SandboxRuntimeSnapshotInput) {
    return applySandboxRuntimeSnapshot({ leaseStore: options.leaseStore, workspaceId, snapshot, now })
  }
}
