function legacyTerminalScopeKey(input?: string) {
  const value = terminalScopeKey(input)
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function terminalScopeKey(directory?: string) {
  return directory?.trim() || "workspace:unknown"
}

export function legacyTerminalPersistScopeKey(directory?: string) {
  return legacyTerminalScopeKey(directory)
}

export function sessionViewKey(input: {
  sessionId?: string
  directory?: string
  workspaceId?: string
  draftId?: string
}) {
  const sessionId = input.sessionId?.trim()
  const workspaceId = input.workspaceId?.trim() || input.directory?.trim()
  if (sessionId && sessionId !== "new") {
    if (workspaceId) return `workspace:${encodeURIComponent(workspaceId)}:session:${encodeURIComponent(sessionId)}`
    return `session:${encodeURIComponent(sessionId)}`
  }

  const draftId = input.draftId?.trim()
  if (draftId) return `draft:${draftId}`

  if (workspaceId) return `workspace:${encodeURIComponent(workspaceId)}:draft`

  return "workspace:unknown:draft"
}
