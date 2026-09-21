import type { AgentMessageError } from "@claxedo/agent-runtime-contract"
import type { AdapterCancelOutcome } from "../../adapter-contract"
import { cancellationFailure, stopFailure, type CancellationFailure } from "./cancellation-facts"
import type { RequestDeadline } from "../../launch"
import type { ActiveTurn } from "./sdk-runtime-driver"
import type { SessionTurnLifecycle } from "./turn-lifecycle"

export type CancelTurnDeadline = {
  turnId: string
  assistantMessageId: string
  signal: AbortSignal
  deadlineAt: number
}

/**
 * What every SDK-backed harness can establish about stopping one of its turns.
 *
 * The producer leaving its busy section is what makes a replacement turn safe
 * to admit, so it is the only thing here that establishes local termination —
 * and it is not enough on its own: a cancellation the provider never accepted
 * leaves whatever it was running upstream unaccounted for. The driver's own
 * observations reach this through the turn's stop record, so each harness adds
 * its evidence without a branch here.
 */
export async function cancelSdkRuntimeTurn(
  lifecycle: SessionTurnLifecycle<ActiveTurn>,
  harness: string,
  sessionId: string,
  input: CancelTurnDeadline,
): Promise<AdapterCancelOutcome> {
  const turn = lifecycle.get(sessionId)
  // No local entry is not evidence that nothing is running: this adapter's
  // process may have restarted under a turn the store still holds open.
  const deadline: RequestDeadline = { signal: input.signal, deadlineAt: input.deadlineAt }
  if (!lifecycle.abort(sessionId, deadline)) return { execution: "unknown", cleanup: "unknown" }

  // A turn whose cleanup rejected still left its producer, and that rejection
  // is a fact about the cancellation — reported below, not thrown at the caller.
  let closeFailure: CancellationFailure | undefined
  const settled = lifecycle.whenIdle(sessionId).then(() => true, (error: unknown) => {
    closeFailure = cancellationFailure(error, "provider_unreachable")
    return true
  })
  const left = await Promise.race([settled, stoppedWaiting(input)])
  const cleanup = turn?.stops?.cleanup ?? "unknown"
  const failure = stopFailure(turn?.stops) ?? closeFailure
  if (!left) return {
    execution: "running",
    cleanup,
    error: failure ?? {
      code: "cancellation_timeout",
      message: `${harness} turn ${input.turnId} had not left its producer when the deadline passed`,
    },
  }
  if (failure) return { execution: "unknown", cleanup, error: failure }
  return { execution: "terminal", cleanup }
}

/** Resolves false at the caller's deadline, or as soon as the caller stops waiting. */
export function stoppedWaiting(input: { signal: AbortSignal; deadlineAt: number }): Promise<false> {
  return new Promise((resolve) => {
    if (input.signal.aborted) return resolve(false)
    const timer = setTimeout(() => resolve(false), Math.max(0, input.deadlineAt - Date.now()))
    input.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(false) }, { once: true })
  })
}

export type TurnTerminalIdentity = {
  assistantMessageId: string
  sessionId: string
  parentId: string
  agent: string
  model?: { providerID: string; modelID: string }
  directory: string
  created: number
  variant?: string
}

/**
 * The assistant message that closes a turn the model did not close itself.
 *
 * A cancelled turn and a failed turn differ only in the error they carry, and
 * writing that shape twice is how the two drift apart — one gaining a field the
 * other keeps omitting.
 */
export function turnTerminalMessage(identity: TurnTerminalIdentity, error: AgentMessageError) {
  return {
    id: identity.assistantMessageId,
    sessionID: identity.sessionId,
    parentID: identity.parentId,
    agent: identity.agent,
    directory: identity.directory,
    created: identity.created,
    completed: Date.now(),
    error,
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.variant ? { variant: identity.variant } : {}),
  }
}
