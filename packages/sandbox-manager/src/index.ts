import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "./constants"
import type { SandboxDriverID } from "./driver-catalog"
import {
  captureSandboxCheckpoint,
  restoreSandboxCheckpoint,
  type SandboxCheckpointCaptureInput,
  type SandboxCheckpointRestoreInput,
  type SandboxCheckpointResult,
} from "./checkpoint-manager"

export { DEFAULT_WORKSPACE_RUNTIME_PORT }
export * from "./checkpoint-manager"
export * from "./hosted-network-policy"

export type SandboxRegion = string
export type SandboxDriverId = SandboxDriverID | "fetch"

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
   * - `"native"` — the provider brokers it automatically on egress to the
   *   allowlisted hosts, with no extra infrastructure: Daytona secret
   *   placeholders + egress proxy; Vercel firewall header transforms. The
   *   driver injects it during `ensureHost`.
   * - `"proxy"` — brokering is achievable but only via a host-operated egress
   *   proxy the driver routes through (Cloudflare's official Worker-proxy
   *   pattern: the sandbox gets a short-lived JWT, egress hits the Worker,
   *   the Worker injects the real credential — the raw value never enters the
   *   sandbox). Not automatic; requires the host's proxy to be wired.
   * - `"none"` — no way to keep the value out of sandbox processes. The
   *   provider may still have an encrypted secret STORE (e.g. Modal secrets),
   *   but those are exposed as readable env vars, so they cannot satisfy the
   *   never-readable contract.
   *
   * The manager fails closed unless the driver actually injects brokered
   * secrets (today: `"native"` only). `"proxy"` records an achievable ceiling
   * that is not yet wired and therefore also fails closed.
   */
  secretBrokering: "native" | "proxy" | "none"
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
 * What the manager does with a caller's `net` for a given driver.
 *
 * Owner directive (2026-07-28): *"for egress in sandbox enforce where we can
 * and document where we cant."* That replaces the previous fail-closed refusal
 * for drivers with no egress control at all — provisioning now proceeds, and
 * the gap is made loud instead of fatal.
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
 * driver declares no egress control. This is the "document where we can't" half
 * of the directive expressed at runtime: an unrestricted sandbox that nobody
 * was told about is the original finding, so the degrade is never silent.
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
 * whose `metadata.secretBrokering !== "native"` cannot honor them and the
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

export type SandboxLeasePatch = Partial<
  Pick<
    SandboxLease,
    | "status"
    | "sandboxId"
    | "url"
    | "hostId"
    | "driverResourceId"
    | "retryCount"
    | "lastHeartbeatAt"
    | "lastActivityAt"
    | "labels"
  >
> & {
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  nextRetryAt?: number | null
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  lastError?: string | null
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  checkpoint?: SandboxCheckpointReference | null
  /** `null` clears the stored value; `undefined` leaves it unchanged. */
  persistence?: SandboxPersistenceCapabilities | null
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
    ...(patch.sandboxId === undefined ? {} : { sandboxId: patch.sandboxId }),
    ...(patch.url === undefined ? {} : { url: patch.url }),
    ...(patch.hostId === undefined ? {} : { hostId: patch.hostId }),
    ...(patch.driverResourceId === undefined ? {} : { driverResourceId: patch.driverResourceId }),
    ...(patch.retryCount === undefined ? {} : { retryCount: patch.retryCount }),
    ...(patch.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: patch.lastHeartbeatAt }),
    ...(patch.lastActivityAt === undefined ? {} : { lastActivityAt: patch.lastActivityAt }),
    ...(patch.labels === undefined ? {} : { labels: patch.labels }),
    ...(patch.nextRetryAt === undefined ? {} : { nextRetryAt: patch.nextRetryAt ?? undefined }),
    ...(patch.lastError === undefined ? {} : { lastError: patch.lastError ?? undefined }),
    ...(patch.checkpoint === undefined ? {} : { checkpoint: patch.checkpoint ?? undefined }),
    ...(patch.persistence === undefined ? {} : { persistence: patch.persistence ?? undefined }),
    ...(patch.restore === undefined ? {} : { restore: patch.restore ?? undefined }),
    updatedAt,
  }
}

