import type {
  AgentTurnOutcome,
  CleanupFact,
  ExecutionFact,
  PersistenceFact,
  RecoveryError,
  RecoveryErrorCode,
  RecoveryFactEvidence,
  RecoveryFacts,
  RecoveryGeneration,
  RecoveryPhase,
  RecoveryTarget,
  RecoveryTurnTarget,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeHealth, AgentRuntimeStore } from "./contracts"
import type { TurnAdmissions } from "./turn-admission"
import type { RecoveryTurnCapture, TurnFinalization } from "./recovery-capture"

/** The one reading of an unknown thrown value; every recovery message uses it. */
export const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

type RetainedFailure = {
  capture: RecoveryTurnCapture
  outcome: AgentTurnOutcome
  error: RecoveryError
  /** A lease that moved to another owner is not something a retry can recover. */
  retryable: boolean
}


/**
 * A session collecting these is already degraded, and each one names the same
 * unresolved obligation. The most recent are what an owner acts on.
 */
const RECOVERY_CONTAINMENT_LIMIT = 32


export type RecoveryFactsInput = {
  store: AgentRuntimeStore
  admissions: TurnAdmissions
  /** This runtime instance, carried by a fact about a session holding no lease. */
  owner: RecoveryGeneration
  machineId?: string
  workspaceId?: string
  now: () => number
}

/**
 * What this owner can say about a session, and the failures it is still holding
 * for one. Both are read straight from maps and rows the owner already has, so
 * a session whose producer is wedged is still answerable.
 */
export function createRecoveryFacts(input: RecoveryFactsInput) {
  const { store, admissions, owner, now } = input
  const failures = new Map<string, RetainedFailure>()
  const containmentFailures = new Map<string, RecoveryError[]>()
  const ownerFailures: RecoveryError[] = []

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


  const RETAINED_CODES: Readonly<Record<"no_authority" | "authority_lost" | "persistence", RecoveryErrorCode>> = {
    no_authority: "ownership_unverified",
    authority_lost: "authority_lost",
    persistence: "persistence_unavailable",
  }

  /**
   * Hold a failed finalization where an owner can see it. A storage failure is
   * retryable, so the turn keeps its admission and its lease: releasing either
   * admits conflicting work over a session the store still records as busy. A
   * lease that moved to another owner is not — this owner can never write that
   * turn again, so it gives up the admission slot it is still holding while
   * keeping the obligation to report what it may have left running.
   */
  const retainFailure = (capture: RecoveryTurnCapture, outcome: AgentTurnOutcome, result: TurnFinalization) => {
    if (result.ok || result.reason === "superseded") return
    const retryable = result.reason === "persistence"
    if (!retryable && capture.admission) admissions.release(capture.sessionId, capture.admission)
    const detail = "error" in result && result.error !== undefined
      ? messageOf(result.error)
      : "this owner holds no write authority for it"
    failures.set(capture.sessionId, {
      capture,
      outcome,
      retryable,
      error: recoveryError(
        RETAINED_CODES[result.reason],
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
   * Retained apart from a turn's finalization failure, and never cleared by
   * one: finishing the turn records what this owner knows about it, and says
   * nothing about what the execution whose lease was lost may still be running.
   */
  const retainContainmentFailure = (target: RecoveryTurnTarget, callerId: string, message: string) => {
    const held = containmentFailures.get(target.sessionId) ?? []
    held.push(recoveryError(
      "owner_unavailable",
      target,
      "graceful_cancel",
      true,
      `Containment of turn ${target.turnId} requested by ${callerId} was not opened: ${message}`,
    ))
    containmentFailures.set(target.sessionId, held.slice(-RECOVERY_CONTAINMENT_LIMIT))
  }


  /**
   * A failure an adapter reports about one session's own work — an interaction
   * it could not project or answer, a terminal its store refused. The caller
   * that triggered it gets its error, but the request the provider is still
   * waiting on outlives that caller, so the session's owner keeps it too.
   */
  const reportSessionFailure = (sessionId: string, error: unknown) => {
    const held = containmentFailures.get(sessionId) ?? []
    held.push(recoveryError(
      "owner_unavailable",
      { scope: "session", sessionId, workspaceId: input.workspaceId ?? "", ownerGeneration: owner },
      "provider_query",
      true,
      `The harness owning session ${sessionId} reported a failure: ${messageOf(error)}`,
    ))
    containmentFailures.set(sessionId, held.slice(-RECOVERY_CONTAINMENT_LIMIT))
  }

  const reportOwnerFailure = (error: unknown) => {
    ownerFailures.push(recoveryError(
      "owner_unavailable",
      { scope: "machine", machineId: input.machineId ?? "local", ownerGeneration: owner },
      "drain",
      true,
      `AgentRuntime teardown failed: ${messageOf(error)}`,
    ))
  }


  return {
    fact,
    recoveryError,
    unknownFacts,
    sessionFacts,
    sessionHealth,
    retainFailure,
    retainContainmentFailure,
    reportTurnFailure,
    reportOwnerFailure,
    reportSessionFailure,
    /** The unresolved finalization this session is holding, if it is holding one. */
    retained: (sessionId: string) => failures.get(sessionId),
    clearRetained: (sessionId: string) => { failures.delete(sessionId) },
    retainOwnerFailure: (error: RecoveryError) => { ownerFailures.push(error) },
    listFor: (sessionId: string) => [
      ...(failures.get(sessionId) ? [failures.get(sessionId)!.error] : []),
      ...(containmentFailures.get(sessionId) ?? []),
      ...ownerFailures,
    ],
  }
}

export type RecoveryFactsOwner = ReturnType<typeof createRecoveryFacts>
