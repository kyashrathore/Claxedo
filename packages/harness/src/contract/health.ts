export function sessionConnectionHealth(sessionId: string | undefined, hasSession: (id: string) => boolean,
  missing: "disconnected" | "configured") {
  return { state: sessionId && !hasSession(sessionId) ? missing : "ready" as const, processes: [] }
}

export function sessionRuntimeHealth(sessionId: string | undefined, hasSession: (id: string) => boolean) {
  return { status: sessionId && !hasSession(sessionId) ? "unavailable" as const : "ok" as const }
}
