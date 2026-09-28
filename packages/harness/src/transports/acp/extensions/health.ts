import { sessionConnectionHealth, sessionRuntimeHealth } from "../../../contract"

export function acpHealthOperations(hasSession: (sessionId: string, directory: string) => boolean) {
  return {
    connection: (directory: string, sessionId?: string) => sessionConnectionHealth(sessionId, (id) => hasSession(id, directory), "disconnected"),
    runtime: (directory: string, sessionId?: string) => sessionRuntimeHealth(sessionId, (id) => hasSession(id, directory)),
  }
}
