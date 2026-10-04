import type { TransportHealth } from "./transport"

export function sessionConnectionHealth(sessionId: string | undefined, hasSession: (id: string) => boolean,
  missing: "disconnected" | "configured") {
  return { state: sessionId && !hasSession(sessionId) ? missing : "ready" as const, processes: [] }
}

export function sessionRuntimeHealth(sessionId: string | undefined, hasSession: (id: string) => boolean) {
  return { status: sessionId && !hasSession(sessionId) ? "unavailable" as const : "ok" as const }
}

export class ProcessLosses {
  private readonly lost = new Map<string, string>()
  constructor(private readonly changed: () => void) {}

  record(sessionId: string, message: string): void {
    if (this.lost.get(sessionId) === message) return
    this.lost.set(sessionId, message)
    this.changed()
  }

  recovered(sessionId: string): void {
    if (this.lost.delete(sessionId)) this.changed()
  }

  health(sessionId: string | undefined): TransportHealth | undefined {
    const message = sessionId === undefined ? this.lost.values().next().value : this.lost.get(sessionId)
    return message === undefined ? undefined : { status: "degraded", reason: "harness_process_lost", message }
  }
}
