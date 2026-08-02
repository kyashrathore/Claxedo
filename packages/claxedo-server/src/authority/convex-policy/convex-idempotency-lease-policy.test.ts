/**
 * W4.2/W4.4 — Convex-side policy for the two new durable primitives.
 *
 * Both are cross-isolate coordination tables, so the properties that matter are
 * the ones a per-isolate `Map` could never have: exclusive claims, takeover on
 * expiry, and a fence that makes a zombie holder identifiable.
 *
 * As with the reaper tests, the fake `db` resolves index names against the real
 * `convex/schema.ts` (`convex-index-harness.ts`), so a wrong index name throws
 * here instead of silently degrading into a table scan.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  begin,
  complete,
  IDEMPOTENCY_LEASE_MS,
  release,
  sweepExpired,
} from "../../../../../convex/idempotency"
import { acquire, CRON_LEASE_MS, get, heartbeat, release as releaseLease } from "../../../../../convex/cronLease"
import { indexRangeBuilder, orderByIndex, type Row } from "../../test-helpers/convex-index-harness"

const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
})

afterEach(() => {
  if (prevServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

function fakeDb(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [row._id, { ...row }]))
  let next = seed.length + 1
  return {
    rows,
    db: {
      query: vi.fn((table: string) => ({
        withIndex: vi.fn((name: string, build: (q: unknown) => unknown) => {
          const { builder, checks } = indexRangeBuilder(table, name)
          build(builder)
          const matching = () => orderByIndex(
            [...rows.values()].filter((row) => checks.every((check) => check(row))),
            table,
            name,
          )
          return {
            collect: vi.fn(async () => matching()),
            take: vi.fn(async (limit: number) => matching().slice(0, limit)),
            first: vi.fn(async () => matching()[0] ?? null),
            unique: vi.fn(async () => {
              const found = matching()
              if (found.length > 1) throw new Error("unique() matched multiple documents")
              return found[0] ?? null
            }),
          }
        }),
      })),
      insert: vi.fn(async (table: string, value: Record<string, unknown>) => {
        const id = `${table}_${next += 1}`
        rows.set(id, { _id: id, ...value } as Row)
        return id
      }),
      patch: vi.fn(async (id: string, value: Record<string, unknown>) => {
        const existing = rows.get(id)
        if (!existing) throw new Error(`patch on missing row ${id}`)
        const merged = { ...existing, ...value } as Row
        // Convex treats an explicit `undefined` as field removal.
        for (const [key, field] of Object.entries(value)) {
          if (field === undefined) delete (merged as Record<string, unknown>)[key]
        }
        rows.set(id, merged)
      }),
      delete: vi.fn(async (id: string) => {
        rows.delete(id)
      }),
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

const SVC = { service_token: "svc_secret" }

describe("W4.2 durable control-plane idempotency (convex/idempotency.ts)", () => {
  test("the first caller acquires and a concurrent second is refused", async () => {
    // The property a per-isolate Map cannot have: two isolates, one execution.
    const { db, rows } = fakeDb()
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp", now: 1_000 }

    await expect(handler(begin)({ db } as never, args)).resolves.toEqual({ state: "acquired" })
    await expect(handler(begin)({ db } as never, args)).resolves.toEqual({ state: "in_flight" })
    expect(rows.size).toBe(1)
  })

  test("an in-flight row carries an expiry so it is sweepable", async () => {
    // The latent bug this fixes: the in-memory version left in-flight entries
    // with no deadline, so a hung request's entry was neither replayable nor
    // collectable.
    const { db, rows } = fakeDb()
    await handler(begin)({ db } as never, { ...SVC, cache_key: "op_1", fingerprint: "fp", now: 1_000 })

    const row = [...rows.values()][0]!
    expect(row.state).toBe("in_flight")
    expect(row.expires_at).toBe(1_000 + IDEMPOTENCY_LEASE_MS)
    expect(row.lease_expires_at).toBe(1_000 + IDEMPOTENCY_LEASE_MS)
  })

  test("a dead holder's claim is taken over once its lease expires", async () => {
    // Without takeover, one crashed isolate would make a key permanently
    // un-runnable — worse than the duplicate it prevents.
    const { db } = fakeDb()
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp" }
    await handler(begin)({ db } as never, { ...args, now: 1_000 })

    await expect(handler(begin)({ db } as never, { ...args, now: 1_000 + IDEMPOTENCY_LEASE_MS - 1 }))
      .resolves.toEqual({ state: "in_flight" })
    await expect(handler(begin)({ db } as never, { ...args, now: 1_000 + IDEMPOTENCY_LEASE_MS + 1 }))
      .resolves.toEqual({ state: "acquired" })
  })

  test("a completed result replays without re-executing, until its TTL lapses", async () => {
    const { db } = fakeDb()
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp" }
    await handler(begin)({ db } as never, { ...args, now: 1_000 })
    await handler(complete)({ db } as never, { ...args, result_json: '{"ok":true}', now: 2_000 })

    await expect(handler(begin)({ db } as never, { ...args, now: 3_000 }))
      .resolves.toEqual({ state: "completed", result_json: '{"ok":true}' })
    // Past the result TTL the receipt is as good as absent and the operation may
    // run again — the same bound the in-memory layer has always had.
    await expect(handler(begin)({ db } as never, { ...args, now: 2_000 + 5 * 60_000 + 1 }))
      .resolves.toEqual({ state: "acquired" })
  })

  test("the same key with a different payload conflicts, even against a stale row", async () => {
    // Answering with the first payload's result would be a silent wrong answer,
    // which is worse than either re-running or refusing. Checked BEFORE expiry
    // on purpose: key reuse is a client bug regardless of staleness.
    const { db } = fakeDb()
    await handler(begin)({ db } as never, { ...SVC, cache_key: "op_1", fingerprint: "fp-a", now: 1_000 })

    await expect(handler(begin)({ db } as never, { ...SVC, cache_key: "op_1", fingerprint: "fp-b", now: 1_000 }))
      .resolves.toEqual({ state: "conflict" })
    await expect(handler(begin)({
      db,
    } as never, { ...SVC, cache_key: "op_1", fingerprint: "fp-b", now: 1_000 + IDEMPOTENCY_LEASE_MS + 1 }))
      .resolves.toEqual({ state: "conflict" })
  })

  test("release frees a failed claim but never withdraws a completed receipt", async () => {
    const { db, rows } = fakeDb()
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp" }
    await handler(begin)({ db } as never, { ...args, now: 1_000 })

    // A failure is not a result: caching it would replay one transient error for
    // the whole TTL.
    await expect(handler(release)({ db } as never, args)).resolves.toEqual({ released: true })
    expect(rows.size).toBe(0)

    await handler(begin)({ db } as never, { ...args, now: 2_000 })
    await handler(complete)({ db } as never, { ...args, result_json: '{"ok":true}', now: 2_100 })
    await expect(handler(release)({ db } as never, args)).resolves.toEqual({ released: false })
    expect(rows.size).toBe(1)
  })

  test("a late completion from a superseded holder cannot overwrite the new holder's row", async () => {
    const { db, rows } = fakeDb()
    await handler(begin)({ db } as never, { ...SVC, cache_key: "op_1", fingerprint: "fp-old", now: 1_000 })
    // Takeover by a different payload is a conflict, so the takeover case here is
    // the SAME fingerprint reclaiming after expiry; a stale `complete` from a
    // different fingerprint must not land.
    await expect(handler(complete)({
      db,
    } as never, { ...SVC, cache_key: "op_1", fingerprint: "fp-other", result_json: '{"stale":true}', now: 5_000 }))
      .resolves.toEqual({ recorded: false })
    expect([...rows.values()][0]!.state).toBe("in_flight")
  })

  test("the sweep is internal and retires expired rows in both states", async () => {
    // A public sweep would be an unauthenticated mass-delete endpoint.
    expect((sweepExpired as { isInternal?: boolean }).isInternal).toBe(true)

    const { db, rows } = fakeDb([
      { _id: "a", cache_key: "k1", fingerprint: "f", state: "in_flight", lease_expires_at: 10, expires_at: 10, created_at: 0, updated_at: 0 },
      { _id: "b", cache_key: "k2", fingerprint: "f", state: "completed", lease_expires_at: 0, expires_at: 20, created_at: 0, updated_at: 0 },
      { _id: "c", cache_key: "k3", fingerprint: "f", state: "completed", lease_expires_at: 0, expires_at: 9_000, created_at: 0, updated_at: 0 },
    ])

    await expect(handler(sweepExpired)({ db } as never, { now: 1_000 })).resolves.toEqual({ swept: 2 })
    // The live row survives: a sweep that deleted everything would pass a
    // count-only assertion.
    expect([...rows.keys()]).toEqual(["c"])
  })

  test("the sweep is bounded, so a backlog cannot exceed Convex's read cap", async () => {
    const { db, rows } = fakeDb(
      Array.from({ length: 900 }, (_, index) => ({
        _id: `row_${index}`,
        cache_key: `k${index}`,
        fingerprint: "f",
        state: "completed",
        lease_expires_at: 0,
        expires_at: 10,
        created_at: 0,
        updated_at: 0,
      })),
    )

    // Level-triggered: the remainder is retired next tick, and an expired row
    // stays expired, so nothing is skipped forever.
    await expect(handler(sweepExpired)({ db } as never, { now: 1_000, limit: 10_000 }))
      .resolves.toEqual({ swept: 500 })
    expect(rows.size).toBe(400)
  })
})

describe("W4.4 fenced cron lease (convex/cronLease.ts)", () => {
  test("a live lease is exclusive: a second holder is refused", async () => {
    const { db } = fakeDb()
    const first = await handler(acquire)({ db } as never, {
      ...SVC,
      name: "workgraph_reconcile",
      holder: "iso-a",
      now: 1_000,
    })
    expect(first).toMatchObject({ acquired: true, fence: 1, took_over: false })

    await expect(handler(acquire)({ db } as never, {
      ...SVC,
      name: "workgraph_reconcile",
      holder: "iso-b",
      now: 1_000,
    })).resolves.toMatchObject({ acquired: false })
  })

  test("an expired lease is taken over and the fence advances", async () => {
    // TTL + takeover is mandatory: the motivating incident is a HANG, so a lease
    // that could not expire would turn one stalled isolate into a reconciler that
    // never runs again.
    const { db } = fakeDb()
    await handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 })

    await expect(handler(acquire)({
      db,
    } as never, { ...SVC, name: "lane", holder: "iso-b", now: 1_000 + CRON_LEASE_MS + 1 }))
      .resolves.toMatchObject({ acquired: true, fence: 2, took_over: true })
  })

  test("a superseded holder cannot heartbeat or release the new holder's lease", async () => {
    // This is what makes it a FENCED lease rather than a mutual-exclusion flag:
    // the zombie is identifiable, so its late calls are no-ops.
    const { db } = fakeDb()
    const first = await handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 }) as {
      fence: number
    }
    const takeover = 1_000 + CRON_LEASE_MS + 1
    await handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-b", now: takeover })

    await expect(handler(heartbeat)({
      db,
    } as never, { ...SVC, name: "lane", holder: "iso-a", fence: first.fence, now: takeover + 1 }))
      .resolves.toEqual({ held: false })
    await expect(handler(releaseLease)({
      db,
    } as never, { ...SVC, name: "lane", holder: "iso-a", fence: first.fence, now: takeover + 1 }))
      .resolves.toEqual({ released: false })

    // The live holder still holds it.
    await expect(handler(get)({ db } as never, { ...SVC, name: "lane" }))
      .resolves.toMatchObject({ found: true, holder: "iso-b", fence: 2 })
  })

  test("a same-holder re-acquire renews rather than deadlocking, and still advances the fence", async () => {
    // A re-entrant tick must not lock itself out. The fence still moves: a holder
    // that reacquired after its own lease lapsed is indistinguishable from a new
    // one and must not pass a stale fence off as current.
    const { db } = fakeDb()
    await handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 })
    await expect(handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-a", now: 2_000 }))
      .resolves.toMatchObject({ acquired: true, fence: 2, took_over: false })
  })

  test("heartbeat extends a live claim so a long run is not stolen mid-flight", async () => {
    const { db } = fakeDb()
    const claim = await handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 }) as {
      fence: number
    }

    const beat = 1_000 + CRON_LEASE_MS - 1_000
    await expect(handler(heartbeat)({
      db,
    } as never, { ...SVC, name: "lane", holder: "iso-a", fence: claim.fence, now: beat }))
      .resolves.toMatchObject({ held: true, lease_expires_at: beat + CRON_LEASE_MS })

    // Past the ORIGINAL deadline, the heartbeat means nobody may steal it.
    await expect(handler(acquire)({
      db,
    } as never, { ...SVC, name: "lane", holder: "iso-b", now: 1_000 + CRON_LEASE_MS + 1 }))
      .resolves.toMatchObject({ acquired: false })
  })

  test("release lets the next tick start immediately instead of waiting out the TTL", async () => {
    const { db } = fakeDb()
    const claim = await handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 }) as {
      fence: number
    }
    await handler(releaseLease)({ db } as never, { ...SVC, name: "lane", holder: "iso-a", fence: claim.fence, now: 2_000 })

    await expect(handler(acquire)({ db } as never, { ...SVC, name: "lane", holder: "iso-b", now: 2_001 }))
      .resolves.toMatchObject({ acquired: true, fence: 2 })
  })
})
