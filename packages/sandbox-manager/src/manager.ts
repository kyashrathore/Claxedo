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
  isSandboxRuntimeBootFailure,
  sandboxRuntimeBootFailedError,
  type SandboxManagerOptions
} from "./contract"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "./constants"
import {
  captureSandboxCheckpoint,
  restoreSandboxCheckpoint,
  type SandboxCheckpointCaptureInput,
  type SandboxCheckpointResult,
} from "./checkpoint-manager"
import { applySandboxRuntimeSnapshot } from "./runtime-snapshot"
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
 * declared capability, never by workspace: the per-create `"ensure"` warning is
 * deliberately NOT deduped.
 */
const compositionEgressWarnings = new Set<string>()

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
  | { kind: "stop" | "destroy" | "retire"; promise: Promise<SandboxMutationResult> }

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
    kind: "stop" | "destroy" | "retire",
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
      return {
        status: "unavailable",
        reason: "runtime_lease_not_ready",
        leaseStatus: lease.status,
        ...(lease.nextRetryAt !== undefined ? { retryAfterMs: Math.max(0, lease.nextRetryAt - now()) } : {}),
      }
    }
    return { ...resource, status: "ready", url: resource.url, routingId: lease.routingId }
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
      ensure.onResource = async (resource) => {
        const recorded = await options.leaseStore.recordTarget(workspaceId, lease.epoch, {
          ...resource,
          labels: { ...resource.labels, ...ensure.labels },
          persistence: options.driver.metadata.persistence,
        })
        if (!recorded) throw new Error("runtime_lease_changed")
      }
      const resuming = Boolean(lease.sandboxId && ensure.bootSource?.kind === "default" && options.driver.resumeHost)
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
      if (existing?.status === "retiring" || existing?.status === "retired") {
        return { status: "unavailable", error: "runtime_lease_retired", epoch: existing.epoch, homeRegion: existing.homeRegion }
      }
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
      if (existing?.sandboxId && (
        existing.status === "unavailable"
        || (existing.status === "acquiring" && (existing.nextRetryAt !== undefined || now() - existing.updatedAt >= staleAfterMs))
      )) {
        return provision(workspaceId, existing, existing.homeRegion, input)
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
        if (acquired.lease.status === "retiring" || acquired.lease.status === "retired") {
          return { status: "unavailable", error: "runtime_lease_retired", epoch: acquired.lease.epoch, homeRegion: acquired.lease.homeRegion }
        }
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
          return stopped(checkpoint)
        }
        const checkpoint = lease?.checkpoint?.providerReference
        await stopHost?.({ ...target, ...(checkpoint ? { checkpoint } : {}) })
        const updated = await options.leaseStore.update(workspaceId, target.epoch, { status: "stopped" })
        if (!updated) return { ok: false, reason: "runtime_lease_changed" }
        return stopped(checkpoint)
      })
    },
    async destroy(workspaceId, input) {
      return await mutationLifecycle(workspaceId, input?.retireLease ? "retire" : "destroy", async () => {
        let lease = await options.leaseStore.get(workspaceId)
        if (!lease && input?.retireLease) {
          lease = (await options.leaseStore.acquire(workspaceId, { homeRegion: input.retireLease.homeRegion, driver: options.driver.id, staleAfterMs, now: now() })).lease
        }
        if (lease?.status === "retired") return { ok: true as const, status: "destroyed" as const }
        if (lease?.status === "destroyed") {
          if (input?.retireLease && !await options.leaseStore.update(workspaceId, lease.epoch, { status: "retired" }, "destroyed")) {
            return { ok: false as const, reason: "runtime_lease_changed" }
          }
          return { ok: true as const, status: "destroyed" as const }
        }
        if (!lease) return { ok: true as const, status: "destroyed" as const }
        const retiring = !!input?.retireLease || lease.status === "retiring"
        const fence = retiring ? "retiring" : "stopped"
        // Fence provisioning before provider deletion. A late resource handoff
        // is refused by recordTarget and its driver must clean up that resource.
        // Keep a failed deletion retryable rather than recording it as finished.
        const fenced = await options.leaseStore.update(workspaceId, lease.epoch, { status: fence }, lease.status)
        if (!fenced) return { ok: false as const, reason: "runtime_lease_changed" }
        const target = leaseResource(fenced)
        if ((fenced.sandboxId || fenced.checkpoint) && !target) return { ok: false as const, reason: "runtime_lease_resource_missing" }
        if (target) {
          if (!options.driver.destroy) return { ok: false as const, reason: "sandbox_destroy_unsupported" }
          if (fenced.checkpoint && fenced.persistence?.capture !== "same-resource") {
            if (!options.driver.deleteSnapshot) return { ok: false as const, reason: "snapshot_delete_unsupported" }
            await options.driver.deleteSnapshot(target, fenced.checkpoint.providerReference)
            if (!await options.leaseStore.update(workspaceId, fenced.epoch, { status: fence, checkpoint: null }, fence)) {
              return { ok: false as const, reason: "runtime_lease_changed" }
            }
          }
          await options.driver.destroy(target)
        }
        const updated = await options.leaseStore.update(workspaceId, fenced.epoch, { status: retiring ? "retired" : "destroyed" }, fence)
        if (!updated) return { ok: false as const, reason: "runtime_lease_changed" }
        return { ok: true as const, status: "destroyed" as const }
      })
    },
    async release(workspaceId) {
      const lease = await options.leaseStore.get(workspaceId)
      if (!lease) return { released: false }
      if (lease.status === "retiring" || lease.status === "retired") return { released: false }
      await options.leaseStore.release(workspaceId)
      return { released: await options.leaseStore.get(workspaceId) === undefined }
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
  }

  // A manager's only observer of the sandbox is the sandbox itself, so an
  // unhealthy report demotes the lease and spends no retry budget.
  function runtimeSnapshot(workspaceId: string, snapshot: SandboxRuntimeSnapshotInput) {
    return applySandboxRuntimeSnapshot({ leaseStore: options.leaseStore, workspaceId, snapshot, now })
  }
}
