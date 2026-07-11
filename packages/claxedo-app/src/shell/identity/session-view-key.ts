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

// The single canonical prompt-cache/persist key derivation. BOTH the composer's
// live read (`PromptProvider.session()`) and every scoped `set`/`reset`
// (`pick(scope)` in context/prompt.tsx) MUST route through this so the key they
// resolve is identical. A prompt `Scope` therefore carries the RAW directory +
// RAW session id; `sessionViewKey` is applied exactly once, here. Pre-computing
// the key inside a scope producer (as `promptViewScope` used to) double-wraps it
// once the reset path applies `sessionViewKey` again, drifting the clear target
// off the composer's read target and leaving the just-sent text in the composer.
export function promptScopeKey(scope: { dir?: string; id?: string }) {
  return sessionViewKey({ directory: scope.dir, sessionId: scope.id })
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
