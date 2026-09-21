import type { SteerResult } from "../adapter-contract"
import type { PromptDeliveryRequest, PromptInput } from "../index"
import type {
  AgentRuntimeStore,
  AgentRuntimeTurnStartInput,
  AgentRuntimeTurnStartResult,
} from "./contracts"

/** The host-owned durable admission a turn's authoritative writes carry. */
export type TurnAdmissionFence = { valid(): boolean; fencingToken(): number }

export type ActiveTurn = {
  /** The in-process generation every producer write for this turn is fenced against. */
  readonly generation: object
  /** The turn's user message id, which is what a scoped cancellation names. */
  readonly turnId: string
  readonly assistantMessageId: string
  /**
   * The durable turn lease. It is this turn's owner generation on the wire,
   * because the in-process generation is an object that cannot leave the
   * process that minted it, let alone survive its restart.
   */
  readonly leaseId: string
  readonly fence?: TurnAdmissionFence
}

export type ClaimedTurn = ActiveTurn & { release: () => void }

/**
 * A caller's place in a session's queue. `unavailable` means the owner shut
 * down while this prompt was parked: there is no session to claim, and the
 * caller must not read the absence of a rejection as an admission.
 */
export type TurnHandoff = { abandon: () => void; unavailable?: true }

type Wake = { token: object } | { unavailable: true }

/**
 * Per-session turn admission: the in-process claim, the cross-instance store
 * lease, the active turn's identity, the prompts waiting for it to end, and the
 * recovery gate that holds all of them while an operation works on the session.
 *
 * The store lease is the CROSS-INSTANCE half — two runtimes sharing one store
 * (two route clients, say) must not both admit a turn for the same session —
 * and the claim map only covers this instance.
 */
export function createTurnAdmissions(
  store: Pick<AgentRuntimeStore, "acquireTurnLease" | "releaseTurnLease">,
) {
  const active = new Map<string, ActiveTurn>()
  const waiting = new Map<string, Array<(wake: Wake) => void>>()
  const handed = new Map<string, object>()
  const gates = new Map<string, object>()

  /**
   * Wake the waiter that has been waiting longest, and only that one: the turn
   * it claims through `turns.start` cannot be taken by a prompt queued after
   * it, so the prompts a session is holding run in the order they arrived.
   * The session stays busy to later waiters until that waiter claims it or
   * gives it up, and stays busy to every waiter while a recovery operation
   * holds the gate.
   */
  const handOff = (sessionId: string) => {
    if (active.has(sessionId) || gates.has(sessionId) || handed.has(sessionId)) return
    const queue = waiting.get(sessionId)
    const next = queue?.shift()
    if (queue?.length === 0) waiting.delete(sessionId)
    if (!next) return
    const token = {}
    handed.set(sessionId, token)
    next({ token })
  }

  const release = (sessionId: string, generation: object) => {
    const current = active.get(sessionId)
    // Publication, turn finalization and recovery all release this turn, and a
    // delayed one of them may arrive after a replacement has taken the session.
    // Only the generation that still owns it may end it or hand it on.
    if (current?.generation !== generation) return false
    active.delete(sessionId)
    store.releaseTurnLease(sessionId, current.leaseId)
    handOff(sessionId)
    return true
  }

  return {
    /**
     * Resolves once this waiter owns the session's next turn, for a caller
     * holding a prompt that waits for the running turn. A caller whose start
     * then fails before it claims must `abandon`, which wakes the next waiter;
     * once any claim has taken the session, `abandon` does nothing.
     */
    whenIdle(sessionId: string): Promise<TurnHandoff> {
      const queue = waiting.get(sessionId)
      if (!active.has(sessionId) && !handed.has(sessionId) && !gates.has(sessionId) && !queue?.length) {
        return Promise.resolve({ abandon: () => {} })
      }
      return new Promise<Wake>((resolve) => {
        if (queue) queue.push(resolve)
        else waiting.set(sessionId, [resolve])
      }).then((wake) => "unavailable" in wake
        ? { abandon: () => {}, unavailable: true as const }
        : {
          abandon: () => {
            if (handed.get(sessionId) !== wake.token) return
            handed.delete(sessionId)
            handOff(sessionId)
          },
        })
    },
    active(sessionId: string) {
      return active.get(sessionId)
    },
    queued(sessionId: string) {
      return waiting.get(sessionId)?.length ?? 0
    },
    owns(sessionId: string, generation: object) {
      return active.get(sessionId)?.generation === generation
    },
    /**
     * Hold the session against new turns while a recovery operation works on
     * it. One holder at a time: a second concurrent request on the same session
     * joins the operation that already holds it rather than opening a second
     * controller over the same generation.
     */
    gate(sessionId: string): { release: () => void } | undefined {
      if (gates.has(sessionId)) return undefined
      const holder = {}
      gates.set(sessionId, holder)
      return {
        release: () => {
          if (gates.get(sessionId) !== holder) return
          gates.delete(sessionId)
          handOff(sessionId)
        },
      }
    },
    gated(sessionId: string) {
      return gates.has(sessionId)
    },
    claim(
      sessionId: string,
      turn: { turnId: string; assistantMessageId: string; fence?: TurnAdmissionFence },
    ): ClaimedTurn | undefined {
      if (active.has(sessionId)) return undefined
      // A waiter granted the session before the gate closed still reaches here,
      // so the gate is rechecked rather than assumed from the handoff. Its
      // place in the queue is spent either way: a promise resolves once, so a
      // refused waiter re-queues through `whenIdle` instead of being re-woken.
      if (gates.has(sessionId)) {
        handed.delete(sessionId)
        return undefined
      }
      const leaseId = store.acquireTurnLease(sessionId)
      if (!leaseId) {
        if (handed.delete(sessionId)) handOff(sessionId)
        return undefined
      }
      const claimed: ActiveTurn = { generation: {}, leaseId, ...turn }
      active.set(sessionId, claimed)
      handed.delete(sessionId)
      return { ...claimed, release: () => void release(sessionId, claimed.generation) }
    },
    release,
    clear() {
      active.clear()
      handed.clear()
      gates.clear()
      for (const waiters of waiting.values()) for (const resolve of waiters) resolve({ unavailable: true })
      waiting.clear()
    },
  }
}

export type TurnAdmissions = ReturnType<typeof createTurnAdmissions>

/**
 * Acceptance and transcript incorporation are different facts. A refusal keeps
 * the input queued with its reason; an unknown outcome must be held for
 * reconciliation, never automatically resent by the caller.
 */
export async function deliverToBusySession(input: {
  running: ActiveTurn
  requested: PromptDeliveryRequest
  turn: AgentRuntimeTurnStartInput
  prompt: PromptInput
  userMessageId: string
  assistantMessageId: string
  directory: AgentRuntimeTurnStartResult["directory"]
  steer?: () => Promise<SteerResult>
}): Promise<AgentRuntimeTurnStartResult> {
  const steering: SteerResult | undefined = input.requested !== "steer" ? undefined
    : input.steer ? await input.steer().catch((error): SteerResult => ({
      ok: false, status: "unknown", message: error instanceof Error ? error.message : "Steering outcome is unknown",
    }))
    : { ok: false, status: "unsupported", message: "This harness does not support steering" }
  const steered = steering?.ok === true
  return {
    sessionId: input.turn.sessionId,
    userMessageId: input.userMessageId,
    assistantMessageId: steered ? input.running.assistantMessageId : input.assistantMessageId,
    directory: input.directory,
    prompt: input.prompt,
    delivery: steered ? "steer" : "queue",
    ...(steering ? { steering } : {}),
  }
}
