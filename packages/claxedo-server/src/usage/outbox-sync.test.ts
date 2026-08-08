import { describe, expect, test, vi } from "vitest"
import { createUsageOutboxSync } from "./outbox-sync"
import type { TurnUsageRevision } from "./contracts"

const revision = { hostId: "h", sessionRef: "central:s", sessionId: "s", messageId: "m", revision: 1 } as TurnUsageRevision

describe("usage outbox sync", () => {
  test("uploads a bounded batch and marks only acknowledged rows", async () => {
    const markDelivered = vi.fn()
    const markConflict = vi.fn()
    const local = { pendingOutbox: async () => [revision, { ...revision, messageId: "m2" }], markDelivered, markConflict } as never
    const recordTurnUsageBatch = vi.fn(async () => [
      { status: "duplicate" as const, activated: false },
      { status: "conflict" as const, activated: false },
    ])
    const sync = createUsageOutboxSync({ local, central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch } })
    await expect(sync.flush({ org_id: "o", user_id: "u" })).resolves.toMatchObject({ delivered: 1, conflicts: 1 })
    expect(markDelivered).toHaveBeenCalledWith(revision)
    expect(markConflict).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m2" }))
  })

  test("unsigned requests leave rows pending and concurrent refreshes single-flight", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const local = { pendingOutbox: vi.fn(async () => { await gate; return [revision] }), markDelivered: vi.fn(), markConflict: vi.fn() }
    const sync = createUsageOutboxSync({ local: local as never })
    const first = sync.flush()
    const second = sync.flush()
    release()
    expect(first).toBe(second)
    await expect(first).resolves.toEqual({ attempted: 0, delivered: 0, conflicts: 0, pending: 1 })
    expect(local.pendingOutbox).toHaveBeenCalledTimes(1)
  })
})
