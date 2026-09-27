import type { AgentRuntimeRecovery, RecoveryCaller } from "@claxedo/agent-sdk-runtime"
import type { RecoveryOutcome, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { errorMessage as thrownMessage } from "../error-message"
import { sessionAccessContext, sessionRequestProvenance } from "../session-access-policy"
import type { SessionRouteContext as Ctx } from "./session-route-options"

/**
 * The admitted turn's recovery identity, filled the moment admission returns
 * it. The lease is taken before any turn exists, so its loss callback has
 * nothing to name until this is set.
 */
export function captureTurnTarget() {
  let target: RecoveryTurnTarget | undefined
  return {
    set: (next: RecoveryTurnTarget) => { target = next },
    get: () => target,
  }
}

/**
 * Contain the turn whose durable authority was just revoked, under the exact
 * identity admission handed back. A cancellation carrying only the session
 * would reach whatever is running when it arrives, which after a replacement
 * is somebody else's turn.
 */
export async function containLostTurn(input: {
  runtime: AgentRuntimeRecovery | undefined
  sessionId: string
  target: RecoveryTurnTarget | undefined
  caller: RecoveryCaller
}): Promise<RecoveryOutcome> {
  if (!input.runtime) {
    return refusedOutcome("unavailable", `No runtime owns session ${input.sessionId} to contain its lost turn`)
  }
  const target = input.target
  if (!target) {
    return refusedOutcome("generation_conflict", `Session ${input.sessionId} lost its turn authority before a turn was admitted`)
  }
  try {
    return await submitCancelTurn(input.runtime, target, input.caller, `session-turn-lease-loss:${target.turnId}:${target.ownerGeneration}`)
  } catch (error) {
    // A containment that never became an operation has no receipt to read it
    // back by, and this lease dies with the request. The owner is the only
    // thing that outlives both, so it is told before the caller is.
    const message = thrownMessage(error)
    input.runtime.reportContainmentFailure(target, input.caller, message)
    return refusedOutcome("unavailable", `Session ${input.sessionId} could not record its lost turn's cancellation: ${message}`)
  }
}

/** Cancel whichever turn the owner reports as admitted, or nothing when none is. */
export async function cancelAdmittedTurn(
  runtime: AgentRuntimeRecovery,
  sessionId: string,
  caller: RecoveryCaller,
  requestId: string,
): Promise<RecoveryOutcome | undefined> {
  const target = runtime.inspect(sessionId).target
  return target ? await submitCancelTurn(runtime, target, caller, requestId) : undefined
}

function submitCancelTurn(
  runtime: AgentRuntimeRecovery,
  target: RecoveryTurnTarget,
  caller: RecoveryCaller,
  requestId: string,
): Promise<RecoveryOutcome> {
  return runtime.submit({
    requestId,
    action: "cancel_turn",
    target,
    scopeRevision: target.ownerGeneration,
    attempt: 1,
  }, caller)
}

function refusedOutcome(kind: "unavailable" | "generation_conflict", message: string): RecoveryOutcome {
  return { kind: "refused", refusal: { kind, message } }
}

/**
 * Who the runtime records the operation against. It comes from the claims a
 * boundary verified, never from the body: a caller able to name itself could
 * join or read an operation another caller owns. An unnamed request still has
 * one thing established about it — how it reached this runtime — and that is
 * what it is recorded as, rather than a shared anonymous identity.
 */
export function recoveryCaller(c: Ctx): RecoveryCaller {
  const { actor } = sessionAccessContext(c)
  if (actor) return { callerId: `actor:${actor.actorId}`, authority: "session" }
  return { callerId: `provenance:${sessionRequestProvenance(c)}`, authority: "session" }
}