export type SandboxLeaseStore = {
  acquire: (workspaceId: string, input: SandboxLeaseAcquireInput) => Promise<SandboxLeaseAcquireResult>
  update: (workspaceId: string, expectedEpoch: number, patch: SandboxLeasePatch) => Promise<SandboxLease | undefined>
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

export type SandboxManager = {
  ensure: (workspaceId: string, input: SandboxManagerInput) => Promise<SandboxEnsureResult>
  register: (workspaceId: string, input: SandboxRegisterInput) => Promise<SandboxMutationResult>
  heartbeat: (workspaceId: string, input: SandboxHeartbeatInput) => Promise<SandboxMutationResult>
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

export type SandboxRegisterInput = {
  epoch?: number
  ok: boolean
  status?: string
  sandboxId?: string | null
  url?: string | null
  hostId?: string | null
  driverResourceId?: string | null
  active?: boolean
  now?: number
}

export type SandboxHeartbeatInput = SandboxRegisterInput

export type SandboxEnsureResult =
  | ({ status: "ready" } & SandboxTarget & { epoch: number; homeRegion: SandboxRegion })
  | { status: "provisioning"; retryAfterMs: number; epoch: number; homeRegion: SandboxRegion }
  | { status: "unavailable"; retryAfterMs?: number; error?: string; epoch?: number; homeRegion: SandboxRegion }

export type SandboxTargetResult =
  | ({ status: "ready" } & SandboxTarget & { epoch: number; homeRegion: SandboxRegion })
  | { status: "unavailable"; reason: string }

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
    ...(input.managerInput?.secrets?.length ? { secrets: input.managerInput.secrets } : {}),
    source: input.managerInput?.source,
    exposure:
      input.managerInput?.exposure ??
      (input.driver.metadata.targetAccess === "loopback" ? { kind: "loopback" } : { kind: "relay" }),
    // Withheld, never downgraded: `undefined` here is the same shape a caller
    // that asked for no containment produces, so the throwing drivers take
    // their allow-all path and their throws stay intact for anyone who hands
    // them a policy directly.
    ...(egress.action === "enforce" && input.managerInput?.net ? { net: input.managerInput.net } : {}),
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
  const lifecycleOperations = new Map<string, {
    kind: "checkpoint" | "restore" | "stop" | "destroy"
    promise: Promise<unknown>
  }>()

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

  function lifecycle<T>(
    workspaceId: string,
    kind: "checkpoint" | "restore" | "stop" | "destroy",
    run: () => Promise<T>,
  ) {
    const current = lifecycleOperations.get(workspaceId)
    if (current?.kind === kind) return current.promise as Promise<T>
    const operation = (current?.promise.catch(() => undefined) ?? Promise.resolve()).then(run)
    lifecycleOperations.set(workspaceId, { kind, promise: operation })
    return operation.finally(() => {
      if (lifecycleOperations.get(workspaceId)?.promise === operation) {
        lifecycleOperations.delete(workspaceId)
      }
    })
  }

  async function leaseTarget(lease: SandboxLease): Promise<SandboxTargetResult> {
    if (lease.status !== "ready" || !lease.sandboxId || !lease.url || !lease.hostId) {
      return { status: "unavailable", reason: "runtime_lease_not_ready" }
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
      // plaintext env. `"native"` (Daytona/Vercel — transparent egress) and
      // `"proxy"` (Cloudflare — Worker egress proxy) both keep the value out
      // of the sandbox; only `"none"` cannot, so it alone refuses here rather
      // than expose the credential.
      if (ensure.secrets?.length && options.driver.metadata.secretBrokering === "none") {
        return {
          status: "unavailable",
          error: "secret_brokering_unsupported",
          epoch: lease.epoch,
          homeRegion,
        }
      }
      const target =
        lease.sandboxId && ensure.bootSource?.kind === "default" && options.driver.resumeHost
          ? await options.driver.resumeHost({ lease, ensure })
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
        }
      }
      const updated = await options.leaseStore.update(workspaceId, lease.epoch, {
        status: "ready",
        sandboxId: target.sandboxId,
        url: target.url,
        hostId: target.hostId,
        driverResourceId: target.driverResourceId,
        retryCount: 0,
        nextRetryAt: null,
        lastError: null,
        labels: target.labels ?? ensure.labels,
        persistence: options.driver.metadata.persistence,
      })
      const resolved = await leaseTarget(updated ?? lease)
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
        const updated = await options.leaseStore.update(workspaceId, lease.epoch, { lastError: error })
        const resolved = await leaseTarget(updated ?? lease)
        if (resolved.status === "ready") return resolved
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
      // must not reach the open internet. Per the 2026-07-28 owner directive
      // ("enforce where we can and document where we cant") that request is
      // honoured where the driver can honour it, and made LOUD — not fatal —
      // where it cannot: refusing the create outright would take the most
      // likely production driver (cloudflare, preferred by
      // `defaultSandboxDriverName`) offline entirely.
      //
      // The withholding itself happens in `ensureHostInput`; this is where the
      // gap gets said out loud, at the same point the old refusal lived, so it
      // fires exactly once per create rather than once per driver retry.
      const egress = sandboxEgressDisposition(options.driver.metadata.egressControl, input.net)
      if (egress.action === "withhold" && input.net) {
        reportEgressUnenforced({ workspaceId, requested: input.net })
      }
      if (egress.action === "refuse") {
        // Still fail-closed, and deliberately so: this driver DOES enforce
        // egress, it just cannot express this policy's encoding. Degrading an
        // enforcing driver to "unrestricted" would weaken the half of the
        // directive that says enforce where we can. Not a provisioning failure
        // either — a composition mistake must not burn a lease epoch or enter
        // retry backoff.
        return { status: "unavailable", error: egress.reason, homeRegion: input.homeRegion }
      }
      const existing = await options.leaseStore.get(workspaceId)
      if (existing?.nextRetryAt && existing.nextRetryAt > now()) {
        if (existing.status === "acquiring") {
          return {
            status: "provisioning",
            retryAfterMs: existing.nextRetryAt - now(),
            epoch: existing.epoch,
            homeRegion: existing.homeRegion,
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
        }
      }
      return provision(workspaceId, acquired.lease, input.homeRegion, input)
    },
    async register(workspaceId, input) {
      return await updateFromRuntimeSnapshot(workspaceId, input)
    },
    async heartbeat(workspaceId, input) {
      return await updateFromRuntimeSnapshot(workspaceId, input)
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
      return await lifecycle(workspaceId, "checkpoint", () => captureSandboxCheckpoint({
        workspaceId,
        request: input,
        leaseStore: options.leaseStore,
        target: (id) => this.target(id),
        snapshot: (id) => this.snapshot(id),
        now,
      }))
    },
    async restore(workspaceId, input) {
      return await lifecycle(workspaceId, "restore", () => restoreSandboxCheckpoint({
        workspaceId,
        request: input,
        leaseStore: options.leaseStore,
        ensure: (id, next) => this.ensure(id, next),
        now,
      }))
    },
    async stop(workspaceId) {
      return await lifecycle(workspaceId, "stop", async () => {
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
      return await lifecycle(workspaceId, "destroy", async () => {
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
        return {
          destroyed: [],
          kept: [],
          skipped: [],
          failed: [],
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
      for (const target of await options.driver.list()) {
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
        if (
          lease?.status === "ready" &&
          String(lease.epoch) === epoch &&
          lease.hostId === target.hostId &&
          lease.sandboxId === target.sandboxId
        ) {
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

  async function updateFromRuntimeSnapshot(
    workspaceId: string,
    input: SandboxRegisterInput,
  ): Promise<SandboxMutationResult> {
    const current = await options.leaseStore.get(workspaceId)
    if (!current) return { ok: false, reason: "runtime_lease_missing" }
    const expectedEpoch = input.epoch ?? current.epoch
    if (current.epoch !== expectedEpoch) return { ok: false, reason: "runtime_lease_epoch_mismatch" }
    const timestamp = input.now ?? now()
    const status =
      input.status === "unhealthy" || input.ok === false ? "unavailable" : input.ok ? "ready" : current.status
    const updated = await options.leaseStore.update(workspaceId, expectedEpoch, {
      status,
      ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.hostId ? { hostId: input.hostId } : input.sandboxId ? { hostId: input.sandboxId } : {}),
      ...(input.driverResourceId
        ? { driverResourceId: input.driverResourceId }
        : input.sandboxId
          ? { driverResourceId: input.sandboxId }
          : {}),
      lastHeartbeatAt: timestamp,
      ...(input.active ? { lastActivityAt: timestamp } : {}),
      ...(input.ok ? { lastError: null } : {}),
    })
    if (!updated) return { ok: false, reason: "runtime_lease_epoch_mismatch" }
    return { ok: true, status: updated.status }
  }
}
