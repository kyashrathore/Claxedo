import type { SqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import type { UsageLedger } from "@claxedo/server-core/usage/ledger"

type UsageOutboxTelemetry = {
  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void
}

type UsageIdentity = { org_id: string; user_id: string }
type UsageOutboxResult = {
  attempted: number
  delivered: number
  conflicts: number
  pending: number
  acknowledged?: Array<Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">>
}

export type UsageOutboxSync = {
  /** Flush with an identity verified for this request. */
  flush(identity: UsageIdentity): Promise<UsageOutboxResult>
  /** Clear cached authority and wait until any not-yet-uploaded signed batch is invalidated. */
  clearIdentity(): Promise<UsageOutboxResult>
  /** Wake sync after a terminal turn/reconnect using the last verified identity. */
  notify(): Promise<UsageOutboxResult>
}

export function createUsageOutboxSync(input: {
  local: SqliteUsageLedger
  central?: UsageLedger
  limit?: number
  retryBaseMs?: number
  random?: () => number
  telemetry?: UsageOutboxTelemetry
}): UsageOutboxSync {
  let tail: Promise<void> = Promise.resolve()
  const activeByIdentity = new Map<string, Promise<UsageOutboxResult>>()
  let unsignedActive: Promise<UsageOutboxResult> | undefined
  let identity: UsageIdentity | undefined
  let authGeneration = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  const limit = input.limit ?? 100
  const capture = (properties: Record<string, number>) => {
    try {
      input.telemetry?.capture("system", "usage.outbox_sync", properties)
    } catch {
      // Telemetry is evidence, never part of delivery.
    }
  }
  const identityKey = (value: UsageIdentity) => `${value.org_id}\u0000${value.user_id}`
  const pendingOnly = async (): Promise<UsageOutboxResult> => ({
    attempted: 0,
    delivered: 0,
    conflicts: 0,
    pending: (await input.local.pendingOutbox({ limit })).length,
  })
  const schedule = (sync: UsageOutboxSync, pending: number, batchIdentity: UsageIdentity, generation: number) => {
    if (retry) clearTimeout(retry)
    retry = undefined
    if (
      pending <= 0
      || generation !== authGeneration
      || !identity
      || identityKey(identity) !== identityKey(batchIdentity)
      || !input.central?.recordTurnUsageBatch
    ) {
      retryAttempt = 0
      return
    }
    const exponential = (input.retryBaseMs ?? 1_000) * 2 ** Math.min(6, retryAttempt++)
    const jitter = 0.75 + Math.min(1, Math.max(0, (input.random ?? Math.random)())) * 0.5
    const delay = Math.min(60_000, exponential * jitter)
    retry = setTimeout(() => {
      retry = undefined
      void sync.flush(batchIdentity).catch(() => schedule(sync, pending, batchIdentity, generation))
    }, delay)
    if (typeof retry === "object" && "unref" in retry) retry.unref()
  }
  const run = async (batchIdentity: UsageIdentity, generation: number): Promise<UsageOutboxResult> => {
    const pending = await input.local.claimPending(batchIdentity, { limit })
    if (generation !== authGeneration || !input.central?.recordTurnUsageBatch || pending.length === 0) {
      return { attempted: 0, delivered: 0, conflicts: 0, pending: pending.length }
    }
    const oldestObservedAt = pending.reduce(
      (oldest, fact) => Number.isFinite(fact.observedAt) ? Math.min(oldest, fact.observedAt) : oldest,
      Number.POSITIVE_INFINITY,
    )
    const oldestPendingAgeMs = Number.isFinite(oldestObservedAt) ? Math.max(0, Date.now() - oldestObservedAt) : 0
    let results: Awaited<ReturnType<NonNullable<UsageLedger["recordTurnUsageBatch"]>>>
    try {
      results = await input.central.recordTurnUsageBatch({ ...batchIdentity, revisions: pending })
      if (results.length !== pending.length) throw new Error("usage outbox acknowledgement count mismatch")
    } catch (error) {
      capture({
        attempted: pending.length,
        accepted: 0,
        duplicates: 0,
        stale: 0,
        conflicts: 0,
        errors: 1,
        pending: pending.length,
        oldestPendingAgeMs,
      })
      throw error
    }
    let delivered = 0
    let conflicts = 0
    const outcomes = { accepted: 0, duplicates: 0, stale: 0, conflicts: 0 }
    const acknowledged: Array<Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">> = []
    for (const [index, result] of results.entries()) {
      const fact = pending[index]!
      acknowledged.push({ hostId: fact.hostId, sessionRef: fact.sessionRef, messageId: fact.messageId, revision: fact.revision })
      if (result.status === "accepted") outcomes.accepted += 1
      if (result.status === "duplicate") outcomes.duplicates += 1
      if (result.status === "stale") outcomes.stale += 1
      if (result.status === "conflict") outcomes.conflicts += 1
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
    const remaining = Math.max(0, pending.length - delivered - conflicts) || (pending.length === limit ? 1 : 0)
    capture({
      attempted: pending.length,
      ...outcomes,
      errors: 0,
      pending: remaining,
      oldestPendingAgeMs,
    })
    return {
      attempted: pending.length,
      delivered,
      conflicts,
      pending: remaining,
      acknowledged,
    }
  }
  const sync: UsageOutboxSync = {
    flush(nextIdentity) {
      const batchIdentity = { ...nextIdentity }
      const generation = authGeneration
      const key = `${generation}\u0000${identityKey(batchIdentity)}`
      identity = batchIdentity
      const existing = activeByIdentity.get(key)
      if (existing) return existing
      const operation = tail
        .catch(() => undefined)
        .then(() => run(batchIdentity, generation))
        .then((result) => { schedule(sync, result.pending, batchIdentity, generation); return result })
        .catch((error) => { schedule(sync, 1, batchIdentity, generation); throw error })
      tail = operation.then(() => undefined, () => undefined)
      activeByIdentity.set(key, operation)
      void operation.finally(() => {
        if (activeByIdentity.get(key) === operation) activeByIdentity.delete(key)
      }).catch(() => undefined)
      return operation
    },
    clearIdentity() {
      if (identity) {
        identity = undefined
        authGeneration += 1
        retryAttempt = 0
        if (retry) clearTimeout(retry)
        retry = undefined
      }
      if (unsignedActive) return unsignedActive
      unsignedActive = tail
        .catch(() => undefined)
        .then(pendingOnly)
        .finally(() => { unsignedActive = undefined })
      return unsignedActive
    },
    notify() { return identity ? sync.flush(identity) : sync.clearIdentity() },
  }
  return sync
}
