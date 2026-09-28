import { sessionConnectionHealth, type HealthOperations, type ProcessLosses } from "../../contract"

export function codexHealth(losses: ProcessLosses, attached: (sessionId: string) => boolean): HealthOperations {
  return {
    connection: (_directory, sessionId) => sessionConnectionHealth(sessionId, attached, "disconnected"),
    runtime: (_directory, sessionId) => losses.health(sessionId) ?? { status: "ok" },
  }
}
