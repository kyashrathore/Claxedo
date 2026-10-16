import {
  type SandboxRegion,
  validateSandboxPersistenceCapabilities,
  type SandboxLease,
  type SandboxDriverEnsureInput,
  type SandboxDriver,
  type SandboxManager,
  type SandboxManagerInput,
  type SandboxRuntimeSnapshotInput,
  type SandboxBootMode,
  type SandboxEnsureResult,
  type SandboxTargetResult,
  type SandboxResource,
  type SandboxMutationResult,
  SANDBOX_IMAGE_LABEL,
  type SandboxManagerOptions
} from "./contract"
import { sandboxEgressDisposition, sandboxNetworkPolicyWithBrokeredHosts } from "./egress-policy"
import { createEgressWarnings } from "./egress-warnings"
import { sweepSandboxes } from "./garbage-collect"
import {
  isSandboxHostGone,
  isSandboxProviderKeyRefused,
  isSandboxProviderRateLimited,
  isSandboxRuntimeBootFailure,
  isSandboxStartRefusal,
  SANDBOX_RETRY_CAP_EXCEEDED,
  sandboxHostGoneError,
  sandboxLeaseEndedUnderStart,
  sandboxLeaseFailure,
  sandboxProviderFailedError,
  sandboxProviderKeyRefusedError,
  sandboxProviderRateLimit,
  sandboxProviderRateLimitedError,
  sandboxRuntimeBootFailedError,
  sandboxStartLimitRetryMs,
} from "./lease-failure"
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
import { continuedStart, leaseBootMode } from "./lease-start"
import { workspaceRuntimeIdentityEnvConflicts } from "./runtime-env"

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

