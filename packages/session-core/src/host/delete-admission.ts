import type { SessionDeleteExpectation, SessionDeleteRequest } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStore } from "./contracts"
import type { TurnAdmissions } from "./turn-admission"

export type DeleteConflictReason = "generation_changed" | "activity_changed" | "working" | "awaiting_input" | "children_changed" | "unavailable" | "not_found"

export class SessionDeleteAdmissionError extends Error {
  readonly code = "session_delete_conflict"
  constructor(readonly sessionId: string, readonly reason: DeleteConflictReason) {
    super(`Session deletion refused: ${reason}`)
    this.name = "SessionDeleteAdmissionError"
  }
}

function assertSelected(store: AgentRuntimeStore, sessionId: string, expected: SessionDeleteExpectation) {
  const row = store.getSession(sessionId)
  if (!row) throw new SessionDeleteAdmissionError(sessionId, "not_found")
  const facts = row.attention
  if (!facts) throw new SessionDeleteAdmissionError(sessionId, "unavailable")
  if (facts.generation !== expected.generation) throw new SessionDeleteAdmissionError(sessionId, "generation_changed")
  if (facts.activitySequence !== expected.activitySequence) throw new SessionDeleteAdmissionError(sessionId, "activity_changed")
  if (facts.working) throw new SessionDeleteAdmissionError(sessionId, "working")
  if (facts.awaitingInput) throw new SessionDeleteAdmissionError(sessionId, "awaiting_input")
}

function deletionOrder(store: AgentRuntimeStore, sessionId: string, descendants: string[]): string[] {
  const children = new Map<string, string[]>()
  for (const id of descendants) {
    const parentId = store.getSession(id)?.parentID
    if (!parentId) throw new SessionDeleteAdmissionError(sessionId, "children_changed")
    children.set(parentId, [...children.get(parentId) ?? [], id])
  }
  const result: string[] = []
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) visit(child)
    result.push(id)
  }
  visit(sessionId)
  if (result.length !== descendants.length + 1) throw new SessionDeleteAdmissionError(sessionId, "children_changed")
  return result
}

/** Checks every cascading target before the first provider or document effect. */
export async function withDeleteAdmission<T>(
  store: AgentRuntimeStore,
  admissions: TurnAdmissions,
  sessionId: string,
  request: SessionDeleteRequest,
  operation: (deletedSessionIds: string[]) => Promise<T>,
): Promise<T> {
  const selected = new Map([[sessionId, request.expected], ...request.descendants.map(({ sessionId: child, ...expected }) => [child, expected] as const)])
  if (selected.size !== request.descendants.length + 1) throw new SessionDeleteAdmissionError(sessionId, "children_changed")
  const holds: Array<{ release(): void }> = []
  try {
    for (const id of [...selected.keys()].sort()) {
      const hold = admissions.holdIdle(id)
      if (!hold) throw new SessionDeleteAdmissionError(id, "working")
      holds.push(hold)
    }
    const descendants = store.sessionDescendants(sessionId)
    if (descendants.length !== request.descendants.length || descendants.some(id => !selected.has(id))) {
      throw new SessionDeleteAdmissionError(sessionId, "children_changed")
    }
    for (const [id, expected] of selected) assertSelected(store, id, expected)
    return await operation(deletionOrder(store, sessionId, descendants))
  } finally {
    for (const hold of holds.reverse()) hold.release()
  }
}
