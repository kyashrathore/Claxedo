export type OpenSessionRef = {
  sessionId: string
  directory?: string
}

type OpenSessionMeta = {
  type?: string
  sessionId?: string
  directory?: string
  content?: {
    sessionId?: string
    directory?: string
  }
}

const refs = new Set<string>()

export function openSessionRefsFromMetas(metas: Iterable<OpenSessionMeta>): OpenSessionRef[] {
  return Array.from(metas)
    .filter((meta) => meta.type === "session" || meta.type === "context")
    .map((meta) => ({
      sessionId: meta.sessionId ?? meta.content?.sessionId ?? "",
      directory: meta.directory ?? meta.content?.directory,
    }))
}

export function setOpenSessions(list: OpenSessionRef[]) {
  refs.clear()
  for (const ref of list) {
    if (!ref.sessionId || ref.sessionId === "new") continue
    refs.add(ref.sessionId)
  }
}

export function clearOpenSessions() {
  refs.clear()
}

export function hasOpenSession(sessionId: string) {
  return refs.has(sessionId)
}
