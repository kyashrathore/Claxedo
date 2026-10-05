import {
  type SandboxRegion,
  validateSandboxPersistenceCapabilities,
  sandboxEgressDisposition,
  type SandboxEgressUnenforcedEvent,
  type SandboxLease,
  type SandboxNetworkPolicy,
  sandboxNetworkPolicyWithBrokeredHosts,
  type SandboxDriverEnsureInput,
  type SandboxTarget,
  type SandboxDriver,
  type SandboxManager,
  type SandboxManagerInput,
  type SandboxRuntimeSnapshotInput,
  type SandboxBootMode,
  type SandboxEnsureResult,
  type SandboxTargetResult,
  type SandboxResource,
  type SandboxMutationResult,
  type SandboxGarbageCollectResult,
  isSandboxListingUnsupported,
  SANDBOX_IMAGE_LABEL,
  type SandboxManagerOptions
} from "./contract"
import { isSandboxRuntimeBootFailure, sandboxLeaseFailure, sandboxRuntimeBootFailedError } from "./lease-failure"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "./constants"
import {
  captureSandboxCheckpoint,
  discardSnapshot,
  restoreSandboxCheckpoint,
  type SandboxCheckpointCaptureInput,
  type SandboxCheckpointResult,
} from "./checkpoint-manager"
import { applySandboxRuntimeSnapshot } from "./runtime-snapshot"
import { createSandboxStartRecorder } from "./start-telemetry"
import { createLifecycleReporter } from "./lease-lifecycle"
import { workspaceRuntimeIdentityEnvConflicts } from "./runtime-env"

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
    `exfiltration path.${withheld} Select a driver that can enforce egress (vercel) ` +
    `to close it. See public-docs/sandbox-egress.md.`
  )
}

/**
 * Drivers already warned about at composition time, so a control plane that
 * composes its services per request (the hosted Worker does) logs the boot
 * warning once per isolate instead of once per request. Keyed by driver id +
 * declared capability, never by workspace.
 */
const compositionEgressWarnings = new Set<string>()

/**
 * Drivers whose withheld policy was already reported from a start in this
 * isolate. Every connection to a sleeping or starting cloud workspace runs
 * `admit`, so without this the hosted Worker logged the same paragraph on
 * each of them; the first start names the driver, one workspace and the
 * allowlist it withheld, which is what an operator needs to act.
 */
const ensureEgressWarnings = new Set<string>()

function defaultEgressUnenforcedSink(event: SandboxEgressUnenforcedEvent) {
  console.warn(event.message)
}

/**
 * The lifecycle operations that coalesce per workspace. Two result shapes cover
 * all four kinds, which is what lets a joining caller be typed without an
 * assertion.
 */
