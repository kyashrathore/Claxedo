import { createHash, randomUUID } from "node:crypto"
import {
  DEFAULT_RECOVERY_BUDGETS,
  capChildBudget,
  finalizeRecoveryOperation,
  recoveryIntentEquals,
  recoveryTargetsMatch,
  releasedDrainOperationId,
  type RecoveryBudgets,
  type RecoveryError,
  type RecoveryFacts,
  type RecoveryMachineTarget,
  type RecoveryOperation,
  type RecoveryOutcome,
  type RecoveryPhase,
  type RecoveryRequest,
  type RecoveryScopePreview,
  type RecoveryTarget,
} from "@claxedo/agent-runtime-contract"
import { reconcileLaunch, verifyCreationIdentity, type CreationIdentity } from "@claxedo/agent-sdk-runtime/launch"
import { Pty } from "@claxedo/workspace-runtime"
import {
  embeddedWorkspaceRuntimeActivity,
  embeddedWorkspaceRuntimeOwnership,
  type EmbeddedWorkspaceRuntimeOwnership,
} from "../deployments/local/embedded-workspace-runtime"
import type { DaemonOperationStore } from "./daemon-operation-store"

export type LocalDaemonWorkActivity = ReturnType<typeof localDaemonWorkActivity>

/**
 * One thing this daemon still owns, by name. A drain reports these rather than
 * a count, because an operator deciding whether to stop a machine has to know
 * which workspace or terminal is holding it, and a number names nothing.
 */
export type LocalDaemonOwner = {
  id: string
  kind: "workspace_runtime" | "terminal" | "managed_process" | "turn"
  /**
   * What makes this owner answerable across a restart: a gate acknowledged for
   * one generation does not carry to a replacement wearing the same id.
   */
  generation: string
  state: string
  /** Whether this owner keeps the daemon resident. */
  pins: boolean
  detail?: string
}

export function localDaemonResidencyPins(
  pty: ReturnType<typeof Pty.activity>,
  runtime: ReturnType<typeof embeddedWorkspaceRuntimeActivity>,
) {
  // Every terminal and managed process is backed by a running PTY. Agent work
  // remains pinned for active turns, writes, and checkpoint transitions.
  return pty.running + runtime.activeTurns + runtime.activeWrites + runtime.checkpointing
}

export function localDaemonOwners(
  terminals: ReturnType<typeof Pty.listDetailed>,
  runtime: ReturnType<typeof embeddedWorkspaceRuntimeActivity>,
): LocalDaemonOwner[] {
  const owners: LocalDaemonOwner[] = []
  for (const owner of runtime.owners) {
    owners.push({
      id: `workspace:${owner.workspaceId}`,
      kind: "workspace_runtime",
      generation: owner.generation,
      state: owner.state,
      // A serving runtime releases with the process it runs in; one whose
      // retirement never settled holds resources nothing accounted for.
      pins: owner.state !== "serving",
      ...(owner.error ? { detail: owner.error } : {}),
    })
    for (const turn of owner.turns) {
      owners.push({
        id: `turn:${owner.workspaceId}:${turn.sessionId}:${turn.turnId}`,
        kind: "turn",
        generation: turn.ownerGeneration,
        state: "running",
        pins: true,
      })
    }
  }
  for (const terminal of terminals) {
    const unresolved = terminal.cleanup === "unresolved"
    if (!unresolved && (terminal.removed || terminal.exited || terminal.status !== "running")) continue
    owners.push({
      id: `terminal:${terminal.id}`,
      kind: terminal.managed ? "managed_process" : "terminal",
      generation: String(terminal.pid),
      state: unresolved ? "cleanup_unresolved" : terminal.status,
      pins: true,
      ...(unresolved && terminal.cleanupResult
        ? { detail: `leader ${terminal.cleanupResult.leader}, descendants ${terminal.cleanupResult.descendants}` }
        : {}),
    })
  }
  return owners.sort((a, b) => a.id.localeCompare(b.id))
}

export function localDaemonWorkActivity() {
  const pty = Pty.activity()
  const runtime = embeddedWorkspaceRuntimeActivity()
  const residencyPins = localDaemonResidencyPins(pty, runtime)
  return {
    pty,
    runtime,
    owners: localDaemonOwners(Pty.listDetailed(), runtime),
    residencyPins,
    // Today every live local process or in-flight mutation is tied to this
    // process generation. A future replacement protocol may reduce this set,
    // but it must do so by transferring ownership rather than guessing.
    replacementBlockers: residencyPins,
  }
}

/**
 * The revision a caller authorizes against. It covers every named owner and the
 * agent work the workspace runtimes report, so a terminal opened or a turn
 * admitted between a preview and the action it authorized changes it.
 */
export function localDaemonScopeRevision(work: LocalDaemonWorkActivity): string {
  const shape = [
    work.owners.map((owner) => [owner.id, owner.generation, owner.state]),
    work.runtime.activeWrites,
    work.runtime.checkpointing,
  ]
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16)
}

/**
 * What an escalation would interrupt, every owner by name.
 *
 * A workspace whose launch records could not be read is listed as unknown
 * impact rather than left out. Omitting it would make the list read as complete
 * when the one thing established about that workspace is that nothing here
 * knows what it still owns.
 */
