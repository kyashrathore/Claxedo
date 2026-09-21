import { randomUUID } from "node:crypto"
import {
  DEFAULT_RECOVERY_BUDGETS,
  RECOVERY_ACTION_SCOPES,
  capChildBudget,
  finalizeRecoveryOperation,
  normalizeRecoveryTarget,
  recoveryIntentEquals,
  recoveryTargetsMatch,
  type AgentExecutionBinding,
  type AgentTurnOutcome,
  type CleanupFact,
  type ExecutionFact,
  type PersistenceFact,
  type RecoveryAction,
  type RecoveryBudgets,
  type RecoveryError,
  type RecoveryErrorCode,
  type RecoveryFactEvidence,
  type RecoveryFacts,
  type RecoveryGeneration,
  type RecoveryNextAction,
  type RecoveryOperation,
  type RecoveryOutcome,
  type RecoveryPhase,
  type RecoveryRefusal,
  type RecoveryRequest,
  type RecoverySessionTarget,
  type RecoveryTarget,
  type RecoveryTurnTarget,
} from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "../index"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { AgentRuntimeStaleTurnError } from "../harnesses/shared/runtime-store"
import { normalizeDirectory } from "./execution-binding"
import type {
  AgentRuntimeEventEnvelope,
  AgentRuntimeHealth,
  AgentRuntimeRecoveryInspection,
  AgentRuntimeStore,
  RecoveryCaller,
} from "./contracts"
import type { ActiveTurn, TurnAdmissionFence, TurnAdmissions } from "./turn-admission"

/**
 * The turn identity every recovery and finalization effect is checked against.
 * A turn a provider admitted for itself — a Goal iteration, say — has no
 * runtime generation or lease, and the owner states that by leaving those out
 * rather than by minting one that means nothing.
 */
export type RecoveryTurnCapture = {
  sessionId: string
  directory?: RuntimeDirectory
  /** The in-process generation, when this runtime admitted the turn. */
  admission?: object
  /** The durable turn lease, when this owner holds one for it. */
  leaseId?: string
  turnId?: string
  assistantMessageId?: string
  fence?: TurnAdmissionFence
  target: RecoveryTarget
}

export type AdmittedTurnCapture = RecoveryTurnCapture & {
  admission: object
  leaseId: string
  turnId: string
  assistantMessageId: string
  target: RecoveryTurnTarget
}

export type TurnFinalization =
  | { ok: true }
  /** Another generation owns the session; this effect has nothing to finish. */
  | { ok: false; reason: "superseded" }
  | { ok: false; reason: "authority_lost"; error?: unknown }
  | { ok: false; reason: "persistence"; error: unknown }

export type FinalizeTurnOptions = {
  emit?: (event: AgentRuntimeEventEnvelope) => void
  /**
   * Publish the canonical idle frame. A cancelled turn needs it because its
   * producer may never yield again; a turn that reached its own terminal event
   * has already published one, and a second would be a duplicate.
   */
  announceIdle?: boolean
}

type RetainedFailure = {
  capture: RecoveryTurnCapture
  outcome: AgentTurnOutcome
  error: RecoveryError
}

type TrackedOperation = {
  operation: RecoveryOperation
  request: RecoveryRequest
  callers: Set<string>
  sessionId?: string
  deadlineAt: number
  /**
   * The attempt is over: it reached a terminal state or ran out of deadline.
   * Evidence arriving afterwards corrects the facts and never the state, so a
   * cancellation that timed out is not rewritten into one that worked.
   */
  closed: boolean
  closedAt?: number
}

type Observed<T> = { status: "value"; value: T } | { status: "error"; error: unknown } | { status: "pending" }

/**
 * A tombstone only has to outlive the callers that might redeliver a request
 * whose operation has already expired, and each one is a single id. Dropping
 * the oldest bounds them without a sweep of their own.
 */
const RECOVERY_TOMBSTONE_LIMIT = 1024

export type RuntimeRecoveryInput = {
  store: AgentRuntimeStore
  admissions: TurnAdmissions
  adapterForSession: (sessionId: string) => Promise<AgentHarnessAdapter>
  executionBinding: (sessionId: string, directory?: RuntimeDirectory) => AgentExecutionBinding
  publish: (event: AgentRuntimeEventEnvelope) => void
  announceIdle: (sessionId: string, directory?: RuntimeDirectory) => void
  identity?: { workspaceId: string; machineId?: string }
  budgets?: Partial<RecoveryBudgets>
  now?: () => number
}

