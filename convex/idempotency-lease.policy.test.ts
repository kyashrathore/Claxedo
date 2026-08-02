/**
 * W4.2/W4.4 — Convex-side policy for the two durable cross-isolate primitives.
 *
 * Both are cross-isolate coordination tables, so the properties that matter
 * are the ones a per-isolate `Map` could never have: exclusive claims,
 * takeover on expiry, and a fence that makes a zombie holder identifiable.
 *
 * Runs against the real function pipeline via `convex-test`, including the
 * `serviceMutation`/`serviceQuery`/`cronMutation` wrappers from `model.ts` —
 * `begin`/`complete`/`release`/`acquire`/`heartbeat`/`get` all require a
 * `service_token` arg matched against `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN`,
 * and `sweepExpired` is internal (callable only from inside the deployment).
 * The previous version of this suite lived in claxedo-server, imported both
 * modules across five directory levels, reached past the builders into
 * `_handler`, and drove a hand-written `db` double resolving index names
 * against a harness — so it exercised the handler bodies while skipping both
 * the service-token gate and the real Convex indexes.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { IDEMPOTENCY_LEASE_MS, sweepExpired } from "./idempotency"
import { CRON_LEASE_MS } from "./cronLease"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

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

const SVC = { service_token: "svc_secret" }

describe("W4.2 durable control-plane idempotency (convex/idempotency.ts)", () => {
  test("the first caller acquires and a concurrent second is refused", async () => {
    // The property a per-isolate Map cannot have: two isolates, one execution.
    const t = convexTest(schema, modules)
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp", now: 1_000 }

    await expect(t.mutation(api.idempotency.begin, args as never)).resolves.toEqual({ state: "acquired" })
    await expect(t.mutation(api.idempotency.begin, args as never)).resolves.toEqual({ state: "in_flight" })
    await expect(t.run(async (ctx) => ctx.db.query("control_idempotency").collect())).resolves.toHaveLength(1)
  })

  test("an in-flight row carries an expiry so it is sweepable", async () => {
    // The latent bug this fixes: the in-memory version left in-flight entries
    // with no deadline, so a hung request's entry was neither replayable nor
    // collectable.
    const t = convexTest(schema, modules)
    await t.mutation(api.idempotency.begin, { ...SVC, cache_key: "op_1", fingerprint: "fp", now: 1_000 } as never)

    const row = (await t.run(async (ctx) => ctx.db.query("control_idempotency").collect()))[0]!
    expect(row.state).toBe("in_flight")
    expect(row.expires_at).toBe(1_000 + IDEMPOTENCY_LEASE_MS)
    expect(row.lease_expires_at).toBe(1_000 + IDEMPOTENCY_LEASE_MS)
  })

  test("a dead holder's claim is taken over once its lease expires", async () => {
    // Without takeover, one crashed isolate would make a key permanently
    // un-runnable — worse than the duplicate it prevents.
    const t = convexTest(schema, modules)
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp" }
    await t.mutation(api.idempotency.begin, { ...args, now: 1_000 } as never)

    await expect(t.mutation(api.idempotency.begin, { ...args, now: 1_000 + IDEMPOTENCY_LEASE_MS - 1 } as never))
      .resolves.toEqual({ state: "in_flight" })
    await expect(t.mutation(api.idempotency.begin, { ...args, now: 1_000 + IDEMPOTENCY_LEASE_MS + 1 } as never))
      .resolves.toEqual({ state: "acquired" })
  })

  test("a completed result replays without re-executing, until its TTL lapses", async () => {
    const t = convexTest(schema, modules)
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp" }
    await t.mutation(api.idempotency.begin, { ...args, now: 1_000 } as never)
    await t.mutation(api.idempotency.complete, { ...args, result_json: '{"ok":true}', now: 2_000 } as never)

    await expect(t.mutation(api.idempotency.begin, { ...args, now: 3_000 } as never))
      .resolves.toEqual({ state: "completed", result_json: '{"ok":true}' })
    // Past the result TTL the receipt is as good as absent and the operation
    // may run again — the same bound the in-memory layer has always had.
    await expect(t.mutation(api.idempotency.begin, { ...args, now: 2_000 + 5 * 60_000 + 1 } as never))
      .resolves.toEqual({ state: "acquired" })
  })

  test("the same key with a different payload conflicts, even against a stale row", async () => {
    // Answering with the first payload's result would be a silent wrong
    // answer, which is worse than either re-running or refusing. Checked
    // BEFORE expiry on purpose: key reuse is a client bug regardless of
    // staleness.
    const t = convexTest(schema, modules)
    await t.mutation(api.idempotency.begin, { ...SVC, cache_key: "op_1", fingerprint: "fp-a", now: 1_000 } as never)

    await expect(t.mutation(api.idempotency.begin, { ...SVC, cache_key: "op_1", fingerprint: "fp-b", now: 1_000 } as never))
      .resolves.toEqual({ state: "conflict" })
    await expect(t.mutation(api.idempotency.begin, {
      ...SVC,
      cache_key: "op_1",
      fingerprint: "fp-b",
      now: 1_000 + IDEMPOTENCY_LEASE_MS + 1,
    } as never)).resolves.toEqual({ state: "conflict" })
  })

  test("release frees a failed claim but never withdraws a completed receipt", async () => {
    const t = convexTest(schema, modules)
    const args = { ...SVC, cache_key: "op_1", fingerprint: "fp" }
    await t.mutation(api.idempotency.begin, { ...args, now: 1_000 } as never)

    // A failure is not a result: caching it would replay one transient error
    // for the whole TTL.
    await expect(t.mutation(api.idempotency.release, args as never)).resolves.toEqual({ released: true })
    await expect(t.run(async (ctx) => ctx.db.query("control_idempotency").collect())).resolves.toHaveLength(0)

    await t.mutation(api.idempotency.begin, { ...args, now: 2_000 } as never)
    await t.mutation(api.idempotency.complete, { ...args, result_json: '{"ok":true}', now: 2_100 } as never)
    await expect(t.mutation(api.idempotency.release, args as never)).resolves.toEqual({ released: false })
    await expect(t.run(async (ctx) => ctx.db.query("control_idempotency").collect())).resolves.toHaveLength(1)
  })

  test("a late completion from a superseded holder cannot overwrite the new holder's row", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.idempotency.begin, { ...SVC, cache_key: "op_1", fingerprint: "fp-old", now: 1_000 } as never)
    // Takeover by a different payload is a conflict, so the takeover case here
    // is the SAME fingerprint reclaiming after expiry; a stale `complete` from
    // a different fingerprint must not land.
    await expect(t.mutation(api.idempotency.complete, {
      ...SVC,
      cache_key: "op_1",
      fingerprint: "fp-other",
      result_json: '{"stale":true}',
      now: 5_000,
    } as never)).resolves.toEqual({ recorded: false })
    await expect(t.run(async (ctx) => ctx.db.query("control_idempotency").collect()))
      .resolves.toMatchObject([{ state: "in_flight" }])
  })

  test("the sweep is internal and retires expired rows in both states", async () => {
    // A public sweep would be an unauthenticated mass-delete endpoint.
    expect((sweepExpired as { isInternal?: boolean }).isInternal).toBe(true)

    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert("control_idempotency", stamped({
        cache_key: "k1", fingerprint: "f", state: "in_flight", lease_expires_at: 10, expires_at: 10,
      }) as never)
      await ctx.db.insert("control_idempotency", stamped({
        cache_key: "k2", fingerprint: "f", state: "completed", lease_expires_at: 0, expires_at: 20,
      }) as never)
      await ctx.db.insert("control_idempotency", stamped({
        cache_key: "k3", fingerprint: "f", state: "completed", lease_expires_at: 0, expires_at: 9_000,
      }) as never)
    })

    await expect(t.mutation(internal.idempotency.sweepExpired, { now: 1_000 } as never)).resolves.toEqual({ swept: 2 })
    // The live row survives: a sweep that deleted everything would pass a
    // count-only assertion.
    await expect(t.run(async (ctx) => ctx.db.query("control_idempotency").collect()))
      .resolves.toMatchObject([{ cache_key: "k3" }])
  })

  test("the sweep is bounded, so a backlog cannot exceed Convex's read cap", async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      for (let index = 0; index < 900; index += 1) {
        await ctx.db.insert("control_idempotency", stamped({
          cache_key: `k${index}`, fingerprint: "f", state: "completed", lease_expires_at: 0, expires_at: 10,
        }) as never)
      }
    })

    // Level-triggered: the remainder is retired next tick, and an expired row
    // stays expired, so nothing is skipped forever.
    await expect(t.mutation(internal.idempotency.sweepExpired, { now: 1_000, limit: 10_000 } as never))
      .resolves.toEqual({ swept: 500 })
    await expect(t.run(async (ctx) => ctx.db.query("control_idempotency").collect())).resolves.toHaveLength(400)
  })
})

describe("W4.4 fenced cron lease (convex/cronLease.ts)", () => {
  test("a live lease is exclusive: a second holder is refused", async () => {
    const t = convexTest(schema, modules)
    const first = await t.mutation(api.cronLease.acquire, {
      ...SVC,
      name: "workgraph_reconcile",
      holder: "iso-a",
      now: 1_000,
    } as never)
    expect(first).toMatchObject({ acquired: true, fence: 1, took_over: false })

    await expect(t.mutation(api.cronLease.acquire, {
      ...SVC,
      name: "workgraph_reconcile",
      holder: "iso-b",
      now: 1_000,
    } as never)).resolves.toMatchObject({ acquired: false })
  })

  test("an expired lease is taken over and the fence advances", async () => {
    // TTL + takeover is mandatory: the motivating incident is a HANG, so a
    // lease that could not expire would turn one stalled isolate into a
    // reconciler that never runs again.
    const t = convexTest(schema, modules)
    await t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 } as never)

    await expect(t.mutation(api.cronLease.acquire, {
      ...SVC,
      name: "lane",
      holder: "iso-b",
      now: 1_000 + CRON_LEASE_MS + 1,
    } as never)).resolves.toMatchObject({ acquired: true, fence: 2, took_over: true })
  })

  test("a superseded holder cannot heartbeat or release the new holder's lease", async () => {
    // This is what makes it a FENCED lease rather than a mutual-exclusion
    // flag: the zombie is identifiable, so its late calls are no-ops.
    const t = convexTest(schema, modules)
    const first = await t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 } as never) as {
      fence: number
    }
    const takeover = 1_000 + CRON_LEASE_MS + 1
    await t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-b", now: takeover } as never)

    await expect(t.mutation(api.cronLease.heartbeat, {
      ...SVC,
      name: "lane",
      holder: "iso-a",
      fence: first.fence,
      now: takeover + 1,
    } as never)).resolves.toEqual({ held: false })
    await expect(t.mutation(api.cronLease.release, {
      ...SVC,
      name: "lane",
      holder: "iso-a",
      fence: first.fence,
      now: takeover + 1,
    } as never)).resolves.toEqual({ released: false })

    // The live holder still holds it.
    await expect(t.query(api.cronLease.get, { ...SVC, name: "lane" } as never))
      .resolves.toMatchObject({ found: true, holder: "iso-b", fence: 2 })
  })

  test("a same-holder re-acquire renews rather than deadlocking, and still advances the fence", async () => {
    // A re-entrant tick must not lock itself out. The fence still moves: a
    // holder that reacquired after its own lease lapsed is indistinguishable
    // from a new one and must not pass a stale fence off as current.
    const t = convexTest(schema, modules)
    await t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 } as never)
    await expect(t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-a", now: 2_000 } as never))
      .resolves.toMatchObject({ acquired: true, fence: 2, took_over: false })
  })

  test("heartbeat extends a live claim so a long run is not stolen mid-flight", async () => {
    const t = convexTest(schema, modules)
    const claim = await t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 } as never) as {
      fence: number
    }

    const beat = 1_000 + CRON_LEASE_MS - 1_000
    await expect(t.mutation(api.cronLease.heartbeat, {
      ...SVC,
      name: "lane",
      holder: "iso-a",
      fence: claim.fence,
      now: beat,
    } as never)).resolves.toMatchObject({ held: true, lease_expires_at: beat + CRON_LEASE_MS })

    // Past the ORIGINAL deadline, the heartbeat means nobody may steal it.
    await expect(t.mutation(api.cronLease.acquire, {
      ...SVC,
      name: "lane",
      holder: "iso-b",
      now: 1_000 + CRON_LEASE_MS + 1,
    } as never)).resolves.toMatchObject({ acquired: false })
  })

  test("release lets the next tick start immediately instead of waiting out the TTL", async () => {
    const t = convexTest(schema, modules)
    const claim = await t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-a", now: 1_000 } as never) as {
      fence: number
    }
    await t.mutation(api.cronLease.release, { ...SVC, name: "lane", holder: "iso-a", fence: claim.fence, now: 2_000 } as never)

    await expect(t.mutation(api.cronLease.acquire, { ...SVC, name: "lane", holder: "iso-b", now: 2_001 } as never))
      .resolves.toMatchObject({ acquired: true, fence: 2 })
  })
})
