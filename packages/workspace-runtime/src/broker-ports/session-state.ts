import type { RuntimeGoalSnapshot, SessionConfig } from "@claxedo/agent-runtime-contract"
import type { RuntimeStore } from "../store"
import type { BrokerEventDelivery } from "./delivery"
import { parseStoredPermissionState } from "./stored-values"

export class BrokerSessionState {
  constructor(private readonly store: RuntimeStore, private readonly delivery: BrokerEventDelivery) {}

  readPermissionState(sessionId: string): Record<string, unknown> | undefined {
    const row = this.store.brokerDatabase().prepare<{ permission_state_json: string | null }>(
      "SELECT permission_state_json FROM session WHERE id = ?",
    ).get(sessionId)
    return row?.permission_state_json ? parseStoredPermissionState(row.permission_state_json) : undefined
  }

  readGoal(sessionId: string): RuntimeGoalSnapshot | null {
    return this.store.getGoal(sessionId)
  }

  async publishGoal(sessionId: string, snapshot: RuntimeGoalSnapshot | null): Promise<void> {
    if (!this.store.getSession(sessionId)) throw new Error(`Unknown goal session ${sessionId}`)
    for (const event of this.store.setGoal(sessionId, snapshot)) this.delivery.broadcast(sessionId, event)
  }

  config(sessionId: string): SessionConfig {
    const config = this.store.getSessionConfig(sessionId)
    if (!config) throw new Error(`Session ${sessionId} has no configuration`)
    return config
  }
}
