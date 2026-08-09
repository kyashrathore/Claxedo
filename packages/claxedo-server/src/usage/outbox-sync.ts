import type { UsageLedger } from "../platform/telemetry/product/metering"
import type { SqliteUsageLedger } from "./adapters/sqlite-usage-ledger"
import type { TurnUsageRevision } from "./contracts"

export type UsageOutboxSync = {
  flush(identity?: { org_id: string; user_id: string }): Promise<{
    attempted: number
    delivered: number
    conflicts: number
    pending: number
    acknowledged?: Array<Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">>
  }>
}

export function createUsageOutboxSync(input: {
  local: SqliteUsageLedger
  central?: UsageLedger
  limit?: number
}): UsageOutboxSync {
  let active: ReturnType<UsageOutboxSync["flush"]> | undefined
  const run = async (identity?: { org_id: string; user_id: string }) => {
    const pending = await input.local.pendingOutbox({ limit: input.limit ?? 100 })
    if (!identity || !input.central?.recordTurnUsageBatch || pending.length === 0) {
      return { attempted: 0, delivered: 0, conflicts: 0, pending: pending.length }
    }
    const results = await input.central.recordTurnUsageBatch({ ...identity, revisions: pending })
    if (results.length !== pending.length) throw new Error("usage outbox acknowledgement count mismatch")
    let delivered = 0
    let conflicts = 0
    const acknowledged: Array<Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">> = []
    for (const [index, result] of results.entries()) {
      const fact = pending[index]!
      acknowledged.push({ hostId: fact.hostId, sessionRef: fact.sessionRef, messageId: fact.messageId, revision: fact.revision })
      if (result.status === "conflict") {
        try {
          await input.local.markConflict(fact)
          conflicts += 1
        } catch { /* central acknowledgement still prevents this response from double-counting the pending fact */ }
      } else {
        try {
          await input.local.markDelivered(fact)
          delivered += 1
        } catch { /* retry remains pending and central ingest is idempotent */ }
      }
    }
    return {
      attempted: pending.length,
      delivered,
      conflicts,
      pending: Math.max(0, pending.length - delivered - conflicts),
      acknowledged,
    }
  }
  return {
    flush(identity) {
      if (active) return active
      active = run(identity).finally(() => { active = undefined })
      return active
    },
  }
}
