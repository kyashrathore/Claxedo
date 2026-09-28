import type { AdapterCancelOutcome, AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { Deadline, HarnessSession, HarnessTransport } from "@claxedo/harness/contract"
import type { AgentRuntimeStore } from "./contracts"
import type { AdmittedTurnCapture, RecoveryTurnCapture, TurnFinalization } from "./recovery-capture"
import type { HarnessHandle } from "./transports"

export type Observed<T> = { status: "value"; value: T } | { status: "error"; error: unknown } | { status: "pending" }

export type CancelTarget = { transport: Pick<HarnessTransport, "cancel">; session: HarnessSession }

/** A capture a stop can name: the lease it runs under and the assistant message the provider knows it by. */
export type StoppableTurn = RecoveryTurnCapture & { leaseId: string; assistantMessageId: string }

export type TurnStop = {
  answer: Observed<AdapterCancelOutcome>
  /** The transport's answer, still watched after `answer` came back pending. */
  settling: Promise<AdapterCancelOutcome>
  /** Whether the store records the turn ended once its producer drained. */
  finished: boolean
}

type HeldTurn = {
  capture: AdmittedTurnCapture
  outcome: AgentTurnOutcome
  handle: HarnessHandle
  endChildren: () => void
}

export function observeUntil<T>(work: Promise<T>, deadlineAt: number, now: () => number): Promise<Observed<T>> {
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
 * The stops a host sends to its admitted turns, and the turns it holds because
 * one was never confirmed. A stop aborts the turn's broker signal before it
 * reaches the transport, which is the one signal every transport checks before
 * it submits, so a stop sent during startup is never lost.
 */
export function createTurnStops(input: {
  store: Pick<AgentRuntimeStore, "turnEvidence">
  now: () => number
  producer: (leaseId: string) => Promise<void> | undefined
  owns: (capture: RecoveryTurnCapture) => boolean
  /** Writes `outcome` for the capture and retains what the store refused. */
  finalize: (capture: RecoveryTurnCapture, outcome: AgentTurnOutcome) => TurnFinalization
  retain: (capture: RecoveryTurnCapture, outcome: AgentTurnOutcome, result: TurnFinalization) => void
  reportSessionFailure: (sessionId: string, error: unknown) => void
}) {
  const stops = new WeakMap<object, "unconfirmed" | "confirmed">()
  const signals = new WeakMap<object, AbortController>()
  const held = new Map<string, HeldTurn>()

  const settle = (sessionId: string) => {
    const turn = held.get(sessionId)
    if (!turn || input.owns(turn.capture)) return
    held.delete(sessionId)
    try { turn.endChildren() } catch (error) { input.reportSessionFailure(sessionId, error) }
  }

  const confirm = (capture: RecoveryTurnCapture) => {
    if (capture.admission && stops.has(capture.admission)) stops.set(capture.admission, "confirmed")
  }

  const end = (turn: HeldTurn) => {
    input.finalize(turn.capture, turn.outcome)
    settle(turn.capture.sessionId)
  }

  return {
    /** Registers the controller behind the turn's broker signal for as long as its producer runs. */
    track(capture: AdmittedTurnCapture, controller: AbortController): () => void {
      signals.set(capture.admission, controller)
      return () => { if (signals.get(capture.admission) === controller) signals.delete(capture.admission) }
    },
    /** A stop was sent. A producer that then ends without a terminal event has stopped. */
    sent: (capture: RecoveryTurnCapture) => capture.admission !== undefined && stops.has(capture.admission),
    /** A stop was sent and the provider refused it or has not answered it. */
    unconfirmed: (capture: RecoveryTurnCapture) => capture.admission !== undefined && stops.get(capture.admission) === "unconfirmed",
    confirm,

    /**
     * Sends one stop and, when the provider accepted it, waits under the same
     * deadline for the turn's producer to drain what it already holds:
     * finalizing on the transport's answer alone would discard output queued
     * behind it. A refused stop, or one the provider says is still running,
     * has nothing to drain yet.
     */
    async stop(capture: StoppableTurn, target: CancelTarget, deadline: Deadline): Promise<TurnStop> {
      if (capture.admission) {
        stops.set(capture.admission, "unconfirmed")
        signals.get(capture.admission)?.abort()
      }
      const turn = { turnId: capture.assistantMessageId, assistantMessageId: capture.assistantMessageId }
      const settling = target.transport.cancel(target.session, turn, deadline)
      const answer = await observeUntil(settling, deadline.at, input.now)
      if (answer.status === "value" && answer.value.execution === "terminal") confirm(capture)
      const accepted = answer.status === "value" && !answer.value.error && answer.value.execution !== "running"
      const producer = accepted ? input.producer(capture.leaseId) : undefined
      if (producer) await observeUntil(producer, deadline.at, input.now)
      return { answer, settling, finished: input.store.turnEvidence(capture.sessionId, capture.assistantMessageId).finished }
    },

    /**
     * Keeps the turn's admission and lease as a retained, retryable failure:
     * its producer failed while the provider had not confirmed the stop, so
     * admitting the next turn could run it over the last one. Reconciliation,
     * retirement of its transport handle or disposal ends it as `outcome`, and
     * only then are its foreground children interrupted.
     */
    hold(capture: AdmittedTurnCapture, outcome: AgentTurnOutcome, turn: { handle: HarnessHandle; endChildren: () => void }): TurnFinalization {
      const result: TurnFinalization = { ok: false, reason: "outcome_unknown",
        error: new Error(`The turn's producer failed while its stop was unconfirmed: ${outcome.status === "failed" ? outcome.error : outcome.status}`) }
      held.set(capture.sessionId, { capture, outcome, ...turn })
      input.retain(capture, outcome, result)
      return result
    },
    /** Called wherever a held turn's admission may have been released; ends its children once it has. */
    settle,
    releaseRetired(handle: HarnessHandle) {
      for (const turn of held.values()) if (turn.handle === handle) end(turn)
    },
    releaseAll() {
      for (const turn of held.values()) end(turn)
    },
  }
}

export type TurnStops = ReturnType<typeof createTurnStops>
