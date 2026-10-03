import { createEffect, type Accessor } from "solid-js"
import type { SessionId } from "@/server"
import { useSessionStores, type SessionView } from "@/session"

export function markSeenWhileShown(view: Accessor<SessionView>, shown: () => boolean): void {
  const list = useSessionStores().list
  let asked: { readonly sessionId: SessionId; readonly completedAt: number } | undefined
  createEffect(() => {
    if (!shown()) return
    const { ref } = view()
    const completedAt = view().row()?.lastTurn?.completedAt
    if (completedAt === undefined || completedAt <= (list.readerOf(ref.sessionId).seenAt ?? 0)) return
    if (asked?.sessionId === ref.sessionId && asked.completedAt >= completedAt) return
    asked = { sessionId: ref.sessionId, completedAt }
    list.markSeen(ref, completedAt).catch((error: unknown) => console.warn(`Session ${ref.sessionId}'s seen mark was not recorded`, error))
  })
}
