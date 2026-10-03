import type { AgentRuntimeStore } from "./contracts"
import type { TurnAdmissions } from "./turn-admission"

export type SessionTreeEntry = Readonly<{ sessionId: string; parentSessionId?: string }>

export type SessionTreeHold =
  | Readonly<{ held: true; leafFirst: readonly SessionTreeEntry[]; release: () => void }>
  | Readonly<{ held: false; sessionId: string; reason: "not_found" | "working" | "awaiting_input" }>

/**
 * Holds a session and every stored descendant idle, for an operation that
 * removes the whole tree. Nothing waits: a session that is running, queued,
 * held or asking for input refuses the whole hold.
 *
 * `leafFirst` names only the sessions bound to a harness of their own. A
 * provider's subagent session has none, and leaves the store with its parent.
 */
export function holdSessionTree(
  input: Readonly<{
    store: Pick<AgentRuntimeStore, "getSession" | "childSessionIds" | "getExecutionBinding">
    admissions: Pick<TurnAdmissions, "holdIdle">
    awaitingInput: (sessionId: string) => boolean
  }>,
  rootSessionId: string,
): SessionTreeHold {
  const root = input.store.getSession(rootSessionId)
  if (!root) return { held: false, sessionId: rootSessionId, reason: "not_found" }
  const tree: SessionTreeEntry[] = []
  const visit = (sessionId: string, parentSessionId: string | undefined) => {
    for (const child of input.store.childSessionIds(sessionId)) visit(child, sessionId)
    tree.push({ sessionId, ...(parentSessionId ? { parentSessionId } : {}) })
  }
  visit(rootSessionId, root.parentID)
  const ids = tree.map((entry) => entry.sessionId).sort()
  const asking = ids.find(input.awaitingInput)
  if (asking) return { held: false, sessionId: asking, reason: "awaiting_input" }
  const holds: Array<() => void> = []
  const release = () => {
    for (const held of holds.splice(0).reverse()) held()
  }
  for (const sessionId of ids) {
    const hold = input.admissions.holdIdle(sessionId)
    if (!hold) {
      release()
      return { held: false, sessionId, reason: "working" }
    }
    holds.push(hold.release)
  }
  return { held: true, leafFirst: tree.filter((entry) => input.store.getExecutionBinding(entry.sessionId)), release }
}
