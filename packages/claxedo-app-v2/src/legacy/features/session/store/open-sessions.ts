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

const refs = new Map<string, string>()
const directKey = (sessionId: string) => `session:${sessionId}`
const contentKey = (contentId: string) => `content:${contentId}`

export function openSessionRefsFromMetas(metas: Iterable<OpenSessionMeta>): OpenSessionRef[] {
  return Array.from(metas)
    .filter((meta) => meta.type === "session" || meta.type === "context")
    .map((meta) => ({
      sessionId: meta.sessionId ?? meta.content?.sessionId ?? "",
      directory: meta.directory ?? meta.content?.directory,
    }))
}

export function setOpenSessions(list: OpenSessionRef[]) {
  for (const key of refs.keys()) {
    if (key.startsWith("session:")) refs.delete(key)
  }
  for (const ref of list) {
    if (!ref.sessionId || ref.sessionId === "new") continue
    refs.set(directKey(ref.sessionId), ref.sessionId)
  }
}

export function setOpenSessionMeta(
  contentId: string,
  meta: OpenSessionMeta | undefined,
) {
  refs.delete(contentKey(contentId))
  if (!meta || (meta.type !== "session" && meta.type !== "context")) return
  const sessionId = meta.sessionId ?? meta.content?.sessionId
  if (!sessionId || sessionId === "new") return
  refs.set(contentKey(contentId), sessionId)
}

export function setOpenSessionMetas(metas: Iterable<OpenSessionMeta & { id: string }>) {
  for (const key of refs.keys()) {
    if (key.startsWith("content:")) refs.delete(key)
  }
  for (const meta of metas) setOpenSessionMeta(meta.id, meta)
}

export function clearOpenSessions() {
  refs.clear()
}

export function hasOpenSession(sessionId: string) {
  if (refs.has(directKey(sessionId))) return true
  for (const value of refs.values()) {
    if (value === sessionId) return true
  }
  return false
}
