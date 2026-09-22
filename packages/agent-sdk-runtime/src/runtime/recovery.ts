import { randomUUID } from "node:crypto"
import {
  DEFAULT_RECOVERY_BUDGETS,
  RECOVERY_ACTION_SCOPES,
  capChildBudget,
  finalizeRecoveryOperation,
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
  type RecoveryFacts,
  type RecoveryGeneration,
  type RecoveryNextAction,
  type RecoveryOperation,
  type RecoveryOutcome,
  type RecoveryRefusal,
  type RecoveryRequest,
  type RecoverySessionTarget,
  type RecoveryTurnTarget,
} from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "../index"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { AgentRuntimeStaleTurnError } from "../harnesses/shared/runtime-store"
import { normalizeDirectory } from "./execution-binding"
import type {
  AgentRuntimeEventEnvelope,
  AgentRuntimeRecoveryInspection,
  AgentRuntimeStore,
  RecoveryCaller,
} from "./contracts"
import type { ActiveTurn, TurnAdmissions } from "./turn-admission"
import { createRecoveryFacts, messageOf } from "./recovery-facts"
import { createRecoveryOperations, mayAct, sessionIdOf, type TrackedOperation } from "./recovery-operations"
import type { AdmittedTurnCapture, FinalizeTurnOptions, RecoveryTurnCapture, TurnFinalization } from "./recovery-capture"

export type { AdmittedTurnCapture, FinalizeTurnOptions, RecoveryTurnCapture, TurnFinalization } from "./recovery-capture"

