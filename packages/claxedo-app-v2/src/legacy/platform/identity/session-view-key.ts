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

// The single canonical prompt-cache/persist key derivation. Both the composer's
// live read (`PromptProvider.session()`) and every scoped `set`/`reset`
// (`pick(scope)` in context/prompt.tsx) must route through this so they resolve
// the same key. A prompt `Scope` therefore carries the raw directory, session
// id, and draft id, and `sessionViewKey` is applied exactly once, here: a scope
// producer that pre-computes the key gets double-wrapped by the reset path,
// drifting the clear target off the read target and leaving sent text in the
// composer.
export function promptScopeKey(scope: { dir?: string; id?: string; draftId?: string }) {
  return sessionViewKey({ directory: scope.dir, sessionId: scope.id, draftId: scope.draftId })
}

export function sessionViewKey(input: {
  sessionId?: string
  directory?: string
  workspaceId?: string
  draftId?: string
}) {
  const sessionId = input.sessionId?.trim()
  // `scopeKey` fuses sense-2 (a real `workspaceId`) and sense-1 (a raw
  // `directory` path); whichever is present wins. It is not a `WorkspaceId` but
  // the view-scope key the composer's prompt cache is keyed by; the `workspace:`
  // prefix is the cache-key namespace, not a claim about the value.
  const scopeKey = input.workspaceId?.trim() || input.directory?.trim()
  if (sessionId && sessionId !== "new") {
    if (scopeKey) return `workspace:${encodeURIComponent(scopeKey)}:session:${encodeURIComponent(sessionId)}`
    return `session:${encodeURIComponent(sessionId)}`
  }

  const draftId = input.draftId?.trim()
  if (draftId) return `draft:${draftId}`

  if (scopeKey) return `workspace:${encodeURIComponent(scopeKey)}:draft`

  return "workspace:unknown:draft"
}
