import { HTTPException } from "hono/http-exception"
import type { SessionChange } from "./session-delete"

type IdentityChange = { readonly kind: "create" | "change"; readonly settled: Promise<void> }

/**
 * Creation and deletion share a session's identity until every provider and
 * projection effect has settled, so a late deletion never removes a recreated
 * session. A create waits out another create of its id, because the control
 * plane repeats a create when the request that asked for it arrives twice (a
 * browser resends a POST whose connection died), and the repeat has to be
 * answered by the session the first one makes, not refused while it is being
 * made. It never waits out a deletion, whose id may be going back to its
 * reservation.
 */
export function sessionIdentityChanges() {
  const active = new Map<string, IdentityChange>()
  const claim = (sessionId: string, kind: IdentityChange["kind"]): (() => void) | undefined => {
    if (active.has(sessionId)) return undefined
    let release!: () => void
    active.set(sessionId, { kind, settled: new Promise<void>((resolve) => { release = resolve }) })
    return () => {
      active.delete(sessionId)
      release()
    }
  }
  const run: SessionChange = async (sessionId, change) => {
    const release = claim(sessionId, "change")
    if (!release) throw new HTTPException(409, { message: "Session creation or deletion is still in progress" })
    try {
      return await change()
    } finally {
      release()
    }
  }
  return {
    has: (sessionId: string) => active.has(sessionId),
    async claimCreation(sessionId: string): Promise<(() => void) | undefined> {
      for (let change = active.get(sessionId); change?.kind === "create"; change = active.get(sessionId)) await change.settled
      return claim(sessionId, "create")
    },
    run,
  }
}
