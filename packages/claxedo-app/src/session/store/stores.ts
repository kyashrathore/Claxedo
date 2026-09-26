import { getOwner, onCleanup } from "solid-js"
import type { Server, ServerEvent } from "@/server"
import type { SessionStores } from "@/session"
import { createSessionList, type SessionListInternal } from "../list"
import { createRequests, type RequestsInternal } from "../requests"
import { createSessionTranscript } from "../transcript"
import { OPEN_SESSION_LIMIT, createOpenSessions, type OpenSessions } from "./open-sessions"

function dispatchServerEvent(event: ServerEvent, list: SessionListInternal, requests: RequestsInternal, open: OpenSessions): void {
  list.apply(event)
  requests.apply(event)
  if (event.type === "streamGap") return open.forEach((session) => session.gap())
  if ("ref" in event) open.byId(event.ref.sessionId)?.apply(event)
}

export function createSessionStores(server: Server): SessionStores {
  const requests = createRequests(server)
  const list = createSessionList(server, requests)
  const open = createOpenSessions(
    OPEN_SESSION_LIMIT,
    getOwner(),
    (ref) => createSessionTranscript(server, ref, { list, requests }),
    (sessionId) => list.closed(sessionId),
  )
  const unsubscribe = server.subscribe((event) => dispatchServerEvent(event, list, requests, open))
  onCleanup(() => {
    unsubscribe()
    open.disposeAll()
  })
  list.start()
  return {
    list,
    open: (ref) => {
      list.opened(ref.sessionId)
      return open.get(ref)
    },
  }
}
