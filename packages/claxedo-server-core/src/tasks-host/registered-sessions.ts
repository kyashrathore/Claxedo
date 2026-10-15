import type { SessionOrigin, SessionStateReading } from "@claxedo/tasks"
import { originIds } from "./origin-ids"

/** A session as the row its runtime publishes to the host's registry records it. */
export type RegisteredSession = { workspaceID: string; archived?: number; lastHumanTurnAt?: number }

/**
 * Liveness and handoff read from the registry alone, so a reading never
 * reaches, or wakes, a runtime that may be asleep.
 *
 * A row registered in another workspace than the link names reads as
 * deleted: the link is the only claim on that session, and answering live or
 * archived would tell its reader that a session id exists elsewhere.
 *
 * A person's turn on the session an origin created reads as that origin's
 * handoff sent: the row says that a person's turn happened, not which message
 * it carried, so a session another origin created is no evidence for this one.
 * Nothing is resent on this answer, because a handoff reads the session's
 * history before it sends.
 */
export async function registeredSessionStates(
  origins: readonly SessionOrigin[],
  sessions: ReadonlyMap<string, RegisteredSession>,
): Promise<SessionStateReading[]> {
  return Promise.all(origins.map(async (origin): Promise<SessionStateReading> => {
    const session = origin.sessionRef
    const row = sessions.get(session.sessionId)
    if (!row || row.workspaceID !== session.workspaceId) return { session, state: "deleted", handoff: "unknown" }
    if (row.archived) return { session, state: "archived", handoff: "unknown" }
    const own = (await originIds(origin)).sessionId === session.sessionId
    return { session, state: "live", handoff: own && row.lastHumanTurnAt ? "sent" : "pending" }
  }))
}
