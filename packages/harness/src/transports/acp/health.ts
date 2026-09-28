import { randomUUID } from "node:crypto"
import { errorMessage } from "@claxedo/helpers"
import type { ConnectionRuntimeObservation, ConnectionRuntimeStatus } from "@claxedo/agent-runtime-contract"
import type { Clock, HealthOperations } from "../../contract"
import { acpAuthenticationRequired } from "./errors"

type Observation = ConnectionRuntimeObservation & { directory: string; sessionId: string }

const CONNECTION_PRECEDENCE = ["ready", "connecting", "auth-required", "failed", "disconnected"] as const

export class AcpConnectionHealth implements HealthOperations {
  private readonly observations = new Map<string, Observation>()
  constructor(private readonly clock: Clock) {}

  begin(sessionId: string, directory: string) {
    const observation: Observation = { sessionId, directory, generation: randomUUID(), role: "execution", state: "connecting", observedAt: this.clock.now() }
    this.observations.set(sessionId, observation)
    const update = (state: Observation["state"], reason?: string) => {
      if (observation.state !== "connecting" && observation.state !== "ready") return
      observation.state = state
      observation.observedAt = this.clock.now()
      observation.reason = reason
    }
    return {
      ready: () => update("ready"),
      disconnected: () => update("disconnected"),
      failed: (error: unknown) => update(acpAuthenticationRequired(error) ? "auth-required" : "failed", errorMessage(error)),
    }
  }

  forget(sessionId: string): void {
    this.observations.delete(sessionId)
  }

  clear(): void {
    this.observations.clear()
  }

  connection(directory: string, sessionId?: string): ConnectionRuntimeStatus {
    const observations = [...this.observations.values()].filter((row) => row.directory === directory && (!sessionId || row.sessionId === sessionId))
    const state = CONNECTION_PRECEDENCE.find((candidate) => observations.some((row) => row.state === candidate))
      ?? (sessionId ? "disconnected" : "configured")
    return { state, processes: observations.map(({ sessionId: _id, directory: _directory, ...observation }) => ({ ...observation })) }
  }

  runtime(directory: string, sessionId?: string) {
    const state = this.connection(directory, sessionId).state
    const healthy = sessionId ? state === "ready" : state !== "failed" && state !== "auth-required"
    return { status: healthy ? "ok" as const : "unavailable" as const }
  }
}
