export type SessionRef = {
  directory: string
  sessionId: string
}

const refs = new Map<string, SessionRef>()

function key(ref: SessionRef) {
  return `${ref.directory}\n${ref.sessionId}`
}

export function setOpenSessions(list: SessionRef[]) {
  refs.clear()
  for (const ref of list) {
    if (!ref.directory || !ref.sessionId || ref.sessionId === "new") continue
    refs.set(key(ref), ref)
  }
}

export function clearOpenSessions() {
  refs.clear()
}

export function hasOpenSession(directory: string, sessionId: string) {
  return refs.has(key({ directory, sessionId }))
}
