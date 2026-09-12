import type { SteerResult } from "../adapter-contract"
import {
  buildUserMessage,
  buildUserPromptParts,
  messagePartUpdated,
  messageUpdated,
  type CompatEvent,
} from "../compat-events"
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
 * A prompt for a session that is already running a turn. `steer` hands it to
 * that turn through the harness; anything else answers `queue`, which tells the
 * caller to hold the prompt and start it once `whenIdle` resolves. A harness
 * with no steer method is queued rather than refused, and so is a steer the
 * harness declined — the running turn was the only thing that could have taken
 * it as more input.
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
  commit: (payload: CompatEvent) => void
}): Promise<AgentRuntimeTurnStartResult> {
  const steered = input.requested === "steer" && input.steer && (await input.steer()).ok
  if (steered) for (const payload of steeredUserMessage(input.prompt, input.turn.sessionId)) input.commit(payload)
  return {
    sessionId: input.turn.sessionId,
    userMessageId: input.userMessageId,
    assistantMessageId: steered ? input.running.assistantMessageId : input.assistantMessageId,
    directory: input.directory,
    prompt: input.prompt,
    delivery: steered ? "steer" : "queue",
  }
}

/**
 * The transcript rows for a prompt handed to the turn already running: the user
 * message and its parts, with no turn record of their own.
 *
 * These are committed unfenced on purpose. The store checks a fencing token
 * against the RUNNING turn's, and this prompt carries its own from its own
 * admission lease, so passing it would be rejected as a stale generation.
 */
export function steeredUserMessage(input: PromptInput, sessionId: string): CompatEvent[] {
  const id = input.userMessageId
  if (!id) return []
  return [
    messageUpdated(buildUserMessage({
      id,
      sessionID: sessionId,
      agent: input.agent,
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      ...(input.author ? { author: input.author } : {}),
    })),
    ...buildUserPromptParts(sessionId, id, input.parts).map(messagePartUpdated),
  ]
}
