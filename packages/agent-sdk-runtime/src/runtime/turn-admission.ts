import type { SteerResult } from "../adapter-contract"
import type { PromptDeliveryRequest, PromptInput } from "../index"
import type {
  AgentRuntimeStore,
  AgentRuntimeTurnStartInput,
  AgentRuntimeTurnStartResult,
} from "./contracts"

export type ActiveTurn = {
  /** The in-process generation every producer write for this turn is fenced against. */
  readonly generation: object
  /** The turn's user message id, which is what a scoped abort names. */
  readonly turnId: string
  readonly assistantMessageId: string
}

export type ClaimedTurn = ActiveTurn & { release: () => void }

/**
 * Per-session turn admission: the in-process claim, the cross-instance store
 * lease, the active turn's identity, and the prompts waiting for it to end.
 *
 * The store lease is the CROSS-INSTANCE half — two runtimes sharing one store
 * (two route clients, say) must not both admit a turn for the same session —
 * and the claim map only covers this instance.
 */
export function createTurnAdmissions(
  store: Pick<AgentRuntimeStore, "acquireTurnLease" | "releaseTurnLease">,
) {
  const active = new Map<string, ActiveTurn>()
  const leases = new Map<string, string>()
  const waiting = new Map<string, Array<(token: object) => void>>()
  const handed = new Map<string, object>()

  /**
   * Wake the waiter that has been waiting longest, and only that one: the turn
   * it claims through `turns.start` cannot be taken by a prompt queued after
   * it, so the prompts a session is holding run in the order they arrived.
   * The session stays busy to later waiters until that waiter claims it or
   * gives it up.
   */
  const handOff = (sessionId: string) => {
    if (active.has(sessionId)) return
    const queue = waiting.get(sessionId)
    const next = queue?.shift()
    if (queue?.length === 0) waiting.delete(sessionId)
    if (!next) return
    const token = {}
    handed.set(sessionId, token)
    next(token)
  }

  return {
    /**
     * Resolves once this waiter owns the session's next turn, for a caller
     * holding a prompt that waits for the running turn. A caller whose start
     * then fails before it claims must `abandon`, which wakes the next waiter;
     * once any claim has taken the session, `abandon` does nothing.
     */
    whenIdle(sessionId: string): Promise<{ abandon: () => void }> {
      const queue = waiting.get(sessionId)
      if (!active.has(sessionId) && !handed.has(sessionId) && !queue?.length) {
        return Promise.resolve({ abandon: () => {} })
      }
      return new Promise<object>((resolve) => {
        if (queue) queue.push(resolve)
        else waiting.set(sessionId, [resolve])
      }).then((token) => ({
        abandon: () => {
          if (handed.get(sessionId) !== token) return
          handed.delete(sessionId)
          handOff(sessionId)
        },
      }))
    },
    active(sessionId: string) {
      return active.get(sessionId)
    },
    owns(sessionId: string, generation: object) {
      return active.get(sessionId)?.generation === generation
    },
    claim(sessionId: string, turn: { turnId: string; assistantMessageId: string }): ClaimedTurn | undefined {
      if (active.has(sessionId)) return undefined
      const claimed: ActiveTurn = { generation: {}, ...turn }
      active.set(sessionId, claimed)
      const leaseId = store.acquireTurnLease(sessionId)
      if (!leaseId) {
        active.delete(sessionId)
        return undefined
      }
      leases.set(sessionId, leaseId)
      handed.delete(sessionId)
      return {
        ...claimed,
        release: () => {
          if (leases.get(sessionId) === leaseId) {
            leases.delete(sessionId)
            store.releaseTurnLease(sessionId, leaseId)
          }
          // Publication and turn finalization both release this turn. Only the
          // call that ends it may hand the session on, or one turn would wake
          // two waiters and they would race for the claim.
          if (active.get(sessionId) !== claimed) return
          active.delete(sessionId)
          handOff(sessionId)
        },
      }
    },
    discard(sessionId: string) {
      const ended = active.delete(sessionId)
      const leaseId = leases.get(sessionId)
      if (leaseId) {
        leases.delete(sessionId)
        store.releaseTurnLease(sessionId, leaseId)
      }
      if (ended) handOff(sessionId)
    },
    clear() {
      active.clear()
      leases.clear()
      handed.clear()
      for (const waiters of waiting.values()) for (const resolve of waiters) resolve({})
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
