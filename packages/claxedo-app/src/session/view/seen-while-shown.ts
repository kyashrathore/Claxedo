import { createEffect, type Accessor } from "solid-js"
import type { SessionId } from "@/server"
import type { SessionList, SessionView } from "@/session"

export function markSeenWhileShown(view: Accessor<SessionView>, shown: () => boolean, list: Pick<SessionList, "readerOf" | "markSeen">): void {
  let showing: SessionId | undefined
  let asked: number | undefined
  createEffect(() => {
    const sessionId = shown() ? view().ref.sessionId : undefined
    if (sessionId !== showing) {
      showing = sessionId
      asked = undefined
    }
    const completedAt = view().row()?.lastTurn?.completedAt
    if (!sessionId || completedAt === undefined || completedAt <= (list.readerOf(sessionId).seenAt ?? 0)) return
    if (asked !== undefined && asked >= completedAt) return
    asked = completedAt
    list.markSeen(view().ref, completedAt).catch((error: unknown) => console.warn(`Session ${sessionId}'s seen mark was not recorded`, error))
  })
}
