import { sessionConnectionHealth, sessionRuntimeHealth } from "../../../contract"

export function acpHealthOperations(hasSession: (sessionId: string) => boolean) {
  return {
    connection: (_directory: string, sessionId?: string) => sessionConnectionHealth(sessionId, hasSession, "disconnected"),
    runtime: (_directory: string, sessionId?: string) => sessionRuntimeHealth(sessionId, hasSession),
  }
}
