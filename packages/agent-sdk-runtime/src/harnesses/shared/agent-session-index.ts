export type AgentSessionBinding = {
  sessionId: string
  /** Event scope of the runtime session, needed to publish anything about it. */
  directory: string
}

/**
 * Reverse of a runtime store's `getAgentSessionId`: which runtime session a
 * provider's own session id (a Codex thread, a Claude session) belongs to.
 *
 * Drivers receive provider notifications addressed by the PROVIDER id. When one
 * arrives outside a turn — an autonomous Goal turn starting, a Goal the
 * provider updated on its own — there is no turn to read the owner off, and a
 * runtime store indexes only the forward direction. This index is written
 * wherever the adapter resolves a session's provider id, so any session the
 * runtime has bound or prompted can be routed back to.
 */
export function createAgentSessionIndex() {
  const bindings = new Map<string, AgentSessionBinding>()
  const agentSessionIds = new Map<string, string>()
  return {
    remember(input: { sessionId: string; directory: string; agentSessionId: string | null | undefined }) {
      if (!input.agentSessionId) return
      const stale = agentSessionIds.get(input.sessionId)
      // A rebound session must not leave its old provider id resolving to it.
      if (stale && stale !== input.agentSessionId) bindings.delete(stale)
      agentSessionIds.set(input.sessionId, input.agentSessionId)
      bindings.set(input.agentSessionId, { sessionId: input.sessionId, directory: input.directory })
    },
    forget(sessionId: string) {
      const agentSessionId = agentSessionIds.get(sessionId)
      agentSessionIds.delete(sessionId)
      if (agentSessionId) bindings.delete(agentSessionId)
    },
    get(agentSessionId: string): AgentSessionBinding | null {
      return bindings.get(agentSessionId) ?? null
    },
    clear() {
      bindings.clear()
      agentSessionIds.clear()
    },
  }
}

export type AgentSessionIndex = ReturnType<typeof createAgentSessionIndex>