type Observed<T> = { status: "value"; value: T } | { status: "error"; error: unknown } | { status: "pending" }

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
  const machine = input.identity?.machineId !== undefined ? { machineId: input.identity.machineId } : {}

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

  const record = createRecoveryFacts({
    store,
    admissions,
    owner,
    ...(input.identity?.machineId !== undefined ? { machineId: input.identity.machineId } : {}),
    ...(input.identity?.workspaceId !== undefined ? { workspaceId: input.identity.workspaceId } : {}),
    now,
  })
  const registry = createRecoveryOperations({
    store,
    facts: record,
    budgets,
    owner,
    ...(input.identity?.machineId !== undefined ? { machineId: input.identity.machineId } : {}),
    sessionTarget,
    now,
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
   * itself. The durable lease is then the only authority this owner can hold
   * over it, so an absent lease is captured as an absent one: a finalization
   * with neither is refused rather than written unfenced.
   */
  const captureStoreTurn = (sessionId: string, directory?: RuntimeDirectory): RecoveryTurnCapture => {
    const leaseId = store.readTurnAuthority(sessionId)?.leaseId
    return {
      sessionId,
      ...(directory !== undefined ? { directory } : {}),
      ...(leaseId !== undefined ? { leaseId } : {}),
      target: sessionTarget(sessionId, leaseId ?? owner),
    }
  }

  /** The identity a caller must capture before the await its effect follows. */
  const captureSessionTurn = (sessionId: string, directory?: RuntimeDirectory): RecoveryTurnCapture => {
    const running = admissions.active(sessionId)
    return running ? captureTurn(sessionId, running, directory) : captureStoreTurn(sessionId, directory)
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
    // The durable lease is the write authority, and an in-process admission is
    // not a substitute for it: a capture without one would be the unfenced
    // write the lease exists to prevent.
    if (capture.leaseId === undefined) return { ok: false, reason: "no_authority" }
    if (capture.fence && !capture.fence.valid()) return { ok: false, reason: "authority_lost" }
    const emit = options.emit ?? input.publish
    let finished
    try {
      finished = store.finishTurn({
        sessionId: capture.sessionId,
        ...(capture.assistantMessageId !== undefined ? { assistantMessageId: capture.assistantMessageId } : {}),
        outcome,
        leaseId: capture.leaseId,
        ...(capture.fence ? { fencingToken: capture.fence.fencingToken() } : {}),
      })
    } catch (error) {
      if (error instanceof AgentRuntimeStaleTurnError) return { ok: false, reason: "authority_lost", error }
      return { ok: false, reason: "persistence", error }
    }
    // What the store now holds, read back from it rather than inferred from a
    // call that returns the same empty event list whether it recorded the turn
    // or found nothing to record.
    const wrote = capture.turnId !== undefined
      ? store.turnEvidence(capture.sessionId, capture.turnId).finished
      : store.getSession(capture.sessionId)?.status !== "busy"
    if (wrote) {
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
        record.clearRetained(capture.sessionId)
    }
    if (capture.admission) admissions.release(capture.sessionId, capture.admission)
    else if (capture.leaseId !== undefined) store.releaseTurnLease(capture.sessionId, capture.leaseId)
    return { ok: true, wrote }
  }

  /**
   * A turn whose producer stopped without reaching the finalizer. Its own
   * fences decide what that means: a superseded generation has nothing left to
   * finish, and a revoked write authority is an obligation this owner keeps
   * rather than a turn that quietly disappears with its admission still held.
   */
  /**
   * A containment attempt that never became an operation. The gate is here
   * because authority belongs to the request, not to the record it leaves.
   */
  const reportContainmentFailure = (target: RecoveryTurnTarget, caller: RecoveryCaller, message: string) => {
    if (!mayAct(caller, target)) return
    record.retainContainmentFailure(target, caller.callerId, message)
  }

  const abandonTurn = (capture: RecoveryTurnCapture, emit: (event: AgentRuntimeEventEnvelope) => void): TurnFinalization => {
    const outcome: AgentTurnOutcome = {
      status: "failed",
      completedAt: now(),
      error: "The turn stopped producing without a recorded outcome",
    }
    const result = finalizeTurn(capture, outcome, { emit })
    record.retainFailure(capture, outcome, result)
    return result
  }

  /**
   * End the turn a Goal mutation stopped, named by the capture its caller took
   * before the mutation's own await. `directory` only routes the publication;
   * the identity the effect is checked against is the capture's.
   */
  const cancelActiveTurn = (capture: RecoveryTurnCapture, directory?: RuntimeDirectory) => {
    const routed = directory !== undefined ? { ...capture, directory } : capture
    const outcome: AgentTurnOutcome = { status: "cancelled", completedAt: now(), reason: "abort" }
    record.retainFailure(routed, outcome, finalizeTurn(routed, outcome, { announceIdle: true }))
  }

  const refuse = (refusal: RecoveryRefusal): RecoveryOutcome => ({ kind: "refused", refusal })
  const answer = (operation: RecoveryOperation): RecoveryOutcome => ({ kind: "operation", operation })

  const nextAction = (action: RecoveryAction, reason: string): RecoveryNextAction =>
    ({ action, scopePreviewRequired: false, reason })

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
  const finalizeCancelled = (capture: AdmittedTurnCapture, execution: ExecutionFact): TurnFinalization | undefined => {
    if (execution !== "terminal") return undefined
    const outcome: AgentTurnOutcome = { status: "cancelled", completedAt: now(), reason: "abort" }
    const result = finalizeTurn(capture, outcome, { announceIdle: true })
    record.retainFailure(capture, outcome, result)
    // A harness that honours the cancellation by ending its stream lets the
    // turn's own producer finalize before `cancelTurn` resolves, so this write
    // finds its admission gone. The store, not this call, says whether the
    // turn's end is recorded.
    if (!result.ok && result.reason === "superseded" && store.turnEvidence(capture.sessionId, capture.turnId).finished) {
      return { ok: true, wrote: true }
    }
    return result
  }

  const cancelFacts = (
    outcome: { execution: ExecutionFact; cleanup: CleanupFact },
    capture: AdmittedTurnCapture,
    finalized: TurnFinalization | undefined,
  ): RecoveryFacts => ({
    execution: record.fact(outcome.execution, "harness.cancelTurn", capture.leaseId),
    cleanup: record.fact(outcome.cleanup, "harness.cancelTurn", capture.leaseId),
    persistence: record.fact<PersistenceFact>(
      finalized === undefined || (finalized.ok && !finalized.wrote) ? "pending"
        : finalized.ok ? "committed"
        : "unavailable",
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
        return answer(registry.close(tracked, {
          state: "succeeded",
          phase: "reconcile",
          facts: {
            execution: record.fact<ExecutionFact>("terminal", "runtime.store", target.ownerGeneration),
            cleanup: record.fact<CleanupFact>("unknown", "runtime.store", target.ownerGeneration),
            persistence: record.fact<PersistenceFact>("committed", "runtime.store", target.ownerGeneration),
          },
        }, callerId))
      }
      registry.close(tracked, { state: "failed", facts: record.sessionFacts(sessionId) }, callerId)
      return refuse({
        kind: "generation_conflict",
        message: `Session ${sessionId} has no admitted turn ${target.turnId}`,
      })
    }
    const current = turnTarget(sessionId, running)
    if (!recoveryTargetsMatch(target, current)) {
      registry.close(tracked, { state: "failed", facts: record.sessionFacts(sessionId) }, callerId)
      return refuse({
        kind: "generation_conflict",
        message: `Session ${sessionId} is running a different turn generation`,
        current,
      })
    }
    const gate = admissions.gate(sessionId)
    if (!gate) {
      registry.close(tracked, { state: "failed", facts: record.sessionFacts(sessionId) }, callerId)
      return refuse({ kind: "unavailable", message: `Another recovery operation holds session ${sessionId}` })
    }
    const capture = captureTurn(sessionId, running, store.getSession(sessionId)?.directory ?? undefined)
    const controller = new AbortController()
    try {
      const phaseDeadlineAt = capChildBudget(tracked.deadlineAt, budgets.gracefulCancelMs, now())
      registry.update(tracked, {
        state: "running",
        phase: "graceful_cancel",
        phaseDeadlineAt,
        facts: record.sessionFacts(sessionId),
      }, callerId)
      const resolved = await observe(
        input.adapterForSession(sessionId),
        capChildBudget(phaseDeadlineAt, budgets.providerQueryMs, now()),
      )
      if (resolved.status !== "value") {
        return answer(registry.close(tracked, {
          state: "needs_action",
          phase: "provider_query",
          initiatingError: record.recoveryError(
            resolved.status === "error" ? "owner_unavailable" : "deadline_exceeded",
            current,
            "provider_query",
            true,
            resolved.status === "error"
              ? `The harness for session ${sessionId} is unavailable: ${messageOf(resolved.error)}`
              : `The harness for session ${sessionId} did not resolve within the deadline`,
          ),
          facts: record.sessionFacts(sessionId),
          nextActions: [nextAction("cancel_turn", "retry once the harness answers")],
        }, callerId))
      }
      const adapter = resolved.value
      if (!adapter.cancelTurn) {
        return answer(registry.close(tracked, {
          state: "failed",
          initiatingError: record.recoveryError(
            "cancellation_unsupported",
            current,
            "graceful_cancel",
            true,
            "This harness cannot cancel a turn",
          ),
          facts: record.sessionFacts(sessionId),
          nextActions: [],
        }, callerId))
      }
      // A turn that ended while the harness resolved is no longer this
      // operation's to stop, and the turn that replaced it is somebody else's.
      // Whether that counts as this action's postcondition is decided by the
      // facts, not by the turn having gone away.
      if (!admissions.owns(sessionId, capture.admission)) {
        return answer(registry.close(tracked, finalizeRecoveryOperation(tracked.operation, record.sessionFacts(sessionId)), callerId))
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
          (outcome) => registry.recordLateEvidence(operationId, cancelFacts(outcome, capture, finalizeCancelled(capture, outcome.execution))),
          () => registry.recordLateEvidence(operationId, {
            ...record.sessionFacts(sessionId),
            execution: record.fact<ExecutionFact>("unknown", "harness.cancelTurn", capture.leaseId),
          }),
        )
        return answer(registry.close(tracked, {
          state: "needs_action",
          initiatingError: record.recoveryError(
            "cancellation_timeout",
            current,
            "graceful_cancel",
            true,
            `The harness did not answer the cancellation of turn ${capture.turnId} within the deadline`,
          ),
          facts: record.sessionFacts(sessionId),
          nextActions: [
            nextAction("cancel_turn", "retry the cancellation"),
            nextAction("reconcile_session", "finalize the turn once its execution is known to have stopped"),
          ],
        }, callerId))
      }
      if (observed.status === "error") {
        return answer(registry.close(tracked, {
          state: "failed",
          initiatingError: record.recoveryError(
            "provider_unreachable",
            current,
            "graceful_cancel",
            true,
            `The harness rejected the cancellation of turn ${capture.turnId}: ${messageOf(observed.error)}`,
          ),
          facts: record.sessionFacts(sessionId),
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
            initiatingError: record.recoveryError(
              outcome.error.code,
              current,
              "graceful_cancel",
              outcome.execution !== "terminal",
              outcome.error.message,
            ),
          }
          : {}),
        nextActions: finalized?.ok && finalized.wrote
          ? [nextAction("inspect", "the turn is finalized; cleanup this harness performed is not established")]
          : [nextAction("reconcile_session", "the turn is still owned; reconcile once its execution is known to have stopped")],
      }, facts)
      return answer(registry.close(tracked, settled, callerId))
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
    const retained = record.retained(sessionId)
    if (!retained) {
      return answer(registry.close(tracked, finalizeRecoveryOperation(
        { ...tracked.operation, phase: "reconcile" },
        record.sessionFacts(sessionId),
      ), callerId))
    }
    const expected = target.scope === "turn"
      ? retained.capture.target
      : sessionTarget(sessionId, retained.capture.leaseId ?? owner)
    if (!recoveryTargetsMatch(target, expected)) {
      registry.close(tracked, { state: "failed", phase: "reconcile" }, callerId)
      return refuse({
        kind: "generation_conflict",
        message: `Session ${sessionId} retains a failure for a different turn generation`,
        current: expected,
      })
    }
    if (!retained.retryable) {
      return answer(registry.close(tracked, {
        state: "failed",
        phase: "reconcile",
        facts: record.sessionFacts(sessionId),
        initiatingError: retained.error,
        nextActions: [nextAction("inspect", "the turn's write authority is another owner's; read who holds it now")],
      }, callerId))
    }
    const result = finalizeTurn(retained.capture, retained.outcome, {
      announceIdle: retained.outcome.status === "cancelled",
    })
    record.retainFailure(retained.capture, retained.outcome, result)
    const facts = record.sessionFacts(sessionId)
    if (result.ok && result.wrote) {
      return answer(registry.close(tracked, { state: "succeeded", phase: "reconcile", facts }, callerId))
    }
    const settled = record.retained(sessionId)
    return answer(registry.close(tracked, {
      state: "needs_action",
      phase: "reconcile",
      facts,
      initiatingError: settled?.error
        ?? record.recoveryError("projection_failed", expected, "reconcile", true, `The store recorded no outcome for turn ${retained.capture.turnId ?? sessionId}`),
      nextActions: settled && !settled.retryable
        ? [nextAction("inspect", "the turn's write authority is another owner's; read who holds it now")]
        : [nextAction("reconcile_session", "retry once the store accepts this turn's writes")],
    }, callerId))
  }

  /**
   * An operation that throws still has to answer its caller and let go of its
   * target. A rejected promise leaves the attempt `running` for ever, which the
   * expiry sweep skips and every later request on that target coalesces onto.
   */
  const run = async (tracked: TrackedOperation, request: RecoveryRequest, callerId: string): Promise<RecoveryOutcome> => {
    try {
      return await attempt(tracked, request, callerId)
    } catch (error) {
      return answer(registry.close(tracked, {
        state: "failed",
        initiatingError: record.recoveryError(
          "internal_error",
          tracked.operation.target,
          tracked.operation.phase,
          true,
          `Recovery operation ${tracked.operation.operationId} failed: ${messageOf(error)}`,
        ),
        facts: observedFacts(tracked.sessionId),
        nextActions: [nextAction("inspect", "read the target's current facts before retrying")],
      }, callerId))
    }
  }

  /** Facts a failing operation can still report, even about a broken store. */
  const observedFacts = (sessionId: string | undefined): RecoveryFacts => {
    if (sessionId === undefined) return record.unknownFacts()
    try {
      return record.sessionFacts(sessionId)
    } catch {
      return record.unknownFacts()
    }
  }

  const attempt = async (tracked: TrackedOperation, request: RecoveryRequest, callerId: string): Promise<RecoveryOutcome> => {
    if (request.action === "inspect") {
      const sessionId = sessionIdOf(request.target)
      return answer(registry.close(tracked, {
        state: "succeeded",
        facts: sessionId ? record.sessionFacts(sessionId) : record.unknownFacts(),
      }, callerId))
    }
    if (request.action === "cancel_turn" && request.target.scope === "turn") {
      return await cancelTurn(tracked, request.target, callerId)
    }
    if (request.action === "reconcile_session" && (request.target.scope === "turn" || request.target.scope === "session")) {
      return reconcileSession(tracked, request.target, callerId)
    }
    registry.close(tracked, { state: "failed" }, callerId)
    return refuse({
      kind: "unavailable",
      message: `${request.action} belongs to the process and machine owners, not the session runtime`,
    })
  }

  const submit = async (request: RecoveryRequest, caller: RecoveryCaller): Promise<RecoveryOutcome> => {
    registry.sweep()
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
    const key = registry.requestKey(request.target, caller.callerId, request.requestId)
    if (registry.expiredRequest(key)) {
      return refuse({
        kind: "receipt_expired",
        message: "That recovery receipt has expired; inspect and retry explicitly",
        requestId: request.requestId,
      })
    }
    const tracked = registry.trackedFor(key)
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
    const joinable = registry.joinable(request.target, request.action)
    if (joinable) {
      joinable.callers.add(caller.callerId)
      registry.joinReceipt(joinable, caller.callerId)
      registry.register(key, joinable.operation.operationId)
      return answer(joinable.operation)
    }
    const speculative = registry.create(request, caller.callerId)
    const claimed = registry.claimReceipt(speculative, caller.callerId)
    if (!claimed) return await run(speculative, request, caller.callerId)
    // The store already holds this request id under this caller. Whatever owns
    // that operation is the one running it; this instance must not start a
    // second controller for the same effect.
    registry.discard(speculative, request.target, request.action)
    if (!recoveryIntentEquals(registry.intentOf(claimed), request)) {
      registry.forget(key)
      return refuse({
        kind: "intent_conflict",
        message: "That request id already names a different recovery intent",
        requestId: request.requestId,
      })
    }
    registry.adopt(claimed, request, caller.callerId)
    registry.register(key, claimed.operationId)
    return answer(claimed)
  }

  const read = (operationId: string, caller: RecoveryCaller): RecoveryOutcome | undefined => {
    registry.sweep()
    const tracked = registry.byId(operationId)
    if (tracked) {
      if (!tracked.callers.has(caller.callerId) || !mayAct(caller, tracked.operation.target)) {
        return refuse({ kind: "unauthorized", message: "That recovery operation belongs to another caller" })
      }
      return answer(tracked.operation)
    }
    if (registry.expiredOperation(operationId)) {
      return refuse({
        kind: "receipt_expired",
        message: "That recovery receipt has expired; inspect and retry explicitly",
        requestId: operationId,
      })
    }
    // An operation this process never recorded: another instance's, or its own
    // from before a restart. The store holds the receipts, so it is the store
    // that decides whether this caller is one of them.
    const durable = registry.readStoredOperation(operationId, caller)
    if (!durable) return undefined
    if (!mayAct(caller, durable.target)) {
      return refuse({ kind: "unauthorized", message: "That recovery operation belongs to another caller" })
    }
    return answer(durable)
  }

  const inspect = (sessionId: string, directory?: RuntimeDirectory): AgentRuntimeRecoveryInspection => {
    registry.sweep()
    const session = store.getSession(sessionId)
    const scoped = directory === undefined
      || normalizeDirectory(directory) === normalizeDirectory(session?.directory ?? undefined)
    const turn = scoped ? admissions.active(sessionId) : undefined
    const problems: RecoveryError[] = []
    const listed = scoped ? registry.operationsFor(sessionId, problems) : []
    return {
      sessionId,
      ...(turn ? { target: turnTarget(sessionId, turn) } : {}),
      facts: scoped ? record.sessionFacts(sessionId) : record.unknownFacts(),
      health: scoped
        ? record.sessionHealth(sessionId)
        : { status: "unavailable", reason: "scope_mismatch", message: `Session ${sessionId} does not belong to this directory` },
      failures: scoped ? [...record.listFor(sessionId), ...problems] : [],
      operations: listed,
      queued: scoped ? admissions.queued(sessionId) : 0,
    }
  }

  return {
    inspect,
    submit,
    read,
    reportContainmentFailure,
    turnTarget,
    captureTurn,
    captureStoreTurn,
    captureSessionTurn,
    abandonTurn,
    cancelActiveTurn,
    finalizeTurn,
    retainFailure: record.retainFailure,
    reportTurnFailure: record.reportTurnFailure,
    reportOwnerFailure: record.reportOwnerFailure,
    reportSessionFailure: record.reportSessionFailure,
  }
}

export type RuntimeRecovery = ReturnType<typeof createRuntimeRecovery>
