import { createSignal, getOwner, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { ReaderSettings, Server, ServerEvent, SessionId } from "@/server"
import type { SessionAttention, SessionStores, UnseenOutcome } from "@/session"
import { createSessionList, type SessionListInternal } from "../list"
import { createRequests, type RequestsInternal } from "../requests"
import { attentionRaised, createAttentionChannel } from "./attention"
import { createSessionTranscript } from "../transcript"
import { transcriptViewport } from "../transcript-viewport"
import { CACHED_TURN_LIMIT, OPEN_SESSION_LIMIT, createOpenSessions, type OpenSessions } from "./open-sessions"

function dispatchServerEvent(event: ServerEvent, list: SessionListInternal, requests: RequestsInternal, open: OpenSessions): readonly SessionAttention[] {
  const attention = attentionRaised(event, list)
  list.apply(event)
  requests.apply(event)
  if (event.type === "streamGap") {
    open.forgetCached()
    open.forEach((session) => session.gap())
    return attention
  }
  if (!("ref" in event)) return attention
  open.forgetCached(event.ref.sessionId)
  open.byId(event.ref.sessionId)?.apply(event)
  return attention
}

export function createSessionStores(server: Server, settings: () => ReaderSettings): SessionStores {
  const [unseen, setUnseen] = createStore<Record<SessionId, UnseenOutcome | undefined>>({})
  const requests = createRequests(server)
  const list = createSessionList(server, requests)
  const [viewport, recordViewport] = createSignal(transcriptViewport({ width: window.innerWidth, height: window.innerHeight }))
  const pageShape = () => untrack(() => ({ ...viewport(), ...settings() }))
  const open = createOpenSessions({
    limit: OPEN_SESSION_LIMIT,
    cachedLimit: CACHED_TURN_LIMIT,
    owner: getOwner(),
    make: (ref, seed) => createSessionTranscript(server, ref, { list, requests, pageShape }, seed),
    onEvicted: (sessionId) => list.closed(sessionId),
    stamp: (sessionId) => list.rowOf(sessionId)?.updatedAt,
  })
  const attention = createAttentionChannel()
  const unsubscribe = server.subscribe((event) => attention.raise(dispatchServerEvent(event, list, requests, open)))
  onCleanup(() => {
    unsubscribe()
    attention.clear()
    open.disposeAll()
  })
  list.start()
  return {
    list,
    onAttention: attention.subscribe,
    unseenOutcomes: {
      of: (sessionId) => unseen[sessionId],
      raised: (sessionId, outcome) => setUnseen(sessionId, outcome),
      seen: (sessionId) => setUnseen(sessionId, undefined),
    },
    recordViewport,
    open: (ref) => {
      list.opened(ref.sessionId)
      return open.get(ref)
    },
  }
}