export function localDaemonScopePreview(
  work: LocalDaemonWorkActivity,
  unreadable: ReadonlyMap<string, string> = new Map(),
): RecoveryScopePreview {
  const resources = work.owners.map((owner) => `${owner.id} (${owner.state})`)
  if (work.runtime.activeWrites > 0) resources.push(`workspace writes: ${work.runtime.activeWrites}`)
  if (work.runtime.checkpointing > 0) resources.push(`checkpoint transitions: ${work.runtime.checkpointing}`)
  for (const [workspaceId, reason] of [...unreadable].sort(([a], [b]) => a.localeCompare(b))) {
    resources.push(`workspace:${workspaceId} launches (unreadable: ${reason})`)
  }
  // Sessions are the scope a caller recognizes; the turn owners above carry the
  // turn ids that name which of each session's work would be interrupted.
  const sessions = [...new Set(work.owners.flatMap((owner) =>
    owner.kind === "turn" ? [owner.id.split(":")[2]!] : []))].sort()
  // Writes and checkpoint transitions own nothing and appear in no owner list,
  // but either one blocks a drain, so a summary counting only owners would
  // describe a machine as emptier than it is.
  const blocking = [
    ...(work.runtime.activeWrites > 0 ? [`${work.runtime.activeWrites} workspace write(s)`] : []),
    ...(work.runtime.checkpointing > 0 ? [`${work.runtime.checkpointing} checkpoint transition(s)`] : []),
  ]
  const summary = [
    `${work.owners.length} named owners`,
    ...(blocking.length > 0 ? [`${blocking.join(" and ")} that own nothing but block a drain`] : []),
    ...(unreadable.size > 0
      ? [`additional impact in ${unreadable.size} workspace(s) is unknown because their launch records could not be read`]
      : []),
  ]
  return { sessions, resources, summary: summary.join("; ") }
}

export type LocalDaemonLease = Readonly<{
  id: string
  client: string
  expiresAt: number
}>

export type LocalDaemonLifecycle = ReturnType<typeof createLocalDaemonLifecycle>

/** Who a machine operation is recorded against. Only machine authority may mutate. */
export type MachineRecoveryCaller = { callerId: string; authority: "session" | "workspace" | "machine" }

export type MachineRecoveryGate = { operationId: string; scopeRevision: string; owners: string[] }

/**
 * Why this machine is closed to new work. A replacement daemon holds the second
 * kind from the instant it listens: admitting a turn over a launch the previous
 * owner never settled is the second writer §4.6 forbids, and nothing here can
 * tell the two apart until the records have been read.
 */
export type MachineIngressHold =
  | ({ kind: "operation" } & MachineRecoveryGate)
  | { kind: "launch_reconciliation"; overdueAfterMs?: number; pending?: string[] }

/** What a survivor of the previous owner turned out to be. */
export type ReconciledLaunch = {
  workspaceId: string
  launchId: string
  /** The owner generation that prepared it; a previous one is what makes it a survivor. */
  ownerGeneration: string
  role: string
  execution: "none" | "unknown" | "started"
  because: string
  identity?: "live" | "exited" | "identity_mismatch" | "unknown"
}

export type MachineRecoveryInspection = {
  machineId: string
  generation: string
  target: RecoveryMachineTarget
  scopeRevision: string
  owners: LocalDaemonOwner[]
  preview: RecoveryScopePreview
  residencyPins: number
  /** Present while machine ingress is closed for an operation. */
  gate?: MachineRecoveryGate
  operations: RecoveryOperation[]
  receipt: "durable" | "volatile"
}

type MachineOperationRun = {
  operation: RecoveryOperation
  callers: Set<string>
  settled: Promise<void>
  /** Set when a release withdrew this drain's authorization; its wait stops. */
  released?: true
}

