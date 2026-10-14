import type { AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { RuntimeStore } from "../store"

export type TurnOutcomeObserved = { workspaceId: string; sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }

/**
 * Reports each turn outcome the store commits, once, after it commits: the
 * store's `finishTurn` is the one place a turn durably ends, so an observer
 * placed on it sees every turn's end whatever harness or route ended it, and
 * none that the store refused. A finish that ended no open turn is not reported.
 */
export function observeTurnOutcomes<Store extends Pick<RuntimeStore, "finishTurn" | "getSession">>(
  store: Store,
  workspaceId: string,
  observe: (input: TurnOutcomeObserved) => void,
): Store {
  const finish = store.finishTurn.bind(store)
  store.finishTurn = (value) => {
    const finished = finish(value)
    if (!finished.events.length) return finished
    const session = store.getSession(value.sessionId) as { lastTurn?: AgentTurnOutcome } | null
    const assistantMessageId = value.assistantMessageId ?? session?.lastTurn?.assistantMessageId
    observe({ workspaceId, sessionId: value.sessionId, outcome: value.outcome, ...(assistantMessageId ? { assistantMessageId } : {}) })
    return finished
  }
  return store
}