type LifecycleOperation =
  | { kind: "checkpoint" | "restore"; promise: Promise<SandboxCheckpointResult> }
  | { kind: "stop" | "destroy"; promise: Promise<SandboxMutationResult> }

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
    ...(input.lease.machineClass ?? input.managerInput?.machineClass
      ? { machineClass: input.lease.machineClass ?? input.managerInput?.machineClass }
      : {}),
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
  const lifecycle = createLifecycleReporter(options.onLifecycle, now)
  const starts = createSandboxStartRecorder({
    leaseStore: options.leaseStore,
    driver: options.driver.id,
    now,
    ...(options.onStartPhase ? { onStartPhase: options.onStartPhase } : {}),
  })

  function reportEgressUnenforced(input: { workspaceId: string; requested: SandboxNetworkPolicy }) {
    const key = `${options.driver.id}|${egressControl}`
    if (ensureEgressWarnings.has(key)) return
    ensureEgressWarnings.add(key)
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
  // who composed cloudflare/boat/docker/modal learns that this deployment
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

  function leaseResource(lease: SandboxLease): (SandboxResource & { epoch: number; homeRegion: SandboxRegion }) | undefined {
    if (!lease.sandboxId || !lease.hostId) return undefined
    return {
      sandboxId: lease.sandboxId,
      url: lease.url,
      workspaceId: lease.workspaceId,
      hostId: lease.hostId,
      driverResourceId: lease.driverResourceId,
      labels: lease.labels,
      driver: { id: lease.driver, resourceId: lease.driverResourceId ?? lease.sandboxId },
      epoch: lease.epoch,
      homeRegion: lease.homeRegion,
    }
  }

  async function leaseTarget(lease: SandboxLease): Promise<SandboxTargetResult> {
    const resource = leaseResource(lease)
    if (lease.status !== "ready" || !resource || !resource.url || !lease.routingId) {
      const failure = sandboxLeaseFailure(lease, { now: now(), maxRetryCount })
      return {
        status: "unavailable",
        reason: "runtime_lease_not_ready",
        leaseStatus: lease.status,
        ...(lease.nextRetryAt !== undefined ? { retryAfterMs: Math.max(0, lease.nextRetryAt - now()) } : {}),
        ...(failure ? { failure } : {}),
      }
    }
    const booted = resource.labels?.[SANDBOX_IMAGE_LABEL]
    const imageOutdated = options.driver.image !== undefined && booted !== undefined && booted !== options.driver.image
    return { ...resource, status: "ready", url: resource.url, routingId: lease.routingId, ...(imageOutdated ? { imageOutdated: true as const } : {}) }
  }

  // The boot path this lease is on, derived from the lease row alone, for the
  // provisioning answers given before provisionLease() runs, so the connect
  // UI keeps its honest label across the whole wait. Mirrors the predicates
  // provisionLease() uses when no caller bootSource is set: ensureHostInput's
  // driver-snapshot default and its `resuming`.
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
  // outcome. `enteredAt` is when the start that got here began.
  async function provisionLease(
    workspaceId: string,
    lease: SandboxLease,
    homeRegion: SandboxRegion,
    managerInput: SandboxManagerInput,
    enteredAt: number,
  ): Promise<SandboxEnsureResult> {
    let start: ReturnType<typeof starts.observe>
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
      // plaintext env. Vercel and Cloudflare both keep the value out of
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
      const bootMode: SandboxBootMode = resuming ? "resume" : ensure.bootSource?.kind === "driver-snapshot" ? "restore" : "cold-start"
      start = starts.observe(lease, { bootMode, enteredAt, labels: ensure.labels })
      ensure.onResource = async (resource) => {
        const recorded = await options.leaseStore.recordTarget(workspaceId, lease.epoch, {
          ...resource,
          labels: { ...resource.labels, ...ensure.labels },
          persistence: options.driver.metadata.persistence,
        })
        if (!recorded) throw new Error("runtime_lease_changed")
        start?.end("provider_ready")
      }
      ensure.onImageReady = async () => start?.end("image_ready")
      const target = resuming
        ? await options.driver.resumeHost!({ lease, ensure })
        : await options.driver.ensureHost(ensure)
      if ("provisioning" in target) {
        const updated = await options.leaseStore.update(workspaceId, lease.epoch, {
          status: "acquiring",
          nextRetryAt: now() + target.retryAfterMs,
        }, lease.status)
        if (!updated) return { status: "unavailable", error: "runtime_lease_changed", epoch: lease.epoch, homeRegion }
        return {
          status: "provisioning",
          retryAfterMs: target.retryAfterMs,
          epoch: lease.epoch,
          homeRegion,
          // Honest progress for the connect UI: which of the three boot paths
          // this cycle is on. Derived from the same inputs that CHOSE the path
          // above, so it cannot drift from what actually ran.
          bootMode,
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
      if (resolved.status === "ready") {
        start?.end("runtime_ready")
        return resolved
      }
      return {
        status: "unavailable",
        error: resolved.reason,
        epoch: lease.epoch,
        homeRegion,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const bootFailed = isSandboxRuntimeBootFailure(err)
      const error = bootFailed ? sandboxRuntimeBootFailedError(message) : message
      if (lease.status === "ready" && !bootFailed) {
        // A single resume blip must not demote a serving lease: the existing
        // ready target keeps resolving for relay routing while we record the
        // error for observability only. A boot that exited left nothing
        // serving, so it demotes and backs off like a cold-create failure.
        const updated = await options.leaseStore.update(workspaceId, lease.epoch, { lastError: error }, "ready")
        if (updated) {
          const resolved = await leaseTarget(updated)
          if (resolved.status === "ready") return { ...resolved, stale: true }
        }
      }
      lifecycle.failed(lease, bootFailed)
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
    } finally {
      await start?.flush()
    }
  }

  function capture(manager: Pick<SandboxManager, "target" | "snapshot">, workspaceId: string, request: SandboxCheckpointCaptureInput, endsLease = false) {
    return captureSandboxCheckpoint({
      workspaceId,
      request,
      leaseStore: options.leaseStore,
      target: (id) => manager.target(id),
      snapshot: (id, committed) => manager.snapshot(id, committed),
      ...(options.driver.deleteSnapshot ? { deleteSnapshot: options.driver.deleteSnapshot } : {}),
      endsLease,
      now,
    })
  }

  function wanted(lease: SandboxLease, afterMs = retryAfterMs): SandboxEnsureResult {
    return { status: "provisioning", retryAfterMs: afterMs, epoch: lease.epoch, homeRegion: lease.homeRegion, bootMode: leaseBootMode(lease) }
  }

  /** The lease's own answer while nothing may run the driver for it: a retry still ahead, or a spent retry budget. */
  function waiting(existing: SandboxLease | undefined): SandboxEnsureResult | undefined {
    if (!existing) return undefined
    if (existing.nextRetryAt && existing.nextRetryAt > now()) {
      if (existing.status === "acquiring") return wanted(existing, existing.nextRetryAt - now())
      return {
        status: "unavailable",
        retryAfterMs: existing.nextRetryAt - now(),
        error: existing.lastError,
        epoch: existing.epoch,
        homeRegion: existing.homeRegion,
      }
    }
    if (existing.status === "unavailable" && existing.retryCount >= maxRetryCount && existing.nextRetryAt === undefined) {
      // Capped lease without a cooldown timestamp (legacy rows): stay
      // unavailable until an operator releases the lease.
      return {
        status: "unavailable",
        error: existing.lastError ?? "runtime_retry_cap_exceeded",
        epoch: existing.epoch,
        homeRegion: existing.homeRegion,
      }
    }
    return undefined
  }

  /**
   * Whether a start continues this lease on its epoch rather than taking a
   * new one: a ready lease is re-ensured so an auto-stopped runtime resumes;
   * one that already names a sandbox is never orphaned by an epoch bump; and
   * an in-flight provision whose driver asked to be polled again is polled.
   */
  function continues(lease: SandboxLease) {
    if (lease.status === "ready") return true
    const stale = now() - lease.updatedAt >= staleAfterMs
    if (lease.status === "acquiring") {
      return lease.sandboxId ? lease.nextRetryAt !== undefined || stale : lease.nextRetryAt !== undefined && !stale
    }
    return lease.status === "unavailable" && lease.sandboxId !== undefined
  }

  /** The lease a start runs the driver for, or the answer that stands in for one. */
  async function admit(workspaceId: string, input: SandboxManagerInput): Promise<{ lease: SandboxLease } | SandboxEnsureResult> {
    // Egress disposition, decided BEFORE a lease is acquired.
    //
    // A caller that hands us a restricted policy is stating that this sandbox
    // must not reach the open internet. That is honoured where the driver can
    // honour it and made LOUD — not fatal — where it cannot: refusing the
    // create outright would take the most likely production driver
    // (cloudflare, preferred by `defaultSandboxDriverName`) offline entirely.
    //
    // The withholding itself happens in `ensureHostInput`; the warning is
    // raised here, once per driver per isolate.
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
    if (input.machineClass && !options.driver.metadata.machineClasses?.includes(input.machineClass)) {
      return { status: "unavailable", error: `sandbox_machine_class_unsupported: ${options.driver.id} has no ${input.machineClass} machines`, homeRegion: input.homeRegion }
    }
    const existing = await options.leaseStore.get(workspaceId)
    const wait = waiting(existing)
    if (wait) return wait
    if (existing && continues(existing)) return { lease: existing }
    const acquired = await options.leaseStore.acquire(workspaceId, {
      homeRegion: input.homeRegion,
      driver: options.driver.id,
      staleAfterMs,
      now: now(),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.machineClass ? { machineClass: input.machineClass } : {}),
    })
    if (!acquired.acquired) return wanted(acquired.lease, acquired.retryAfterMs)
    if (!existing) input.onLeaseOpened?.()
    return { lease: acquired.lease }
  }

  return {
    async ensure(workspaceId, input) {
      const enteredAt = now()
      const admitted = await admit(workspaceId, input)
      if (!("lease" in admitted)) return admitted
      return provisionLease(workspaceId, admitted.lease, admitted.lease.homeRegion, input, enteredAt)
    },
    async acquire(workspaceId, input) {
      const admitted = await admit(workspaceId, input)
      return "lease" in admitted ? wanted(admitted.lease) : admitted
    },
    async provision(workspaceId, epoch, input) {
      const enteredAt = now()
      const lease = await options.leaseStore.get(workspaceId)
      if (!lease || lease.epoch !== epoch) {
        return { status: "unavailable", error: "runtime_lease_changed", epoch, homeRegion: input.homeRegion }
      }
      if (lease.status === "stopped" || lease.status === "destroyed") {
        return { status: "unavailable", error: `runtime_lease_${lease.status}`, epoch, homeRegion: lease.homeRegion }
      }
      return waiting(lease) ?? provisionLease(workspaceId, lease, lease.homeRegion, input, enteredAt)
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
    async snapshot(workspaceId, committed) {
      const target = await this.target(workspaceId)
      if (target.status !== "ready") return { ok: false, reason: target.reason }
      if (!options.driver.snapshot) return { ok: false, reason: "snapshot_unsupported" }
      return { ok: true, ...(await options.driver.snapshot(target, committed)) }
    },
    async checkpoint(workspaceId, input) {
      return await checkpointLifecycle(workspaceId, "checkpoint", () => capture(this, workspaceId, input))
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
    async stop(workspaceId, input = {}) {
      return await mutationLifecycle(workspaceId, "stop", async (): Promise<SandboxMutationResult> => {
        const lease = await options.leaseStore.get(workspaceId)
        if (input.expectedEpoch !== undefined && lease?.epoch !== input.expectedEpoch) return { ok: false, reason: "runtime_lease_changed" }
        const stopped = (checkpoint: string | undefined) => ({ ok: true as const, status: "stopped" as const, ...(checkpoint ? { checkpoint } : {}) })
        if (lease?.status === "stopped") return stopped(lease.checkpoint?.providerReference)
        const target = await this.target(workspaceId)
        if (target.status !== "ready") return { ok: false, reason: target.reason }
        const stopHost = input.hostStopsItself ? undefined : options.driver.suspend ?? options.driver.stop
        const persistence = lease?.persistence
        if (input.runtime && persistence && persistence.capture !== "none") {
          // The commit stops the lease before the host stops, so a send from here on wakes a restore of this capture.
          const captured = await capture(this, workspaceId, { runtime: input.runtime, policy: "drain", idleBefore: input.idleBefore }, true)
          const checkpoint = captured.checkpoint.providerReference
          if (persistence.captureSource === "preserved") await stopHost?.({ ...target, checkpoint })
          if (lease) lifecycle.stopped(lease, input.idleBefore !== undefined)
          return stopped(checkpoint)
        }
        const checkpoint = lease?.checkpoint?.providerReference
        await stopHost?.({ ...target, ...(checkpoint ? { checkpoint } : {}) })
        const updated = await options.leaseStore.update(workspaceId, target.epoch, { status: "stopped" })
        if (!updated) return { ok: false, reason: "runtime_lease_changed" }
        if (lease) lifecycle.stopped(lease, input.idleBefore !== undefined)
        return stopped(checkpoint)
      })
    },
    async destroy(workspaceId) {
      return await mutationLifecycle(workspaceId, "destroy", async () => {
        const lease = await options.leaseStore.get(workspaceId)
        if (lease?.status === "destroyed") return { ok: true as const, status: "destroyed" as const }
        if (!lease) return { ok: false as const, reason: "runtime_lease_missing" }
        const target = leaseResource(lease)
        if (!target) return { ok: false as const, reason: "runtime_lease_resource_missing" }
        await options.driver.destroy?.(target)
        const updated = await options.leaseStore.update(workspaceId, target.epoch, { status: "destroyed" })
        if (!updated) return { ok: false as const, reason: "runtime_lease_changed" }
        lifecycle.destroyed(lease)
        if (lease.checkpoint && lease.persistence?.capture !== "same-resource") {
          await discardSnapshot(options.driver.deleteSnapshot, target, lease.checkpoint.providerReference)
        }
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
        // provider sandbox, a resume after stop) cannot retag it atomically
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
    recordStartPhases: (workspaceId, input) => starts.report(workspaceId, input),
    markStartPhase: (workspaceId, input) => starts.markAfter(workspaceId, input),
  }

  // A manager's only observer of the sandbox is the sandbox itself, so an
  // unhealthy report demotes the lease and spends no retry budget.
  function runtimeSnapshot(workspaceId: string, snapshot: SandboxRuntimeSnapshotInput) {
    return applySandboxRuntimeSnapshot({ leaseStore: options.leaseStore, workspaceId, snapshot, now })
  }
}