export function createLocalDaemonLifecycle(options: {
  activity?: () => LocalDaemonWorkActivity
  /**
   * Releases everything this process owns. Reached by idle grace and by
   * `stop_daemon`; it must resolve only once the owners are actually released,
   * because the receipt is written from what it reached.
   */
  onStop: () => void | Promise<unknown>
  /**
   * Ends the process. Called after `onStop` has settled AND any receipt that
   * asked for it has been committed, so a stop's own receipt is never lost to
   * the exit it requested.
   */
  onStopped?: () => void
  machine: {
    machineId: string
    generation: string
    /**
     * Opened on first use rather than at composition: the lifecycle is created
     * before the database is. Absent, or throwing, makes every receipt volatile.
     */
    operations?: () => DaemonOperationStore
    budgets?: Partial<RecoveryBudgets>
    /** Reads what each workspace store has no settled retirement for. */
    ownership?: () => Promise<EmbeddedWorkspaceRuntimeOwnership[]>
    /** Where each survivor is reported; a store that could not be read too. */
    onLaunchReconciled?: (reconciled: ReconciledLaunch) => void
    /** `workspaceId` is absent when the ownership read itself failed. */
    onLaunchesUnreadable?: (workspaceId: string | undefined, reason: string) => void
  }
  leaseTtlMs?: number
  idleGraceMs?: number
  pollIntervalMs?: number
  now?: () => number
}) {
  const activity = options.activity ?? localDaemonWorkActivity
  const leaseTtlMs = positive(options.leaseTtlMs, 15_000)
  const idleGraceMs = positive(options.idleGraceMs, 180_000)
  const pollIntervalMs = positive(options.pollIntervalMs, 1_000)
  const now = options.now ?? Date.now
  const budgets: RecoveryBudgets = { ...DEFAULT_RECOVERY_BUDGETS, ...options.machine.budgets }
  const machineTarget: RecoveryMachineTarget = {
    scope: "machine",
    machineId: options.machine.machineId,
    ownerGeneration: options.machine.generation,
  }
  const leases = new Map<string, LocalDaemonLease>()
  const runs = new Map<string, MachineOperationRun>()
  let operationStore: DaemonOperationStore | undefined
  /**
   * Why this machine has no durable receipts. Recovery stays available without
   * them — a daemon whose database will not open is exactly when an operator
   * needs to inspect and contain it — and every receipt it issues says volatile.
   */
  let storeUnavailable: Error | undefined
  let gate: MachineRecoveryGate | undefined
  let reconcilingLaunches: Promise<ReconciledLaunch[]> | undefined
  let launchesReconciled = false
  let launchesOverdueAfterMs: number | undefined
  /** Launch ids read but not yet answered for, so an overdue refusal names them. */
  let launchesPending: string[] = []
  let ended = false
  /** Workspaces whose launch records could not be read, by the reason each gave. */
  const unreadableLaunches = new Map<string, string>()

  function operations() {
    if (!options.machine.operations || storeUnavailable) return undefined
    try {
      operationStore ??= options.machine.operations()
    } catch (error) {
      storeUnavailable = error instanceof Error ? error : new Error(String(error))
      return undefined
    }
    return operationStore
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let idleSince: number | undefined
  let state: "created" | "running" | "idle" | "stopping" | "stopped" = "created"

  /** Ends the process once, whichever path released the owners. */
  function stopped() {
    if (ended) return
    ended = true
    options.onStopped?.()
  }

  function clearTimer() {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  function prune(at: number) {
    for (const [id, lease] of leases) {
      if (lease.expiresAt <= at) leases.delete(id)
    }
  }

  function schedule(delayMs = pollIntervalMs) {
    if (state !== "running" && state !== "idle") return
    clearTimer()
    timer = setTimeout(tick, Math.max(1, Math.min(pollIntervalMs, delayMs)))
    timer.unref?.()
  }

  function evaluate() {
    const at = now()
    prune(at)
    const work = activity()
    const residencyPins = work.residencyPins + leases.size
    // The listener can become reachable just before the entrypoint calls
    // start(). A diagnostic snapshot during that window must not begin idle
    // grace or consume the one valid created -> running transition.
    if (state === "created") {
      return { at, work, residencyPins, idleRemainingMs: undefined }
    }
    if (residencyPins > 0) {
      idleSince = undefined
      if (state !== "stopping" && state !== "stopped") state = "running"
      return { at, work, residencyPins, idleRemainingMs: undefined }
    }
    idleSince ??= at
    if (state !== "stopping" && state !== "stopped") state = "idle"
    // The handoff window exists for a launcher that is coming back. A drain
    // holding the gate is the launcher saying it is not.
    const graceMs = gate ? 0 : idleGraceMs
    return { at, work, residencyPins, idleRemainingMs: Math.max(0, graceMs - (at - idleSince)) }
  }

  function tick() {
    timer = undefined
    if (state === "stopping" || state === "stopped" || state === "created") return
    const current = evaluate()
    if (current.residencyPins === 0 && current.idleRemainingMs === 0) {
      state = "stopping"
      void Promise.resolve(options.onStop()).finally(() => {
        state = "stopped"
        stopped()
      })
      return
    }
    const nextExpiry = [...leases.values()].reduce<number | undefined>(
      (soonest, lease) => soonest === undefined ? lease.expiresAt : Math.min(soonest, lease.expiresAt),
      undefined,
    )
    const untilExpiry = nextExpiry === undefined ? pollIntervalMs : Math.max(1, nextExpiry - current.at)
    schedule(Math.min(untilExpiry, current.idleRemainingMs ?? pollIntervalMs))
  }

  function changed() {
    if (state !== "running" && state !== "idle") return
    // A lease mutation can arrive before the currently scheduled poll fires.
    // Cancel that poll before evaluating immediately, otherwise `tick()` loses
    // the only handle to it and every renewal leaves another timer behind.
    clearTimer()
    tick()
  }

  function facts(work: LocalDaemonWorkActivity, at: number): RecoveryFacts {
    const drained = work.residencyPins === 0
    const generation = options.machine.generation
    const unresolved = work.owners.some((owner) => owner.state === "cleanup_unresolved")
    return {
      execution: { value: drained ? "terminal" : "running", source: "local-daemon", observedAt: at, generation },
      // A terminal whose retirement never settled is the one thing this daemon
      // knows it did not clear; everything else it owns ends with the process.
      cleanup: {
        value: drained ? (unresolved ? "unknown" : "verified_clear") : "owned",
        source: "local-daemon",
        observedAt: at,
        generation,
      },
      persistence: {
        value: options.machine.operations && !storeUnavailable ? "committed" : "unavailable",
        source: "local-daemon",
        observedAt: at,
        generation,
      },
    }
  }

  function persist(operation: RecoveryOperation, request: RecoveryRequest, caller: MachineRecoveryCaller) {
    const store = operations()
    if (!store) {
      return storeUnavailable
        ? { receipt: "volatile" as const, failure: storeFailure(storeUnavailable, request.target, "ack", now()) }
        : { receipt: "volatile" as const }
    }
    try {
      const recorded = store.record(operation, caller, request)
      if (recorded.created) return { receipt: "durable" as const }
      return { receipt: "durable" as const, existing: recorded.existing }
    } catch (error) {
      return { receipt: "volatile" as const, failure: storeFailure(error, request.target, "ack", now()) }
    }
  }

  function commit(operation: RecoveryOperation) {
    const store = operations()
    if (!store || operation.receipt === "volatile") return operation
    try {
      store.update(operation)
      return operation
    } catch (error) {
      return {
        ...operation,
        receipt: "volatile" as const,
        cleanupErrors: [...operation.cleanupErrors, storeFailure(error, operation.target, operation.phase, now())],
      }
    }
  }

  /**
   * Writes every named owner's gate before any of them is acted on. A crash
   * between two of these writes leaves the earlier ones readable, which is what
   * lets a restart reconstruct the gated subset instead of assuming it is empty.
   */
  function recordGates(operationId: string, owners: LocalDaemonOwner[], at: number) {
    const store = operations()
    if (!store) return owners.map((owner) => owner.id)
    const acknowledged: string[] = []
    for (const owner of owners) {
      const row = store.acknowledgeGate({
        operationId,
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        acknowledgedAt: at,
      })
      if (row.accepted) acknowledged.push(owner.id)
    }
    return acknowledged
  }

  /**
   * Reads every launch the previous owner left unsettled and reports what each
   * one is now. It verifies rather than signals: retiring a survivor belongs to
   * the workspace store that owns it, and what this owner needs is only whether
   * admission may reopen.
   */
  async function reconcileLaunches(): Promise<ReconciledLaunch[]> {
    const read = options.machine.ownership ?? embeddedWorkspaceRuntimeOwnership
    const reconciled: ReconciledLaunch[] = []
    // One deadline for the whole reconciliation, not one per step: a per-step
    // budget multiplied by the number of launches is a deadline the caller was
    // never promised.
    const deadlineAt = now() + budgets.reconcileMs
    try {
      let owned: EmbeddedWorkspaceRuntimeOwnership[]
      try {
        // Bounded, because admission stays closed until this answers and an
        // unbounded await would leave the machine refusing work with no way out
        // but a restart. The read is detached rather than abandoned: when it
        // settles late its records are still reconciled, and until then the
        // refusal says the reconciliation is overdue instead of going quiet.
        owned = await settleWithin(read(), deadlineAt - now(), () => {
          launchesOverdueAfterMs = budgets.reconcileMs
          options.machine.onLaunchesUnreadable?.(
            undefined,
            `the launch reconciliation did not answer within ${String(budgets.reconcileMs)}ms; machine admission stays closed`,
          )
        })
      } catch (error) {
        // Reported, not rethrown: nothing awaits this at the entrypoint, and a
        // rejection nobody holds would take the daemon down over a read that
        // only decides whether admission may reopen.
        options.machine.onLaunchesUnreadable?.(undefined, error instanceof Error ? error.message : String(error))
        return reconciled
      }
      for (const owner of owned) {
        if (owner.launchesUnreadable !== undefined) {
          // Retained, not just reported: a preview that left this workspace out
          // would read as a complete list of what a stop would interrupt.
          unreadableLaunches.set(owner.workspaceId, owner.launchesUnreadable)
          options.machine.onLaunchesUnreadable?.(owner.workspaceId, owner.launchesUnreadable)
          continue
        }
        unreadableLaunches.delete(owner.workspaceId)
        const records = owner.launches ?? []
        launchesPending = [...launchesPending, ...records.map((record) => record.launchId)]
        // Bounded concurrency: each verdict costs a subprocess, and a workspace
        // with hundreds of unsettled launches would otherwise fork all of them
        // at once on a machine that is already in trouble.
        for (let index = 0; index < records.length; index += IDENTITY_PROBE_CONCURRENCY) {
          const batch = records.slice(index, index + IDENTITY_PROBE_CONCURRENCY)
          const rows = await Promise.all(batch.map(async (record): Promise<ReconciledLaunch> => {
            const execution = reconcileLaunch(record)
            return {
              workspaceId: owner.workspaceId,
              launchId: record.launchId,
              ownerGeneration: record.ownerGeneration,
              role: record.role,
              execution: execution.execution,
              because: execution.because,
              ...(record.identity ? { identity: await identityVerdict(record.identity, deadlineAt) } : {}),
            }
          }))
          for (const row of rows) {
            reconciled.push(row)
            launchesPending = launchesPending.filter((id) => id !== row.launchId)
            options.machine.onLaunchReconciled?.(row)
          }
        }
      }
    } finally {
      launchesReconciled = true
      launchesOverdueAfterMs = undefined
      launchesPending = []
      changed()
    }
    return reconciled
  }

  function inspect(): MachineRecoveryInspection {
    const work = activity()
    return {
      machineId: options.machine.machineId,
      generation: options.machine.generation,
      target: machineTarget,
      scopeRevision: localDaemonScopeRevision(work),
      owners: work.owners,
      preview: localDaemonScopePreview(work, unreadableLaunches),
      residencyPins: work.residencyPins + leases.size,
      ...(gate ? { gate } : {}),
      operations: [...runs.values()].map((run) => run.operation),
      receipt: options.machine.operations && !storeUnavailable ? "durable" : "volatile",
    }
  }

  async function runDrain(operationId: string, deadlineAt: number) {
    const run = runs.get(operationId)
    if (!run) return
    for (;;) {
      if (run.released) return
      const work = activity()
      const at = now()
      if (work.residencyPins + leases.size === 0) {
        run.operation = commit(finalizeRecoveryOperation({ ...run.operation, updatedAt: at }, facts(work, at)))
        return
      }
      if (at >= deadlineAt) {
        const blocked: RecoveryError = {
          code: "deadline_exceeded",
          origin: "local-daemon",
          target: run.operation.target,
          stage: "drain",
          executionMayContinue: true,
          message: `the drain deadline passed with ${localDaemonScopePreview(work, unreadableLaunches).resources.join("; ")} still owned`,
          at,
        }
        // Not `failed`: the drain did what it promised — it gated the machine
        // and waited to its deadline. What is owed is a decision, so the
        // blockers are named and the two actions that can follow are offered.
        run.operation = commit({
          ...run.operation,
          state: "needs_action",
          updatedAt: at,
          facts: facts(work, at),
          initiatingError: blocked,
          nextActions: [
            { action: "drain_daemon", scopePreviewRequired: true, reason: "wait for the named owners again" },
            { action: "stop_daemon", scopePreviewRequired: true, reason: "stop this daemon and the owners it still holds" },
          ],
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadlineAt - at))))
    }
  }

  /**
   * Stops this process and records what stopping it reached. `onStop` resolves
   * only once the server has actually released its owners, so the facts below
   * are read after the work is gone rather than on the acknowledgement — a
   * receipt written while everything was still running says `needs_action`, and
   * that receipt then fences the next generation from boot.
   */
  async function runStop(operationId: string) {
    const run = runs.get(operationId)
    if (!run) return
    state = "stopping"
    try {
      await options.onStop()
    } finally {
      state = "stopped"
    }
    const at = now()
    const work = activity()
    run.operation = commit(finalizeRecoveryOperation({ ...run.operation, updatedAt: at }, facts(work, at)))
    // Only now: a process that exited before this line would leave a receipt
    // saying the machine still had work, and that receipt fences the next
    // generation from boot.
    stopped()
  }

  /**
   * Reopens one drain's gates. It never reopens "the fence": two operations can
   * hold gates over the same owners, so releasing whatever happens to be closed
   * would un-gate a scope this caller never authorized reopening.
   */
  function release(
    request: RecoveryRequest,
    caller: MachineRecoveryCaller,
    at: number,
    work: LocalDaemonWorkActivity,
    scopeRevision: string,
  ): RecoveryOutcome {
    const drainId = releasedDrainOperationId(request)
    if (!drainId) {
      return {
        kind: "refused",
        refusal: { kind: "unavailable", message: "a release must name the drain it reopens in linkedOperationId" },
      }
    }
    const drainRun = runs.get(drainId)
    if (!drainRun) {
      return {
        kind: "refused",
        refusal: { kind: "unavailable", message: `no operation ${drainId} is held on this machine` },
      }
    }
    if (drainRun.operation.action !== "drain_daemon") {
      return {
        kind: "refused",
        refusal: {
          kind: "unavailable",
          message: `operation ${drainId} is a ${drainRun.operation.action}, and only a drain's gates may be reopened`,
        },
      }
    }
    // Its gates are already gone. Releasing again would rewrite the receipt of
    // a drain that is over, against a fence some later operation may hold.
    if (drainRun.released) {
      return {
        kind: "refused",
        refusal: { kind: "unavailable", message: `drain ${drainId} was already released; its gates are reopened` },
      }
    }
    // A stop already under way has begun removing the owners this gate covers.
    // Reopening now would admit work into a scope that is being torn down.
    const destructive = [...runs.values()].find((candidate) =>
      candidate.operation.action === "stop_daemon"
      && candidate.operation.state !== "succeeded" && candidate.operation.state !== "failed")
    if (destructive) {
      return {
        kind: "refused",
        refusal: {
          kind: "scope_changed",
          message: `operation ${destructive.operation.operationId} is stopping this machine; its owners cannot be readmitted`,
          scopeRevision,
          preview: localDaemonScopePreview(work, unreadableLaunches),
        },
      }
    }
    if (gate && gate.operationId !== drainId) {
      return {
        kind: "refused",
        refusal: {
          kind: "scope_changed",
          message: `this machine is fenced by operation ${gate.operationId}, not by ${drainId}`,
          scopeRevision,
          preview: localDaemonScopePreview(work, unreadableLaunches),
        },
      }
    }

    let operation: RecoveryOperation = {
      operationId: randomUUID(),
      requestId: request.requestId,
      target: request.target,
      action: "release_drain",
      scopeRevision,
      attempt: request.attempt,
      state: "succeeded",
      phase: "ack",
      phaseDeadlineAt: at + budgets.ackMs,
      facts: facts(work, at),
      cleanupErrors: [],
      nextActions: [],
      receipt: "durable",
      ...(request.linkedOperationId !== undefined ? { linkedOperationId: request.linkedOperationId } : {}),
      createdAt: at,
      updatedAt: at,
    }
    // The intent is recorded before the gates move, so a redelivery of the same
    // request reads back the release that already happened rather than
    // reopening a fence a second operation may have taken since.
    const recorded = persist(operation, request, caller)
    if (recorded.existing) {
      if (!recoveryIntentEquals(request, requestOf(recorded.existing))) {
        return {
          kind: "refused",
          refusal: {
            kind: "intent_conflict",
            message: "this request id was already used for a different machine operation",
            requestId: request.requestId,
          },
        }
      }
      return { kind: "operation", operation: runs.get(recorded.existing.operationId)?.operation ?? recorded.existing }
    }
    if (recorded.receipt === "volatile") {
      operation = {
        ...operation,
        receipt: "volatile",
        ...(recorded.failure ? { cleanupErrors: [recorded.failure] } : {}),
      }
    }

    const reopened = operations()?.releaseGates(drainId) ?? gate?.owners ?? []
    gate = undefined
    drainRun.released = true
    // The drain is over and did not drain: its caller withdrew the
    // authorization that held the gate, and a withdrawn attempt is history
    // rather than a success. The release carries its own receipt.
    drainRun.operation = commit({
      ...drainRun.operation,
      state: "failed",
      updatedAt: at,
      initiatingError: {
        code: "authority_lost",
        origin: "local-daemon",
        target: drainRun.operation.target,
        stage: "drain",
        executionMayContinue: true,
        message: `the authorization holding this drain was released, reopening ${String(reopened.length)} gates`,
        at,
      },
      nextActions: [{ action: "drain_daemon", scopePreviewRequired: true, reason: "drain this machine again" }],
    })
    runs.set(operation.operationId, { operation, callers: new Set([caller.callerId]), settled: Promise.resolve() })
    changed()
    return { kind: "operation", operation }
  }

  function submit(request: RecoveryRequest, caller: MachineRecoveryCaller): RecoveryOutcome {
    if (caller.authority !== "machine") {
      return {
        kind: "refused",
        refusal: { kind: "unauthorized", message: "a machine recovery operation requires this machine's daemon authority" },
      }
    }
    if (request.action !== "drain_daemon" && request.action !== "stop_daemon" && request.action !== "release_drain") {
      return { kind: "refused", refusal: { kind: "unauthorized", message: `the daemon owner does not serve ${request.action}` } }
    }
    if (!recoveryTargetsMatch(request.target, machineTarget)) {
      return {
        kind: "refused",
        refusal: {
          kind: "generation_conflict",
          message: "the request names a different machine or daemon generation",
          current: machineTarget,
        },
      }
    }

    const at = now()
    const work = activity()
    const scopeRevision = localDaemonScopeRevision(work)
    if (request.action === "release_drain") return release(request, caller, at, work, scopeRevision)
    // A stop removes owners, so it runs only against the exact scope its caller
    // was shown. A drain gates and waits, so it accepts the current scope and
    // reports what it could not drain through its own result.
    if (request.action === "stop_daemon" && request.scopeRevision !== scopeRevision) {
      return {
        kind: "refused",
        refusal: {
          kind: "scope_changed",
          message: "the machine's owners changed since the preview this stop was authorized against",
          scopeRevision,
          preview: localDaemonScopePreview(work, unreadableLaunches),
        },
      }
    }

    const existingRun = gate && gate.operationId !== request.linkedOperationId ? runs.get(gate.operationId) : undefined
    // A repeated request id from the same caller is the same command or a
    // conflict; it is never coalesced, because coalescing would serve one
    // caller an operation it did not ask for under an id it reused.
    if (existingRun && existingRun.operation.requestId === request.requestId && existingRun.callers.has(caller.callerId)) {
      if (recoveryIntentEquals(request, requestOf(existingRun.operation))) {
        return { kind: "operation", operation: existingRun.operation }
      }
      return {
        kind: "refused",
        refusal: {
          kind: "intent_conflict",
          message: "this request id was already used for a different machine operation",
          requestId: request.requestId,
        },
      }
    }
    if (existingRun) {
      if (request.action === "drain_daemon" && existingRun.operation.action === "drain_daemon") {
        existingRun.callers.add(caller.callerId)
        return { kind: "operation", operation: existingRun.operation }
      }
      if (request.action === "drain_daemon") {
        return {
          kind: "refused",
          refusal: {
            kind: "scope_changed",
            message: `machine ingress is already closed for operation ${existingRun.operation.operationId}`,
            scopeRevision,
            preview: localDaemonScopePreview(work, unreadableLaunches),
          },
        }
      }
    }

    const phase: RecoveryPhase = request.action === "drain_daemon" ? "drain" : "term_grace"
    let operation: RecoveryOperation = {
      operationId: randomUUID(),
      requestId: request.requestId,
      target: request.target,
      action: request.action,
      scopeRevision,
      attempt: request.attempt,
      state: "running",
      phase,
      phaseDeadlineAt: at + budgets.drainMs,
      facts: facts(work, at),
      cleanupErrors: [],
      nextActions: [],
      receipt: "durable",
      ...(request.linkedOperationId !== undefined ? { linkedOperationId: request.linkedOperationId } : {}),
      createdAt: at,
      updatedAt: at,
    }

    const recorded = persist(operation, request, caller)
    if (recorded.existing) {
      if (!recoveryIntentEquals(request, requestOf(recorded.existing))) {
        return {
          kind: "refused",
          refusal: {
            kind: "intent_conflict",
            message: "this request id was already used for a different machine operation",
            requestId: request.requestId,
          },
        }
      }
      const joined = runs.get(recorded.existing.operationId)
      joined?.callers.add(caller.callerId)
      return { kind: "operation", operation: joined?.operation ?? recorded.existing }
    }
    if (recorded.receipt === "volatile") {
      operation = {
        ...operation,
        receipt: "volatile",
        ...(recorded.failure ? { cleanupErrors: [recorded.failure] } : {}),
      }
    }

    // Ingress closes with acceptance, before any owner is gated or stopped, so
    // nothing enters a scope that was just authorized for removal.
    const acknowledged = recordGates(operation.operationId, work.owners, at)
    gate = { operationId: operation.operationId, scopeRevision, owners: acknowledged }

    const run: MachineOperationRun = { operation, callers: new Set([caller.callerId]), settled: Promise.resolve() }
    runs.set(operation.operationId, run)
    run.settled = request.action === "drain_daemon"
      ? runDrain(operation.operationId, at + budgets.drainMs)
      : runStop(operation.operationId)
    return { kind: "operation", operation: run.operation }
  }

  function read(operationId: string): RecoveryOutcome {
    const run = runs.get(operationId)
    if (run) return { kind: "operation", operation: run.operation }
    const stored = operations()?.read(operationId)
    if (stored) return { kind: "operation", operation: stored }
    return {
      kind: "refused",
      refusal: {
        kind: "receipt_expired",
        message: `machine operation ${operationId} is not held on this machine`,
        requestId: operationId,
      },
    }
  }

  /**
   * Restores the fence an incomplete machine operation left behind. A drain is
   * bookkeeping, so the authorization still covers an unchanged scope and its
   * wait resumes; a stop is destructive, so it returns to its caller for a fresh
   * decision with every gate it took still recorded.
   */
  function reconcileMachineOperations() {
    const store = operations()
    if (!store) return
    const outstanding = store.outstanding()
    if (outstanding.length === 0) return
    const work = activity()
    const scopeRevision = localDaemonScopeRevision(work)
    const at = now()
    for (const operation of outstanding) {
      const gates = store.gates(operation.operationId)
      const run: MachineOperationRun = { operation, callers: new Set(), settled: Promise.resolve() }
      runs.set(operation.operationId, run)
      // An operation a PREVIOUS generation left behind can never fence this
      // one. That owner is provably gone — this process holds the port and the
      // data directory it held — and its gates covered owners that lived inside
      // it. What that generation may have left on the machine is a launch
      // record, which the startup launch reconciliation is what answers for.
      if (operation.target.ownerGeneration !== options.machine.generation) {
        run.operation = commit(settlePreviousGeneration(operation, gates.length, at))
        store.releaseGates(operation.operationId)
        continue
      }
      gate ??= {
        operationId: operation.operationId,
        scopeRevision: operation.scopeRevision,
        owners: gates.map((row) => row.ownerId),
      }
      if (operation.action === "drain_daemon" && operation.scopeRevision === scopeRevision) {
        run.settled = runDrain(operation.operationId, at + budgets.drainMs)
        continue
      }
      const restarted: RecoveryError = {
        code: "owner_unavailable",
        origin: "local-daemon",
        target: operation.target,
        stage: operation.phase,
        executionMayContinue: true,
        message: operation.scopeRevision === scopeRevision
          ? `this daemon restarted while the operation was running; its ${gates.length} gates are retained and it must be authorized again`
          : `this daemon restarted and its owners changed; ${gates.length} gates are retained and a new preview is required`,
        at,
      }
      run.operation = commit({
        ...operation,
        state: "needs_action",
        updatedAt: at,
        initiatingError: restarted,
        nextActions: [
          { action: "inspect", scopePreviewRequired: false, reason: "read the owners this daemon holds now" },
          { action: operation.action, scopePreviewRequired: true, reason: "authorize the operation against the current scope" },
        ],
      })
    }
  }

  /**
   * What an earlier generation's unsettled operation turns out to be, read from
   * the one thing this process establishes by running: the owner that recorded
   * it is gone.
   *
   * A stop asked for exactly that and got it, however its own receipt ended —
   * a daemon cannot commit "I exited" after exiting. A drain asked for
   * something else and never reached it, so it stays a failure rather than
   * being rewritten into a success by the death of its owner.
   */
  function settlePreviousGeneration(operation: RecoveryOperation, gates: number, at: number): RecoveryOperation {
    const generation = operation.target.ownerGeneration
    const evidence: RecoveryFacts = {
      execution: { value: "terminal", source: "local-daemon", observedAt: at, generation },
      // Only the daemon process is established gone. What it launched is the
      // launch reconciliation's answer, not this one's.
      cleanup: { value: "unknown", source: "local-daemon", observedAt: at, generation },
      persistence: { value: "committed", source: "local-daemon", observedAt: at, generation },
    }
    if (operation.action === "stop_daemon") {
      return { ...operation, state: "succeeded", updatedAt: at, facts: evidence }
    }
    return {
      ...operation,
      state: "failed",
      updatedAt: at,
      facts: evidence,
      initiatingError: {
        code: "generation_retired",
        origin: "local-daemon",
        target: operation.target,
        stage: operation.phase,
        executionMayContinue: false,
        message: `the daemon generation that authorized this operation is gone; its ${String(gates)} gates covered owners that went with it`,
        at,
      },
      nextActions: [{ action: operation.action, scopePreviewRequired: true, reason: "authorize it against this generation" }],
    }
  }

  return {
    start() {
      if (state !== "created") return
      state = "running"
      reconcileMachineOperations()
      reconcilingLaunches = reconcileLaunches()
      changed()
    },
    stop() {
      clearTimer()
      state = "stopped"
      leases.clear()
    },
    acquire(client = "desktop") {
      if (state === "stopping" || state === "stopped" || gate) return undefined
      const lease = { id: randomUUID(), client, expiresAt: now() + leaseTtlMs }
      leases.set(lease.id, lease)
      idleSince = undefined
      changed()
      return lease
    },
    renew(id: string) {
      const at = now()
      prune(at)
      const current = leases.get(id)
      if (!current || state === "stopping" || state === "stopped") return undefined
      const lease = { ...current, expiresAt: at + leaseTtlMs }
      leases.set(id, lease)
      idleSince = undefined
      changed()
      return lease
    },
    release(id: string) {
      const released = leases.delete(id)
      if (released) changed()
      return released
    },
    recovery: {
      inspect,
      submit,
      read,
      /**
       * What daemon admission asks before letting new session or prompt work in.
       * Recovery and inspection are answered regardless: whoever has to decide
       * what to do about the fence must be able to see through it.
       */
      ingressClosed(): MachineIngressHold | undefined {
        if (gate) return { kind: "operation", ...gate }
        // Only a daemon that has started claims this machine. Before that the
        // listener can already be reachable, and fencing there would refuse
        // work on behalf of an owner that has not taken the machine yet.
        if (!reconcilingLaunches || launchesReconciled) return undefined
        return {
          kind: "launch_reconciliation",
          ...(launchesOverdueAfterMs === undefined
            ? {}
            : { overdueAfterMs: launchesOverdueAfterMs, pending: [...launchesPending] }),
        }
      },
      /** Joins the startup reconciliation; the entry does not have to wait on it. */
      launchesReconciled() {
        return reconcilingLaunches ?? Promise.resolve([])
      },
      target: machineTarget,
      budgets,
      /** Joins the operations this owner started. Tests await it; admission does not. */
      settled() {
        return Promise.all([...runs.values()].map((run) => run.settled))
      },
    },
    reconcile: changed,
    snapshot() {
      const current = evaluate()
      return {
        state,
        leases: leases.size,
        leaseTtlMs,
        idleGraceMs,
        idleSince,
        residencyPins: current.residencyPins,
        work: current.work,
        ...(gate ? { machineRecovery: gate } : {}),
      }
    },
  }
}

/**
 * The request an already recorded operation was created from. Only the intent
 * is compared, and the operation carries every field of it.
 */
function requestOf(operation: RecoveryOperation): RecoveryRequest {
  return {
    requestId: operation.requestId,
    action: operation.action,
    target: operation.target,
    scopeRevision: operation.scopeRevision,
    attempt: operation.attempt,
    ...(operation.linkedOperationId !== undefined ? { linkedOperationId: operation.linkedOperationId } : {}),
  }
}

function storeFailure(error: unknown, target: RecoveryTarget, stage: RecoveryPhase, at: number): RecoveryError {
  return {
    code: "persistence_unavailable",
    origin: "local-daemon",
    target,
    stage,
    executionMayContinue: true,
    message: `this machine's operation store refused the receipt: ${error instanceof Error ? error.message : String(error)}`,
    at,
  }
}

function positive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}

/**
 * Resolves the promise, or reports that it did not within the budget and keeps
 * waiting. The late value is still returned, so a slow read is detached from
 * the deadline rather than dropped.
 */
async function settleWithin<T>(pending: Promise<T>, budgetMs: number, onOverdue: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const overdue = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs)
    timer.unref?.()
  })
  try {
    const raced = await Promise.race([pending.then(() => "settled" as const), overdue.then(() => "overdue" as const)])
    if (raced === "overdue") onOverdue()
    return await pending
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** How many creation identities are probed at once; each costs a subprocess. */
const IDENTITY_PROBE_CONCURRENCY = 4

/**
 * One launch's identity verdict, capped by the reconciliation's own deadline.
 * A probe with no time left is not run: `unknown` is what this owner can say,
 * and it is the same answer the probe would be believed for anyway.
 */
async function identityVerdict(identity: CreationIdentity, deadlineAt: number) {
  const at = Date.now()
  const budget = capChildBudget(deadlineAt, deadlineAt - at, at) - at
  if (budget <= 0) return "unknown" as const
  return (await settleWithin(verifyCreationIdentity(identity), budget, () => {})
    .catch(() => ({ state: "unknown" as const }))).state
}
