import type { UsageLedger } from "../platform/telemetry/product/metering"
import type { SqliteUsageLedger } from "./adapters/sqlite-usage-ledger"

export type UsageOutboxSync = {
  flush(identity?: { org_id: string; user_id: string }): Promise<{
    attempted: number
    delivered: number
    conflicts: number
    pending: number
  }>
}

export function createUsageOutboxSync(input: {
  local: SqliteUsageLedger
  central?: UsageLedger
  limit?: number
}): UsageOutboxSync {
  let active: Promise<{ attempted: number; delivered: number; conflicts: number; pending: number }> | undefined
  const run = async (identity?: { org_id: string; user_id: string }) => {
    const pending = await input.local.pendingOutbox({ limit: input.limit ?? 100 })
    if (!identity || !input.central?.recordTurnUsageBatch || pending.length === 0) {
      return { attempted: 0, delivered: 0, conflicts: 0, pending: pending.length }
    }
    const results = await input.central.recordTurnUsageBatch({ ...identity, revisions: pending })
    if (results.length !== pending.length) throw new Error("usage outbox acknowledgement count mismatch")
    let delivered = 0
    let conflicts = 0
    for (const [index, result] of results.entries()) {
      const fact = pending[index]!
      if (result.status === "conflict") {
        await input.local.markConflict(fact)
        conflicts += 1
      } else {
        await input.local.markDelivered(fact)
        delivered += 1
      }
    }
    return { attempted: pending.length, delivered, conflicts, pending: Math.max(0, pending.length - delivered - conflicts) }
  }
  return {
    flush(identity) {
      if (active) return active
      active = run(identity).finally(() => { active = undefined })
      return active
    },
  }
}
