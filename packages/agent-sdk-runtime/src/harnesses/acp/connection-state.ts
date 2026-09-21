import { randomUUID } from "node:crypto"
import type { ConnectionRuntimeObservation, ConnectionRuntimeStatus } from "@claxedo/agent-runtime-contract"

export type ACPConnectionObservationUpdate = {
  state: ConnectionRuntimeObservation["state"]
  reason?: string
}

/** One record per actual process owner; an old launch cannot update its replacement. */
export function createACPConnectionObservations() {
  const owners = new Map<string, { directories: Set<string>; observation: ConnectionRuntimeObservation }>()
  return {
    begin(key: string, directory: string, role: ConnectionRuntimeObservation["role"]) {
      const observation: ConnectionRuntimeObservation = { generation: randomUUID(), role, state: "connecting", observedAt: Date.now() }
      owners.set(key, { directories: new Set([directory]), observation })
      return (update: ACPConnectionObservationUpdate) => {
        if (owners.get(key)?.observation !== observation) return
        if (observation.state === "failed" || observation.state === "disconnected") return
        if (observation.state === "auth-required" && (update.state === "failed" || update.state === "disconnected")) return
        const state = update.state === "disconnected" && observation.state === "connecting" && update.reason !== "disposed"
          ? "failed" : update.state
        Object.assign(observation, { state, observedAt: Date.now(), reason: update.reason })
      }
    },
    associate(key: string, directory: string) { owners.get(key)?.directories.add(directory) },
    read(directory: string, key?: string): ConnectionRuntimeStatus {
      const processes = Array.from(owners.entries()).filter(([owner, value]) => value.directories.has(directory) && (key === undefined || owner === key))
        .map(([, value]) => ({ ...value.observation }))
      const execution = processes.filter((value) => value.role === "execution" && value.reason !== "disposed")
      const state = (["ready", "connecting", "auth-required", "failed", "disconnected"] as const)
        .find((state) => execution.some((value) => value.state === state)) ?? "configured"
      return { state, processes }
    },
  }
}
