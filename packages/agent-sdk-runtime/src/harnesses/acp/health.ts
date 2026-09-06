import type { AgentHarnessAdapterHealth, AgentHarnessAdapterHealthContext } from "../../adapter-contract"
import type { AgentRuntimeStoreCore } from "../shared/runtime-store"

/**
 * Health for one ACP connection.
 *
 * The runtime store is shared by every harness in a workspace, so a recovering
 * row only belongs to this adapter when the session's harness is this
 * connection. Persistent stores project the config on the list row; the config
 * lookup keeps the same answer for in-memory and custom stores.
 */
export function acpRuntimeHealth(input: {
  store: Pick<AgentRuntimeStoreCore, "listSessions" | "getSessionConfig">
  harnessId: string
  activeTurns: { has(sessionId: string): boolean }
  context?: AgentHarnessAdapterHealthContext
  directory: string
}): AgentHarnessAdapterHealth {
  const { store, context } = input
  // Exact-session health is turn-correlated. Persisted recovery state is
  // historical unless this adapter currently owns an active turn for it.
  if (context?.sessionId && !input.activeTurns.has(context.sessionId)) return { status: "ok" }
  const recovering = store.listSessions(input.directory).filter((session) => {
    if (context?.sessionId && session.id !== context.sessionId) return false
    if (session.status !== "recovering") return false
    const harness = session.config?.harness ?? store.getSessionConfig(session.id)?.harness
    return harness?.id === input.harnessId && harness.access === "connection"
  })
  if (recovering.length === 0) return { status: "ok" }
  return {
    status: "degraded",
    reason: "harness_process_lost",
    message: recovering[0]?.recovery_error ?? "ACP session process restarted",
    sessions: recovering.map((session) => ({
      id: session.id,
      status: session.status,
      message: session.recovery_error ?? null,
    })),
  }
}
