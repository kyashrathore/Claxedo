import { describe, expect, test, vi } from "vitest"
import { createUsageOutboxSync } from "@claxedo/local-server/self-hosted-execution"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"

const revision = { hostId: "h", sessionRef: "central:s", sessionId: "s", messageId: "m", revision: 1 } as TurnUsageRevision

describe("usage outbox sync", () => {
  test("uploads a bounded batch and marks only acknowledged rows", async () => {
    const markDelivered = vi.fn()
    const markConflict = vi.fn()
    const pending = async () => [revision, { ...revision, messageId: "m2" }]
    const local = { pendingOutbox: pending, claimPending: pending, markDelivered, markConflict } as never
    const recordTurnUsageBatch = vi.fn(async () => [
      { status: "duplicate" as const, activated: false },
      { status: "conflict" as const, activated: false },
    ])
    const capture = vi.fn()
    const sync = createUsageOutboxSync({
      local,
      central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch },
      telemetry: { capture },
    })
    await expect(sync.flush({ org_id: "o", user_id: "u" })).resolves.toMatchObject({ delivered: 1, conflicts: 1 })
    expect(markDelivered).toHaveBeenCalledWith(revision)
    expect(markConflict).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m2" }))
    expect(capture).toHaveBeenCalledWith("system", "usage.outbox_sync", expect.objectContaining({
      attempted: 2,
      accepted: 0,
      duplicates: 1,
      stale: 0,
      conflicts: 1,
      errors: 0,
      pending: 0,
      oldestPendingAgeMs: expect.any(Number),
    }))
  })

  test("unsigned requests leave rows pending and concurrent refreshes single-flight", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const local = { pendingOutbox: vi.fn(async () => { await gate; return [revision] }), markDelivered: vi.fn(), markConflict: vi.fn() }
    const sync = createUsageOutboxSync({ local: local as never })
    const first = sync.clearIdentity()
    const second = sync.clearIdentity()
    release()
    expect(first).toBe(second)
    await expect(first).resolves.toEqual({ attempted: 0, delivered: 0, conflicts: 0, pending: 1 })
    expect(local.pendingOutbox).toHaveBeenCalledTimes(1)
  })

  test("auth loss invalidates a signed batch before it reaches central ingest", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pendingOutbox = vi.fn(async () => { await gate; return [revision] })
    const recordTurnUsageBatch = vi.fn(async () => [{ status: "accepted" as const, activated: false }])
    const sync = createUsageOutboxSync({
      local: { pendingOutbox, claimPending: pendingOutbox, markDelivered: vi.fn(), markConflict: vi.fn() } as never,
      central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch },
    })

    const signed = sync.flush({ org_id: "org-a", user_id: "user-a" })
    const unsigned = sync.clearIdentity()
    release()

    await expect(signed).resolves.toMatchObject({ attempted: 0, delivered: 0, pending: 1 })
    await expect(unsigned).resolves.toMatchObject({ attempted: 0, delivered: 0, pending: 1 })
    expect(recordTurnUsageBatch).not.toHaveBeenCalled()
  })

  test("signing back into the same account queues a fresh authorized batch", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pendingOutbox = vi.fn()
      .mockImplementationOnce(async () => { await gate; return [revision] })
      .mockResolvedValueOnce([revision])
      .mockResolvedValueOnce([revision])
    const recordTurnUsageBatch = vi.fn(async () => [{ status: "accepted" as const, activated: false }])
    const sync = createUsageOutboxSync({
      local: { pendingOutbox, claimPending: pendingOutbox, markDelivered: vi.fn(), markConflict: vi.fn() } as never,
      central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch },
    })
    const identity = { org_id: "org-a", user_id: "user-a" }

    const stale = sync.flush(identity)
    const cleared = sync.clearIdentity()
    const restored = sync.flush(identity)
    release()
    await Promise.all([stale, cleared, restored])

    expect(recordTurnUsageBatch).toHaveBeenCalledTimes(1)
    expect(recordTurnUsageBatch).toHaveBeenCalledWith({ ...identity, revisions: [revision] })
  })

  test("serializes account switches without mutating the active batch identity", async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const pendingOutbox = vi.fn()
      .mockImplementationOnce(async () => { await gateA; return [revision] })
      .mockResolvedValueOnce([{ ...revision, messageId: "m2" }])
    const recordTurnUsageBatch = vi.fn(async () => [{ status: "accepted" as const, activated: false }])
    const sync = createUsageOutboxSync({
      local: { pendingOutbox, claimPending: pendingOutbox, markDelivered: vi.fn(), markConflict: vi.fn() } as never,
      central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch },
    })

    const accountA = sync.flush({ org_id: "org-a", user_id: "user-a" })
    const accountB = sync.flush({ org_id: "org-b", user_id: "user-b" })
    releaseA()
    await Promise.all([accountA, accountB])

    expect(recordTurnUsageBatch.mock.calls).toEqual([
      [{ org_id: "org-a", user_id: "user-a", revisions: [revision] }],
      [{ org_id: "org-b", user_id: "user-b", revisions: [{ ...revision, messageId: "m2" }] }],
    ])
  })

  test("preserves central acknowledgements when local delivery bookkeeping fails", async () => {
    const local = {
      pendingOutbox: async () => [revision],
      claimPending: async () => [revision],
      markDelivered: async () => { throw new Error("sqlite write failed") },
      markConflict: async () => undefined,
    }
    const sync = createUsageOutboxSync({
      local: local as never,
      central: {
        recordLlmTurn: async () => ({ activated: false }),
        recordTurnUsageBatch: async () => [{ status: "accepted", activated: false }],
      },
    })
    await expect(sync.flush({ org_id: "o", user_id: "u" })).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      conflicts: 0,
      pending: 1,
      acknowledged: [{ hostId: "h", sessionRef: "central:s", messageId: "m", revision: 1 }],
    })
  })

  test("remembers verified identity so terminal and reconnect notifications can wake sync", async () => {
    const pendingOutbox = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([revision])
    const recordTurnUsageBatch = vi.fn(async () => [{ status: "accepted" as const, activated: false }])
    const sync = createUsageOutboxSync({
      local: { pendingOutbox, claimPending: pendingOutbox, markDelivered: vi.fn(), markConflict: vi.fn() } as never,
      central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch },
    })
    await sync.flush({ org_id: "o", user_id: "u" })
    await sync.notify()
    expect(recordTurnUsageBatch).toHaveBeenCalledWith({ org_id: "o", user_id: "u", revisions: [revision] })
  })

  test("notifications stop using the last identity after auth loss", async () => {
    const recordTurnUsageBatch = vi.fn(async () => [{ status: "accepted" as const, activated: false }])
    const pendingOutbox = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([revision])
    const sync = createUsageOutboxSync({
      local: { pendingOutbox, claimPending: pendingOutbox, markDelivered: vi.fn(), markConflict: vi.fn() } as never,
      central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch },
    })

    await sync.flush({ org_id: "o", user_id: "u" })
    await sync.clearIdentity()
    await sync.notify()

    expect(recordTurnUsageBatch).not.toHaveBeenCalled()
  })

  test("backs off and retries while central is unavailable and rows remain pending", async () => {
    vi.useFakeTimers()
    try {
      const capture = vi.fn()
      const recordTurnUsageBatch = vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce([{ status: "accepted" as const, activated: false }])
      const sync = createUsageOutboxSync({
        local: { pendingOutbox: async () => [revision], claimPending: async () => [revision], markDelivered: vi.fn(), markConflict: vi.fn() } as never,
        central: { recordLlmTurn: async () => ({ activated: false }), recordTurnUsageBatch },
        retryBaseMs: 10,
        random: () => 1,
        telemetry: { capture },
      })
      await expect(sync.flush({ org_id: "o", user_id: "u" })).rejects.toThrow("offline")
      await vi.advanceTimersByTimeAsync(11)
      expect(recordTurnUsageBatch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2)
      expect(recordTurnUsageBatch).toHaveBeenCalledTimes(2)
      expect(capture).toHaveBeenCalledWith("system", "usage.outbox_sync", expect.objectContaining({ errors: 1, pending: 1 }))
    } finally {
      vi.useRealTimers()
    }
  })
})