export function createRuntimeRecovery(input: RuntimeRecoveryInput) {
  const { store, admissions } = input
  const budgets: RecoveryBudgets = { ...DEFAULT_RECOVERY_BUDGETS, ...input.budgets }
  const now = input.now ?? Date.now
  /**
   * This runtime instance. A fact about a session that holds no turn lease
   * still carries the generation of whatever observed it.
   */
  const owner: RecoveryGeneration = `runtime_${randomUUID()}`
  const failures = new Map<string, RetainedFailure>()
  const ownerFailures: RecoveryError[] = []
  const operations = new Map<string, TrackedOperation>()
  const byRequest = new Map<string, string>()
  const inFlight = new Map<string, string>()
  const expiredRequests = new Set<string>()
  const expiredOperations = new Set<string>()

  const machine = input.identity?.machineId !== undefined ? { machineId: input.identity.machineId } : {}

  const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

  const workspaceIdFor = (sessionId: string) =>
    store.getExecutionBinding(sessionId)?.workspaceId ?? input.identity?.workspaceId ?? ""

  const turnTarget = (sessionId: string, turn: ActiveTurn): RecoveryTurnTarget => {
    const writeAuthority = turn.fence?.valid() ? String(turn.fence.fencingToken()) : undefined
    return {
      scope: "turn",
      ...machine,
      workspaceId: workspaceIdFor(sessionId),
      sessionId,
      turnId: turn.turnId,
      ownerGeneration: turn.leaseId,
      ...(writeAuthority !== undefined ? { writeAuthority } : {}),
    }
  }

  const sessionTarget = (sessionId: string, ownerGeneration: RecoveryGeneration): RecoverySessionTarget => ({
    scope: "session",
    ...machine,
    workspaceId: workspaceIdFor(sessionId),
    sessionId,
    ownerGeneration,
  })

  const captureTurn = (sessionId: string, turn: ActiveTurn, directory?: RuntimeDirectory): AdmittedTurnCapture => ({
    sessionId,
    ...(directory !== undefined ? { directory } : {}),
    admission: turn.generation,
    leaseId: turn.leaseId,
    turnId: turn.turnId,
    assistantMessageId: turn.assistantMessageId,
    ...(turn.fence ? { fence: turn.fence } : {}),
    target: turnTarget(sessionId, turn),
  })

  /**
   * A turn only the store knows about, because the provider admitted it for
   * itself. The absent generation is the fact: the runtime can only state that
   * it has not admitted anything over the top of it.
   */
  const captureStoreTurn = (sessionId: string, directory?: RuntimeDirectory): RecoveryTurnCapture => ({
    sessionId,
    ...(directory !== undefined ? { directory } : {}),
    target: sessionTarget(sessionId, store.readTurnAuthority(sessionId)?.leaseId ?? owner),
  })

  const fact = <V extends string>(value: V, source: string, generation = owner): RecoveryFactEvidence<V> =>
    ({ value, source, observedAt: now(), generation })

  const recoveryError = (
    code: RecoveryErrorCode,
    target: RecoveryTarget,
    stage: RecoveryPhase,
    executionMayContinue: boolean,
    message: string,
  ): RecoveryError => ({ code, origin: "AgentRuntime", target, stage, executionMayContinue, message, at: now() })

  const unknownFacts = (generation = owner): RecoveryFacts => ({
    execution: fact<ExecutionFact>("unknown", "runtime.owner", generation),
    cleanup: fact<CleanupFact>("unknown", "runtime.owner", generation),
    persistence: fact<PersistenceFact>("unavailable", "runtime.owner", generation),
  })

  /**
   * The owner's view of a session, read from the maps and rows it already
   * holds. Nothing here awaits that session's admission, producer or store
   * transaction: the wedged session is the one a caller needs this for.
   */
  const sessionFacts = (sessionId: string): RecoveryFacts => {
    const turn = admissions.active(sessionId)
    const retained = failures.get(sessionId)
    const busy = store.getSession(sessionId)?.status === "busy"
    const generation = turn?.leaseId ?? retained?.capture.leaseId ?? store.readTurnAuthority(sessionId)?.leaseId ?? owner
    const execution: ExecutionFact = turn ? "running" : busy ? "unknown" : "terminal"
    return {
      execution: fact(execution, turn ? "runtime.admission" : "runtime.store", generation),
      cleanup: fact<CleanupFact>(turn || retained ? "owned" : "unknown", "runtime.admission", generation),
      persistence: fact<PersistenceFact>(
        retained ? "unavailable" : busy ? "pending" : "committed",
        "runtime.store",
        generation,
      ),
    }
  }

  const sessionHealth = (sessionId: string): AgentRuntimeHealth => {
    const retained = failures.get(sessionId)
    if (!retained) return { status: "ok" }
    return {
      status: "degraded",
      reason: retained.error.code,
      message: retained.error.message,
      sessions: [{ id: sessionId, status: "busy", message: retained.error.message }],
    }
  }

  /**
   * The one write that ends a turn. Normal completion, a failed turn, a
   * cancellation and a reconciliation retry all arrive here with the identity
   * they captured before their awaits, and the store refuses the write outright
   * when a different lease now owns the session.
   */
  const finalizeTurn = (
    capture: RecoveryTurnCapture,
    outcome: AgentTurnOutcome,
    options: FinalizeTurnOptions = {},
  ): TurnFinalization => {
    const held = admissions.active(capture.sessionId)
    // A capture with a generation must still own the session. One without a
    // generation may only finish a session this runtime has not admitted a turn
    // for, or it would end somebody else's.
    if (capture.admission ? held?.generation !== capture.admission : held !== undefined) {
      return { ok: false, reason: "superseded" }
    }
    if (capture.fence && !capture.fence.valid()) return { ok: false, reason: "authority_lost" }
    const emit = options.emit ?? input.publish
    let finished
    try {
      finished = store.finishTurn({
        sessionId: capture.sessionId,
        ...(capture.assistantMessageId !== undefined ? { assistantMessageId: capture.assistantMessageId } : {}),
        outcome,
        ...(capture.leaseId !== undefined ? { leaseId: capture.leaseId } : {}),
        ...(capture.fence ? { fencingToken: capture.fence.fencingToken() } : {}),
      })
    } catch (error) {
      if (error instanceof AgentRuntimeStaleTurnError) return { ok: false, reason: "authority_lost", error }
      return { ok: false, reason: "persistence", error }
    }
    if (options.announceIdle) input.announceIdle(capture.sessionId, capture.directory)
    for (const payload of finished.events) {
      emit({ sessionId: capture.sessionId, directory: capture.directory, payload })
    }
    if (options.announceIdle) {
      emit({
        sessionId: capture.sessionId,
        directory: capture.directory,
        payload: { type: "finish", sessionId: capture.sessionId },
      })
    }
    failures.delete(capture.sessionId)
    if (capture.admission) admissions.release(capture.sessionId, capture.admission)
    return { ok: true }
  }

  /**
   * Hold a failed finalization where an owner can see it and a reconciliation
   * can retry it. The turn stays admitted and its lease stays held: releasing
   * either admits conflicting work over a session the store still records as
   * busy.
   */
  const retainFailure = (capture: RecoveryTurnCapture, outcome: AgentTurnOutcome, result: TurnFinalization) => {
    if (result.ok || result.reason === "superseded") return
    const code: RecoveryErrorCode = result.reason === "authority_lost" ? "authority_lost" : "persistence_unavailable"
    const detail = "error" in result && result.error !== undefined
      ? messageOf(result.error)
      : "the captured turn lease no longer holds"
    failures.set(capture.sessionId, {
      capture,
      outcome,
      error: recoveryError(
        code,
        capture.target,
        "reconcile",
        true,
        `Turn ${capture.turnId ?? capture.sessionId} was not finalized: ${detail}`,
      ),
    })
  }

  /**
   * A turn whose execution ended without reaching the finalizer at all. Its
   * outcome is unknown, so nothing is written; the admission and lease stay
   * held and the error is where an owner can read it.
   */
  const reportTurnFailure = (capture: RecoveryTurnCapture, error: unknown) => {
    retainFailure(
      capture,
      { status: "failed", completedAt: now(), error: messageOf(error) },
      { ok: false, reason: "persistence", error },
    )
  }

  /**
   * End the turn a Goal mutation just stopped. A Goal iteration the provider
   * admitted for itself never took runtime admission, so there is no generation
   * or lease to check it against; this owner can only refuse to write over a
   * turn it has since admitted itself.
   */
  const cancelActiveTurn = (sessionId: string, directory?: RuntimeDirectory) => {
    const running = admissions.active(sessionId)
    const capture = running ? captureTurn(sessionId, running, directory) : captureStoreTurn(sessionId, directory)
    const outcome: AgentTurnOutcome = { status: "cancelled", completedAt: now(), reason: "abort" }
    retainFailure(capture, outcome, finalizeTurn(capture, outcome, { announceIdle: true }))
  }

  const reportOwnerFailure = (error: unknown) => {
    ownerFailures.push(recoveryError(
      "owner_unavailable",
      { scope: "machine", machineId: input.identity?.machineId ?? "local", ownerGeneration: owner },
      "drain",
      true,
      `AgentRuntime teardown failed: ${messageOf(error)}`,
    ))
  }

  const scopeKey = (target: RecoveryTarget) => {
    if (target.scope === "machine") return `machine:${target.machineId}`
    if (target.scope === "harness") return `harness:${target.workspaceId}:${target.harnessKey}`
    return `session:${target.sessionId}`
  }

  const sessionOf = (target: RecoveryTarget) =>
    target.scope === "turn" || target.scope === "session" ? target.sessionId : undefined

  const requestKey = (target: RecoveryTarget, callerId: string, requestId: string) =>
    `${scopeKey(target)}\u0000${callerId}\u0000${requestId}`

  const coalesceKey = (target: RecoveryTarget, action: RecoveryAction) =>
    `${JSON.stringify(normalizeRecoveryTarget(target))}\u0000${action}`

  const expire = (key: string, set: Set<string>) => {
    set.add(key)
    if (set.size <= RECOVERY_TOMBSTONE_LIMIT) return
    const oldest = set.values().next()
    if (!oldest.done) set.delete(oldest.value)
  }

  const sweep = () => {
    const horizon = now() - budgets.reconcileMs * 10
    for (const [operationId, tracked] of operations) {
      if (!tracked.closed || (tracked.closedAt ?? now()) > horizon) continue
      operations.delete(operationId)
      expire(operationId, expiredOperations)
      for (const callerId of tracked.callers) {
        const key = requestKey(tracked.operation.target, callerId, tracked.operation.requestId)
        byRequest.delete(key)
        expire(key, expiredRequests)
      }
    }
  }

  const persist = (tracked: TrackedOperation, callerId: string, created: boolean) => {
    try {
      if (created) store.recordRecoveryOperation(tracked.operation, { callerId })
      else store.updateRecoveryOperation(tracked.operation)
    } catch (error) {
      tracked.operation = { ...tracked.operation, receipt: "volatile" }
      ownerFailures.push(recoveryError(
        "persistence_unavailable",
        tracked.operation.target,
        tracked.operation.phase,
        false,
        `Recovery operation ${tracked.operation.operationId} has no durable receipt: ${messageOf(error)}`,
      ))
    }
  }

  const update = (tracked: TrackedOperation, next: Partial<RecoveryOperation>, callerId: string) => {
    tracked.operation = { ...tracked.operation, ...next, updatedAt: now() }
    persist(tracked, callerId, false)
    return tracked.operation
  }

  const close = (tracked: TrackedOperation, next: Partial<RecoveryOperation>, callerId: string) => {
    const operation = update(tracked, next, callerId)
    tracked.closed = true
    tracked.closedAt = now()
    inFlight.delete(coalesceKey(operation.target, operation.action))
    return operation
  }

  /**
   * Evidence that arrived after the attempt closed. It corrects what the owner
   * believes about the target; it never revises the attempt's own verdict.
   */
  const recordLateEvidence = (operationId: string, facts: RecoveryFacts) => {
    const tracked = operations.get(operationId)
    if (!tracked) return
    tracked.operation = tracked.closed
      ? { ...tracked.operation, facts, updatedAt: now() }
      : finalizeRecoveryOperation(tracked.operation, facts)
    persist(tracked, [...tracked.callers][0] ?? "", false)
  }

  const refuse = (refusal: RecoveryRefusal): RecoveryOutcome => ({ kind: "refused", refusal })
  const answer = (operation: RecoveryOperation): RecoveryOutcome => ({ kind: "operation", operation })

  const mayAct = (caller: RecoveryCaller, target: RecoveryTarget) => {
    if (target.scope === "machine") return caller.authority === "machine"
    if (target.scope === "harness") return caller.authority !== "session"
    return true
  }

  const nextAction = (action: RecoveryAction, reason: string): RecoveryNextAction =>
    ({ action, scopePreviewRequired: false, reason })

  const operationBudget = (action: RecoveryAction) => {
    if (action === "cancel_turn") return budgets.gracefulCancelMs
    if (action === "reconcile_session") return budgets.reconcileMs
    return budgets.ackMs
  }

  const create = (request: RecoveryRequest, callerId: string): TrackedOperation => {
    const startedAt = now()
    const deadlineAt = startedAt + operationBudget(request.action)
    const sessionId = sessionOf(request.target)
    const operation: RecoveryOperation = {
      operationId: `rop_${randomUUID()}`,
      requestId: request.requestId,
      target: normalizeRecoveryTarget(request.target),
      action: request.action,
      scopeRevision: request.scopeRevision,
      attempt: request.attempt,
      state: "accepted",
      phase: "ack",
      phaseDeadlineAt: capChildBudget(deadlineAt, budgets.ackMs, startedAt),
      facts: sessionId ? sessionFacts(sessionId) : unknownFacts(),
      cleanupErrors: [],
      nextActions: [],
      receipt: "durable",
      ...(request.linkedOperationId !== undefined ? { linkedOperationId: request.linkedOperationId } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    }
    const tracked: TrackedOperation = {
      operation,
      request,
      callers: new Set([callerId]),
      ...(sessionId !== undefined ? { sessionId } : {}),
      deadlineAt,
      closed: false,
    }
    operations.set(operation.operationId, tracked)
    byRequest.set(requestKey(request.target, callerId, request.requestId), operation.operationId)
    inFlight.set(coalesceKey(request.target, request.action), operation.operationId)
    persist(tracked, callerId, true)
    return tracked
  }

  const observe = <T>(work: Promise<T>, deadlineAt: number): Promise<Observed<T>> => {
    const settled = work.then(
      (value): Observed<T> => ({ status: "value", value }),
      (error: unknown): Observed<T> => ({ status: "error", error }),
    )
    const remaining = deadlineAt - now()
    if (remaining <= 0) return Promise.race([settled, Promise.resolve<Observed<T>>({ status: "pending" })])
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<Observed<T>>((resolve) => {
      timer = setTimeout(() => resolve({ status: "pending" }), remaining)
    })
    return Promise.race([settled, expiry]).finally(() => clearTimeout(timer))
  }

  /**
   * Finish the captured turn only on evidence that it stopped. An acknowledged
   * cancellation is not termination: releasing the session on one admits the
   * next turn over a provider that is still running the last one.
   */
  const finalizeCancelled = (capture: AdmittedTurnCapture, execution: ExecutionFact) => {
    if (execution !== "terminal") return undefined
    const outcome: AgentTurnOutcome = { status: "cancelled", completedAt: now(), reason: "abort" }
    const result = finalizeTurn(capture, outcome, { announceIdle: true })
    retainFailure(capture, outcome, result)
    return result
  }

  const cancelFacts = (
    outcome: { execution: ExecutionFact; cleanup: CleanupFact },
    capture: AdmittedTurnCapture,
    finalized: TurnFinalization | undefined,
  ): RecoveryFacts => ({
    execution: fact(outcome.execution, "harness.cancelTurn", capture.leaseId),
    cleanup: fact(outcome.cleanup, "harness.cancelTurn", capture.leaseId),
    persistence: fact<PersistenceFact>(
      finalized === undefined ? "pending" : finalized.ok ? "committed" : "unavailable",
      "runtime.store",
      capture.leaseId,
    ),
  })

  const cancelTurn = async (
    tracked: TrackedOperation,
    target: RecoveryTurnTarget,
    callerId: string,
  ): Promise<RecoveryOutcome> => {
    const sessionId = target.sessionId
    // Everything the effects below are checked against is read here, before the
    // first await. After it, `admissions.active` may be a different turn.
    const running = admissions.active(sessionId)
    if (!running) {
      const evidence = store.turnEvidence(sessionId, target.turnId)
      if (evidence.finished) {
        return answer(close(tracked, {
          state: "succeeded",
          phase: "reconcile",
          facts: {
            execution: fact<ExecutionFact>("terminal", "runtime.store", target.ownerGeneration),
            cleanup: fact<CleanupFact>("unknown", "runtime.store", target.ownerGeneration),
            persistence: fact<PersistenceFact>("committed", "runtime.store", target.ownerGeneration),
          },
        }, callerId))
      }
      close(tracked, { state: "failed", facts: sessionFacts(sessionId) }, callerId)
      return refuse({
        kind: "generation_conflict",
        message: `Session ${sessionId} has no admitted turn ${target.turnId}`,
      })
    }
    const current = turnTarget(sessionId, running)
    if (!recoveryTargetsMatch(target, current)) {
      close(tracked, { state: "failed", facts: sessionFacts(sessionId) }, callerId)
      return refuse({
        kind: "generation_conflict",
        message: `Session ${sessionId} is running a different turn generation`,
        current,
      })
    }
    const gate = admissions.gate(sessionId)
    if (!gate) {
      close(tracked, { state: "failed", facts: sessionFacts(sessionId) }, callerId)
      return refuse({ kind: "unavailable", message: `Another recovery operation holds session ${sessionId}` })
    }
    const capture = captureTurn(sessionId, running, store.getSession(sessionId)?.directory ?? undefined)
    const controller = new AbortController()
    try {
      const phaseDeadlineAt = capChildBudget(tracked.deadlineAt, budgets.gracefulCancelMs, now())
      update(tracked, {
        state: "running",
        phase: "graceful_cancel",
        phaseDeadlineAt,
        facts: sessionFacts(sessionId),
      }, callerId)
      const resolved = await observe(
        input.adapterForSession(sessionId),
        capChildBudget(phaseDeadlineAt, budgets.providerQueryMs, now()),
      )
      if (resolved.status !== "value") {
        return answer(close(tracked, {
          state: "needs_action",
          phase: "provider_query",
          initiatingError: recoveryError(
            resolved.status === "error" ? "owner_unavailable" : "deadline_exceeded",
            current,
            "provider_query",
            true,
            resolved.status === "error"
              ? `The harness for session ${sessionId} is unavailable: ${messageOf(resolved.error)}`
              : `The harness for session ${sessionId} did not resolve within the deadline`,
          ),
          facts: sessionFacts(sessionId),
          nextActions: [nextAction("cancel_turn", "retry once the harness answers")],
        }, callerId))
      }
      const adapter = resolved.value
      if (!adapter.cancelTurn) {
        return answer(close(tracked, {
          state: "failed",
          initiatingError: recoveryError(
            "cancellation_unsupported",
            current,
            "graceful_cancel",
            true,
            "This harness cannot cancel a turn",
          ),
          facts: sessionFacts(sessionId),
          nextActions: [],
        }, callerId))
      }
      // A turn that ended while the harness resolved is no longer this
      // operation's to stop, and the turn that replaced it is somebody else's.
      // Whether that counts as this action's postcondition is decided by the
      // facts, not by the turn having gone away.
      if (!admissions.owns(sessionId, capture.admission)) {
        return answer(close(tracked, finalizeRecoveryOperation(tracked.operation, sessionFacts(sessionId)), callerId))
      }
      const settling = adapter.cancelTurn(input.executionBinding(sessionId, capture.directory), {
        turnId: capture.turnId,
        assistantMessageId: capture.assistantMessageId,
        signal: controller.signal,
        deadlineAt: phaseDeadlineAt,
      })
      const observed = await observe(settling, phaseDeadlineAt)
      if (observed.status === "pending") {
        // Abandoned by this caller, not by its owner: the signal lets a
        // transport stop, and the promise stays watched so its late answer
        // corrects the facts on this same operation.
        controller.abort(new Error(`Cancellation of turn ${capture.turnId} exceeded its deadline`))
        const operationId = tracked.operation.operationId
        void settling.then(
          (outcome) => recordLateEvidence(operationId, cancelFacts(outcome, capture, finalizeCancelled(capture, outcome.execution))),
          () => recordLateEvidence(operationId, {
            ...sessionFacts(sessionId),
            execution: fact<ExecutionFact>("unknown", "harness.cancelTurn", capture.leaseId),
          }),
        )
        return answer(close(tracked, {
          state: "needs_action",
          initiatingError: recoveryError(
            "cancellation_timeout",
            current,
            "graceful_cancel",
            true,
            `The harness did not answer the cancellation of turn ${capture.turnId} within the deadline`,
          ),
          facts: sessionFacts(sessionId),
          nextActions: [
            nextAction("cancel_turn", "retry the cancellation"),
            nextAction("reconcile_session", "finalize the turn once its execution is known to have stopped"),
          ],
        }, callerId))
      }
      if (observed.status === "error") {
        return answer(close(tracked, {
          state: "failed",
          initiatingError: recoveryError(
            "provider_unreachable",
            current,
            "graceful_cancel",
            true,
            `The harness rejected the cancellation of turn ${capture.turnId}: ${messageOf(observed.error)}`,
          ),
          facts: sessionFacts(sessionId),
          nextActions: [nextAction("cancel_turn", "retry the cancellation")],
        }, callerId))
      }
      const outcome = observed.value
      const finalized = finalizeCancelled(capture, outcome.execution)
      const facts = cancelFacts(outcome, capture, finalized)
      const settled = finalizeRecoveryOperation({
        ...tracked.operation,
        ...(outcome.error
          ? {
            initiatingError: recoveryError(
              outcome.error.code,
              current,
              "graceful_cancel",
              outcome.execution !== "terminal",
              outcome.error.message,
            ),
          }
          : {}),
        nextActions: finalized?.ok
          ? [nextAction("inspect", "the turn is finalized; cleanup this harness performed is not established")]
          : [nextAction("reconcile_session", "the turn is still owned; reconcile once its execution is known to have stopped")],
      }, facts)
      return answer(close(tracked, settled, callerId))
    } finally {
      gate.release()
    }
  }

  const reconcileSession = (
    tracked: TrackedOperation,
    target: RecoveryTurnTarget | RecoverySessionTarget,
    callerId: string,
  ): RecoveryOutcome => {
    const sessionId = target.sessionId
    const retained = failures.get(sessionId)
    if (!retained) {
      return answer(close(tracked, finalizeRecoveryOperation(
        { ...tracked.operation, phase: "reconcile" },
        sessionFacts(sessionId),
      ), callerId))
    }
    const expected = target.scope === "turn"
      ? retained.capture.target
      : sessionTarget(sessionId, retained.capture.leaseId ?? owner)
    if (!recoveryTargetsMatch(target, expected)) {
      close(tracked, { state: "failed", phase: "reconcile" }, callerId)
      return refuse({
        kind: "generation_conflict",
        message: `Session ${sessionId} retains a failure for a different turn generation`,
        current: expected,
      })
    }
    const result = finalizeTurn(retained.capture, retained.outcome, {
      announceIdle: retained.outcome.status === "cancelled",
    })
    retainFailure(retained.capture, retained.outcome, result)
    const facts = sessionFacts(sessionId)
    if (result.ok) {
      return answer(close(tracked, { state: "succeeded", phase: "reconcile", facts }, callerId))
    }
    return answer(close(tracked, {
      state: "needs_action",
      phase: "reconcile",
      facts,
      initiatingError: failures.get(sessionId)?.error
        ?? recoveryError("generation_retired", expected, "reconcile", false, `Turn ${retained.capture.turnId ?? sessionId} is no longer this owner's to finish`),
      nextActions: [nextAction("reconcile_session", "retry once the store accepts this turn's writes")],
    }, callerId))
  }

  const run = async (tracked: TrackedOperation, request: RecoveryRequest, callerId: string): Promise<RecoveryOutcome> => {
    if (request.action === "inspect") {
      const sessionId = sessionOf(request.target)
      return answer(close(tracked, {
        state: "succeeded",
        facts: sessionId ? sessionFacts(sessionId) : unknownFacts(),
      }, callerId))
    }
    if (request.action === "cancel_turn" && request.target.scope === "turn") {
      return await cancelTurn(tracked, request.target, callerId)
    }
    if (request.action === "reconcile_session" && (request.target.scope === "turn" || request.target.scope === "session")) {
      return reconcileSession(tracked, request.target, callerId)
    }
    close(tracked, { state: "failed" }, callerId)
    return refuse({
      kind: "unavailable",
      message: `${request.action} belongs to the process and machine owners, not the session runtime`,
    })
  }

  const submit = async (request: RecoveryRequest, caller: RecoveryCaller): Promise<RecoveryOutcome> => {
    sweep()
    if (!RECOVERY_ACTION_SCOPES[request.action].includes(request.target.scope)) {
      return refuse({
        kind: "scope_changed",
        message: `Recovery action ${request.action} cannot target a ${request.target.scope}`,
        scopeRevision: request.scopeRevision,
        preview: { sessions: [], resources: [], summary: `${request.action} has no ${request.target.scope} postcondition` },
      })
    }
    if (!mayAct(caller, request.target)) {
      return refuse({
        kind: "unauthorized",
        message: `Caller authority ${caller.authority} cannot act on a ${request.target.scope}`,
      })
    }
    const key = requestKey(request.target, caller.callerId, request.requestId)
    if (expiredRequests.has(key)) {
      return refuse({
        kind: "receipt_expired",
        message: "That recovery receipt has expired; inspect and retry explicitly",
        requestId: request.requestId,
      })
    }
    const existing = byRequest.get(key)
    const tracked = existing !== undefined ? operations.get(existing) : undefined
    if (tracked) {
      if (!recoveryIntentEquals(tracked.request, request)) {
        return refuse({
          kind: "intent_conflict",
          message: "That request id already names a different recovery intent",
          requestId: request.requestId,
        })
      }
      return answer(tracked.operation)
    }
    // One in-flight action per target generation: a second caller joins it with
    // its own receipt rather than opening a second controller over one turn.
    const joined = inFlight.get(coalesceKey(request.target, request.action))
    const joinable = joined !== undefined ? operations.get(joined) : undefined
    if (joinable && !joinable.closed) {
      joinable.callers.add(caller.callerId)
      byRequest.set(key, joinable.operation.operationId)
      return answer(joinable.operation)
    }
    return await run(create(request, caller.callerId), request, caller.callerId)
  }

  const read = (operationId: string, caller: RecoveryCaller): RecoveryOutcome | undefined => {
    sweep()
    const tracked = operations.get(operationId)
    if (tracked) {
      if (!tracked.callers.has(caller.callerId)) {
        return refuse({ kind: "unauthorized", message: "That recovery operation belongs to another caller" })
      }
      return answer(tracked.operation)
    }
    if (expiredOperations.has(operationId)) {
      return refuse({
        kind: "receipt_expired",
        message: "That recovery receipt has expired; inspect and retry explicitly",
        requestId: operationId,
      })
    }
    const durable = store.readRecoveryOperation(operationId)
    return durable ? answer(durable) : undefined
  }

  const inspect = (sessionId: string, directory?: RuntimeDirectory): AgentRuntimeRecoveryInspection => {
    sweep()
    const session = store.getSession(sessionId)
    const scoped = directory === undefined
      || normalizeDirectory(directory) === normalizeDirectory(session?.directory ?? undefined)
    const turn = scoped ? admissions.active(sessionId) : undefined
    const retained = failures.get(sessionId)
    return {
      sessionId,
      ...(turn ? { target: turnTarget(sessionId, turn) } : {}),
      facts: scoped ? sessionFacts(sessionId) : unknownFacts(),
      health: scoped
        ? sessionHealth(sessionId)
        : { status: "unavailable", reason: "scope_mismatch", message: `Session ${sessionId} does not belong to this directory` },
      failures: scoped ? [...(retained ? [retained.error] : []), ...ownerFailures] : [],
      operations: scoped
        ? [...operations.values()].filter((tracked) => tracked.sessionId === sessionId).map((tracked) => tracked.operation)
        : [],
      queued: scoped ? admissions.queued(sessionId) : 0,
    }
  }

  return {
    inspect,
    submit,
    read,
    turnTarget,
    captureTurn,
    captureStoreTurn,
    cancelActiveTurn,
    finalizeTurn,
    retainFailure,
    reportTurnFailure,
    reportOwnerFailure,
  }
}

export type RuntimeRecovery = ReturnType<typeof createRuntimeRecovery>
