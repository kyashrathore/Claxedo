import type { AgentSession } from "@claxedo/agent-runtime-contract"

export type RuntimeSessionTime = { created: number; updated: number }

/**
 * Every store and harness this runtime reads a session from stamps both
 * times. A reader keeps the newer of a listed row and a session read, so a
 * time invented where a session is read would outrank the store's own and
 * drop every read made before it; a session without both is undefined here.
 */
export function runtimeSessionTime(session: Pick<AgentSession, "time">): RuntimeSessionTime | undefined {
  const time = session.time
  if (typeof time?.created !== "number" || typeof time.updated !== "number") return undefined
  return { created: time.created, updated: time.updated }
}
