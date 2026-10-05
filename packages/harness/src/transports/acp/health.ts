import { randomUUID } from "node:crypto"
import { errorMessage } from "@claxedo/helpers"
import type { ConnectionRuntimeObservation, ConnectionRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { ProcessLosses, type Clock, type HealthOperations, type TransportHealth } from "../../contract"
import { acpAuthenticationRequired } from "./errors"

type Observation = ConnectionRuntimeObservation & { directory: string; sessionId: string }

const CONNECTION_PRECEDENCE = ["ready", "connecting", "auth-required", "failed", "disconnected"] as const

export class AcpConnectionHealth implements HealthOperations {
  private readonly observations = new Map<string, Observation>()
  private readonly ignoredStops: ProcessLosses
  constructor(private readonly clock: Clock, private readonly changed: () => void) {
    this.ignoredStops = new ProcessLosses(changed)
  }

  begin(sessionId: string, directory: string) {
    const observation: Observation = { sessionId, directory, generation: randomUUID(), role: "execution", state: "connecting", observedAt: this.clock.now() }
    this.observations.set(sessionId, observation)
    this.changed()
    const update = (state: Observation["state"], reason?: string) => {
      if (observation.state !== "connecting" && observation.state !== "ready") return
      observation.state = state
      observation.observedAt = this.clock.now()
      observation.reason = reason
      this.changed()
    }
    return {
      ready: () => update("ready"),
      disconnected: () => update("disconnected"),
      failed: (error: unknown) => update(acpAuthenticationRequired(error) ? "auth-required" : "failed", errorMessage(error)),
      stopIgnored: (message: string) => this.ignoredStops.record(sessionId, message),
      stopSettled: () => this.ignoredStops.recovered(sessionId),
    }
  }

  forget(sessionId: string): void {
    this.ignoredStops.recovered(sessionId)
    if (this.observations.delete(sessionId)) this.changed()
  }

  clear(): void {
    this.observations.clear()
  }

  private scoped(directory: string, sessionId?: string): Observation[] {
    return [...this.observations.values()].filter((row) => row.directory === directory && (!sessionId || row.sessionId === sessionId))
  }

  connection(directory: string, sessionId?: string): ConnectionRuntimeStatus {
    const observations = this.scoped(directory, sessionId)
    const state = CONNECTION_PRECEDENCE.find((candidate) => observations.some((row) => row.state === candidate))
      ?? (sessionId && !observations.length ? this.connection(directory).state : "configured")
    return { state, processes: observations.map(({ sessionId: _id, directory: _directory, ...observation }) => ({ ...observation })) }
  }

  runtime(directory: string, sessionId?: string): TransportHealth {
    const state = this.connection(directory, sessionId).state
    const observed = sessionId !== undefined && this.scoped(directory, sessionId).length > 0
    const healthy = observed ? state === "ready" : state !== "failed" && state !== "auth-required"
    if (!healthy) return { status: "unavailable" }
    return this.scoped(directory, sessionId).map((row) => this.ignoredStops.health(row.sessionId)).find((health) => health !== undefined)
      ?? { status: "ok" }
  }
}
