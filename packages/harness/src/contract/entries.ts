import type { HarnessSession } from "./session"

export function attachedSessionEntry<E extends { session: HarnessSession }>(
  entries: ReadonlyMap<string, E>,
  session: HarnessSession,
  error: () => Error,
  valid?: (entry: E, session: HarnessSession) => boolean,
): E {
  const entry = entries.get(session.binding.sessionId)
  if (!entry || entry.session.binding.upstreamSessionId !== session.binding.upstreamSessionId ||
    (valid && !valid(entry, session))) throw error()
  return entry
}
