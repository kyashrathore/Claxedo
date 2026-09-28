import { createContext, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionId } from "@/server"

export type UnseenFailures = {
  readonly has: (sessionId: SessionId) => boolean
  readonly raised: (sessionId: SessionId) => void
  readonly seen: (sessionId: SessionId) => void
}

export function createUnseenFailures(): UnseenFailures {
  const [unseen, setUnseen] = createStore<Record<SessionId, true | undefined>>({})
  return {
    has: (sessionId) => unseen[sessionId] === true,
    raised: (sessionId) => setUnseen(sessionId, true),
    seen: (sessionId) => {
      if (unseen[sessionId]) setUnseen(sessionId, undefined)
    },
  }
}

export const UnseenFailuresContext = createContext<UnseenFailures>()

export function useUnseenFailures(): UnseenFailures {
  const unseen = useContext(UnseenFailuresContext)
  if (!unseen) throw new Error("useUnseenFailures needs AttentionAlerts above it")
  return unseen
}