function leaseHostId(driver: SandboxDriver, workspaceId: string, lease: SandboxLease, managerInput: SandboxManagerInput | undefined) {
  return managerInput?.hostId ?? lease.hostId ?? sandboxId(driver.id, workspaceId)
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
  leaseEnv?: Record<string, string>
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
    hostId: leaseHostId(input.driver, input.workspaceId, input.lease, input.managerInput),
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
    env: { ...input.managerInput?.env, ...input.leaseEnv },
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
  const egressWarnings = createEgressWarnings({
    driver: { id: options.driver.id, egressControl: options.driver.metadata.egressControl },
    ...(options.onEgressUnenforced ? { sink: options.onEgressUnenforced } : {}),
  })
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
        ...(lease.start && (lease.status === "acquiring" || lease.status === "unavailable") ? { start: { ...lease.start, epoch: lease.epoch } } : {}),
        ...(lease.status === "acquiring" && lease.hostId ? { booting: { epoch: lease.epoch, hostId: lease.hostId } } : {}),
      }
    }
    const booted = resource.labels?.[SANDBOX_IMAGE_LABEL]
    const imageOutdated = options.driver.image !== undefined && booted !== undefined && booted !== options.driver.image
    return {
      ...resource,
      status: "ready",
      url: resource.url,
      routingId: lease.routingId,
      ...(imageOutdated ? { imageOutdated: true as const } : {}),
      ...(lease.start ? { start: { ...lease.start, epoch: lease.epoch } } : {}),
    }
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
    try {
      const leaseEnv = await managerInput.leaseEnv?.({ epoch: lease.epoch, hostId: leaseHostId(options.driver, workspaceId, lease, managerInput) })
      const identityConflicts = workspaceRuntimeIdentityEnvConflicts(leaseEnv)
      if (identityConflicts.length) {
        return { status: "unavailable", error: `sandbox env cannot set runtime identity: ${identityConflicts.join(", ")}`, epoch: lease.epoch, homeRegion }
      }
      const ensure = ensureHostInput({
        driver: options.driver,
        workspaceId,
        homeRegion,
        lease,
        managerInput,
        ...(leaseEnv ? { leaseEnv } : {}),
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
      // A host that never published a URL never served, so resuming it is the
      // workspace's first start as the person sees it, not a wake.
      const bootMode: SandboxBootMode = resuming && lease.url ? "resume" : ensure.bootSource?.kind === "driver-snapshot" ? "restore" : "cold-start"
      const start = starts.observe(lease,{ bootMode, enteredAt, labels: ensure.labels })
      await start?.opened()
      ensure.onResource = async (resource) => {
        const recorded = await options.leaseStore.recordTarget(workspaceId, lease.epoch, {
          ...resource,
          labels: { ...resource.labels, ...ensure.labels },
          persistence: options.driver.metadata.persistence,
        })
        if (!recorded) throw new Error("runtime_lease_changed")
        await start?.end("provider_ready")
      }
      ensure.onMachineReady = async () => start?.end("machine_ready")
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
        await start?.end("runtime_ready")
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
      if (isSandboxHostGone(err) && lease.sandboxId) {
        return hostGone(workspaceId, lease, managerInput, message, enteredAt)
      }
      const bootFailed = isSandboxRuntimeBootFailure(err)
      const startLimit = !bootFailed && isSandboxProviderRateLimited(err) ? err.providerRateLimited : undefined
      const error = bootFailed
        ? sandboxRuntimeBootFailedError(message)
        : startLimit ? sandboxProviderRateLimitedError(options.driver.id, startLimit)
        : isSandboxProviderKeyRefused(err) ? sandboxProviderKeyRefusedError(options.driver.id, message)
        : isSandboxStartRefusal(err) || sandboxLeaseEndedUnderStart(message) ? message
        : sandboxProviderFailedError(options.driver.id, message)
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
      const nextRetryCount = lease.retryCount + 1
      // A day's start limit is refused again at every attempt until it frees
      // up, at a time the provider does not name, so nothing retries it: the
      // next start is a person's.
      const startLimitRetryMs = startLimit ? sandboxStartLimitRetryMs(startLimit.window) : undefined
      const dayLimited = startLimit !== undefined && startLimitRetryMs === undefined
      const retryCapped = dayLimited || nextRetryCount >= maxRetryCount
      // A boot failure is never retried on its own and a capped lease waits
      // out a cooldown nobody drives: a host held through either would run
      // unattended. A provider failure is retried within its backoff on the
      // host as it is, since stopping and resuming it costs minutes.
      const hostLeftRunning = bootFailed || retryCapped ? !(await stopHeldHost(workspaceId, lease.epoch)) : false
      lifecycle.failed(lease, {
        bootFailed,
        retrying: !bootFailed && !retryCapped,
        ...(startLimit ? { startLimit: startLimit.window } : {}),
        ...(hostLeftRunning ? { hostLeftRunning: true as const } : {}),
      })
      const backoffMs = retryCapped ? retryCapCooldownMs : retryDelayMs(nextRetryCount)
      const retryInMs = dayLimited ? undefined : Math.max(backoffMs, startLimitRetryMs ?? 0)
      const failed = await options.leaseStore.recordFailure(workspaceId, lease.epoch, error, retryInMs === undefined ? undefined : now() + retryInMs)
      return {
        status: "unavailable",
        ...(dayLimited ? {} : { retryAfterMs: failed?.nextRetryAt ? Math.max(0, failed.nextRetryAt - now()) : retryAfterMs }),
        error,
        epoch: lease.epoch,
        homeRegion,
        ...(retryCapped ? { exhausted: true as const } : {}),
      }
    }
  }

  /**
   * The provider says the host the lease names no longer exists. The lease
   * ends destroyed, its boot closing at the last moment the host was proven
   * serving, and the same start goes on to place a replacement: the person
   * who began it gets a sandbox, not a report about one that is gone. A lease
   * that never had a host is not here; its driver error is a provider failure.
   */
  async function hostGone(
    workspaceId: string,
    lease: SandboxLease,
    managerInput: SandboxManagerInput,
    message: string,
    enteredAt: number,
  ): Promise<SandboxEnsureResult> {
    if (!(await endGoneHostLease(workspaceId, lease, message))) return { status: "unavailable", error: "runtime_lease_changed", epoch: lease.epoch, homeRegion: lease.homeRegion }
    const admitted = await admit(workspaceId, managerInput)
    if (!("lease" in admitted)) return admitted
    return provisionLease(workspaceId, admitted.lease, admitted.lease.homeRegion, managerInput, enteredAt)
  }

  /** Ends the lease of a host found gone, its boot closing at the last moment the host was proven serving; false when the epoch moved on first. */
  async function endGoneHostLease(workspaceId: string, lease: SandboxLease, message: string): Promise<boolean> {
    const endedAt = hostLastProvenAliveAt(lease)
    const ended = await options.leaseStore.update(workspaceId, lease.epoch, {
      status: "destroyed",
      lastError: sandboxHostGoneError(message),
      ...(endedAt === undefined ? {} : { endedAt }),
    })
    if (!ended) return false
    lifecycle.hostGone(lease, endedAt)
    return true
  }

  /** Ends the lease of a host the provider stopped on its own, its boot closing at the last moment the host was proven serving; false when the epoch moved on first. */
  async function endStoppedHostLease(workspaceId: string, lease: SandboxLease): Promise<boolean> {
    const endedAt = hostLastProvenAliveAt(lease)
    const ended = await options.leaseStore.update(workspaceId, lease.epoch, { status: "stopped", ...(endedAt === undefined ? {} : { endedAt }) })
    if (!ended) return false
    lifecycle.hostStopped(lease, endedAt)
    return true
  }

  /**
   * The latest moment the lease's own record proves its host served: the last
   * start phase observed on it, the last liveness report, the last activity.
   * Nothing for a lease that was not serving, whose host cost nothing after
   * the moment it was found gone.
   */
  function hostLastProvenAliveAt(lease: SandboxLease): number | undefined {
    if (lease.status !== "ready" || !lease.start) return undefined
    return Math.max(lease.start.markedAt, lease.lastHeartbeatAt ?? 0, lease.lastActivityAt ?? 0)
  }

  /** Stops the host, or learns from the provider that it is already gone. */
  async function hostStopped(
    stopHost: SandboxDriver["stop"] | undefined,
    resource: SandboxResource & { epoch?: number; checkpoint?: string },
  ): Promise<"stopped" | "destroyed"> {
    try {
      await stopHost?.(resource)
      return "stopped"
    } catch (err) {
      if (!isSandboxHostGone(err)) throw err
      return "destroyed"
    }
  }

  /**
   * Stops the host the epoch holds, if it holds one and the driver can; false
   * when that stop failed and the host may still run. The failure is the
   * operator's, so it is logged rather than added to the start's reason.
   */
  async function stopHeldHost(workspaceId: string, epoch: number): Promise<boolean> {
    const current = await options.leaseStore.get(workspaceId)
    const resource = current?.epoch === epoch ? leaseResource(current) : undefined
    const stopHost = options.driver.suspend ?? options.driver.stop
    if (!current || !resource || !stopHost) return true
    try {
      await stopHost({ ...resource, ...(current.checkpoint ? { checkpoint: current.checkpoint.providerReference } : {}) })
      return true
    } catch (stopError) {
      console.warn("A sandbox host was not stopped after its start failed", {
        workspaceId, epoch, sandboxId: resource.sandboxId, error: stopError instanceof Error ? stopError.message : String(stopError),
      })
      return false
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
    return { status: "provisioning", retryAfterMs: afterMs, epoch: lease.epoch, homeRegion: lease.homeRegion, bootMode: leaseBootMode(lease, options.driver) }
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
        ...(existing.retryCount >= maxRetryCount ? { exhausted: true as const } : {}),
      }
    }
    // A day's start limit leaves no retry scheduled, and the next start runs the driver.
    if (existing.status === "unavailable" && existing.retryCount >= maxRetryCount && existing.nextRetryAt === undefined
      && sandboxProviderRateLimit(existing.lastError) !== "day") {
      // Capped lease without a cooldown timestamp (legacy rows): stay
      // unavailable until an operator releases the lease.
      return {
        status: "unavailable",
        error: existing.lastError ?? SANDBOX_RETRY_CAP_EXCEEDED,
        epoch: existing.epoch,
        homeRegion: existing.homeRegion,
      }
    }
    return undefined
  }

  /**
   * Whether a start continues this lease on its epoch rather than taking a
   * new one: a ready lease is re-ensured so an auto-stopped runtime resumes,
   * and an in-flight provision is polled when its driver asked to be, or
   * already handed it a sandbox. A failed attempt's epoch is over: its boot
   * is one metered interval, and the next attempt takes an epoch of its own
   * that keeps the host (`sandboxLeaseHeldHost`), so it resumes rather than
   * re-creates.
   */
  function continues(lease: SandboxLease) {
    if (lease.status === "ready") return true
    if (lease.status !== "acquiring") return false
    const stale = now() - lease.updatedAt >= staleAfterMs
    return lease.sandboxId ? lease.nextRetryAt !== undefined || stale : lease.nextRetryAt !== undefined && !stale
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
      egressWarnings.withheld({ workspaceId, ...(input.labels ? { labels: input.labels } : {}), requested: input.net })
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
    const start = continuedStart(existing, { now: now(), maxRetryCount })
    const acquired = await options.leaseStore.acquire(workspaceId, {
      homeRegion: input.homeRegion,
      driver: options.driver.id,
      staleAfterMs,
      now: now(),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.machineClass ? { machineClass: input.machineClass } : {}),
      ...(start ? { start } : {}),
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
      const admitted = lease.status === "unavailable" ? await admit(workspaceId, input) : waiting(lease) ?? { lease }
      if (!("lease" in admitted)) return admitted
      return provisionLease(workspaceId, admitted.lease, admitted.lease.homeRegion, input, enteredAt)
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
        const stopped = { ok: true as const, status: "stopped" as const }
        if (lease?.status === "stopped") return stopped
        const target = await this.target(workspaceId)
        const stopHost = input.hostStopsItself ? undefined : options.driver.suspend ?? options.driver.stop
        // A host the provider no longer has cannot be stopped and is not held: the lease ends destroyed, and the next start places anew.
        const ended = async (resource: SandboxResource & { epoch: number; checkpoint?: string }, status: "stopped" | "destroyed") => {
          if (!lease) return undefined
          const endedAt = status === "destroyed" ? hostLastProvenAliveAt(lease) : undefined
          const updated = await options.leaseStore.update(workspaceId, resource.epoch, {
            status,
            ...(status === "destroyed" ? { lastError: sandboxHostGoneError(`${resource.sandboxId} is gone`) } : {}),
            ...(endedAt === undefined ? {} : { endedAt }),
          })
          if (!updated) return undefined
          if (status === "destroyed") lifecycle.hostGone(lease, endedAt)
          else lifecycle.stopped(lease, input.idleBefore !== undefined)
          return { ok: true as const, status }
        }
        if (target.status !== "ready") {
          // A lease still booting on a host it holds has nothing serving to drain, and the host costs all the same.
          const held = lease?.status === "acquiring" ? leaseResource(lease) : undefined
          if (!lease || !held) return { ok: false, reason: target.reason }
          return (await ended(held, await hostStopped(stopHost, held))) ?? { ok: false, reason: "runtime_lease_changed" }
        }
        const persistence = lease?.persistence
        if (input.runtime && persistence && persistence.capture !== "none") {
          // The commit stops the lease before the host stops, so a send from here on wakes a restore of this capture.
          const captured = await capture(this, workspaceId, { runtime: input.runtime, policy: "drain", idleBefore: input.idleBefore }, true)
          const checkpoint = captured.checkpoint.providerReference
          if (persistence.captureSource === "preserved") await stopHost?.({ ...target, checkpoint })
          if (lease) lifecycle.stopped(lease, input.idleBefore !== undefined)
          return stopped
        }
        const checkpoint = lease?.checkpoint?.providerReference
        const resource = { ...target, ...(checkpoint ? { checkpoint } : {}) }
        return (await ended(resource, await hostStopped(stopHost, resource))) ?? { ok: false, reason: "runtime_lease_changed" }
      })
    },
    async endIfHostDown(workspaceId, epoch) {
      const lease = await options.leaseStore.get(workspaceId)
      if (!lease || lease.epoch !== epoch || !options.driver.inspect) return undefined
      const target = await leaseTarget(lease)
      if (target.status !== "ready") return undefined
      const state = await options.driver.inspect(target)
      if (state === "serving") return undefined
      const ended = state === "gone"
        ? await endGoneHostLease(workspaceId, lease, `${target.sandboxId} is gone`)
        : await endStoppedHostLease(workspaceId, lease)
      return ended ? state : undefined
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
    garbageCollect: () => sweepSandboxes({ driver: options.driver, leaseStore: options.leaseStore, appLabel: options.appLabel ?? DEFAULT_APP_LABEL }),
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
