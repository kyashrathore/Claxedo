export function acpHealthOperations(hasSession: (sessionId: string) => boolean) {
  return {
    connection: (_directory: string, sessionId?: string) => ({ state: sessionId && !hasSession(sessionId) ? "disconnected" as const : "ready" as const, processes: [] }),
    runtime: (_directory: string, sessionId?: string) => ({ status: sessionId && !hasSession(sessionId) ? "unavailable" as const : "ok" as const }),
  }
}
