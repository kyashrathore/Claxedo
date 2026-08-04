/**
 * Policy for the durable OAuth/device connect attempt store
 * (convex/connectionAttempts.ts).
 *
 * The properties that matter here are the ones a per-isolate `Map` could never
 * have, plus the ones the kit's in-memory store already guarantees and this
 * store MUST answer identically — `packages/claxedo-connections/src/attempts.ts`
 * and this module are two implementations of one port, and a divergence between
 * them is invisible until a hosted user hits it.
 *
 * Runs against the real function pipeline via `convex-test`, including the
 * `serviceMutation`/`serviceQuery`/`cronMutation` wrappers from `model.ts`: the
 * read/write functions all require a `service_token` matched against
 * `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN`, and `sweepExpired` is internal.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { ATTEMPT_RETENTION_MS, ATTEMPT_TTL_MS } from "./connectionAttempts"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

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

const redirectAttempt = {
  ...SVC,
  state: "state_1",
  verifier: "verifier_1",
  integration_id: "github",
  scope: "team" as const,
}

const deviceAttempt = { ...redirectAttempt, device_code: "device_1" }

describe("durable connect attempts (convex/connectionAttempts.ts)", () => {
  test("an attempt created by one caller is readable by the next — the cross-isolate property", async () => {
    // THE bug: the hosted control plane builds a fresh connections service per
    // request, so the in-memory Map that `POST /:id/connect` wrote into was
    // already gone when `GET /attempts/:state` ran, and every hosted connect
    // 404'd as `attempt_not_found`. Two independent calls here stand in for the
    // two requests.
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)

    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: 1_100 } as never))
      .resolves.toEqual({ status: "pending", integrationId: "github", scope: "team" })
  })

  test("an unknown state reads as absent rather than as a pending attempt", async () => {
    const t = convexTest(schema, modules)
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "nope", now: 1_000 } as never))
      .resolves.toBeNull()
    await expect(t.mutation(api.connectionAttempts.consume, { ...SVC, state: "nope", now: 1_000 } as never))
      .resolves.toBeNull()
    await expect(t.mutation(api.connectionAttempts.peek, { ...SVC, state: "nope", now: 1_000 } as never))
      .resolves.toBeNull()
  })

  test("consume is single-use and returns the verifier the attempt was created with", async () => {
    // `toBeDefined()` alone would pass on a consume that returned the WRONG
    // attempt's PKCE material, which is what the caller sends to the provider.
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)

    await expect(t.mutation(api.connectionAttempts.consume, { ...SVC, state: "state_1", now: 1_100 } as never))
      .resolves.toEqual({ integrationId: "github", scope: "team", verifier: "verifier_1" })
    // The fence: a second caller racing the same callback gets nothing.
    await expect(t.mutation(api.connectionAttempts.consume, { ...SVC, state: "state_1", now: 1_100 } as never))
      .resolves.toBeNull()
  })

  test("a duplicate state is refused rather than shadowing the first attempt", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)

    await expect(t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_100 } as never))
      .rejects.toThrow("already recorded")
    await expect(t.run(async (ctx) => ctx.db.query("connection_attempts").collect())).resolves.toHaveLength(1)
  })

  test("peek is non-consuming, so a device grant can poll the same attempt repeatedly", async () => {
    // `consume` cannot serve the device flow: it is single-use by design, so
    // the second poll would report a lost attempt.
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...deviceAttempt, now: 1_000 } as never)

    const expected = { integrationId: "github", scope: "team", deviceCode: "device_1" }
    await expect(t.mutation(api.connectionAttempts.peek, { ...SVC, state: "state_1", now: 1_100 } as never))
      .resolves.toEqual(expected)
    await expect(t.mutation(api.connectionAttempts.peek, { ...SVC, state: "state_1", now: 1_200 } as never))
      .resolves.toEqual(expected)
  })

  test("peek ignores a redirect attempt, which has no device code to poll with", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)

    await expect(t.mutation(api.connectionAttempts.peek, { ...SVC, state: "state_1", now: 1_100 } as never))
      .resolves.toBeNull()
  })

  test("a pending attempt past its TTL cannot be consumed and reads as expired", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)
    const past = 1_000 + ATTEMPT_TTL_MS + 1

    await expect(t.mutation(api.connectionAttempts.consume, { ...SVC, state: "state_1", now: past } as never))
      .resolves.toBeNull()
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: past } as never))
      .resolves.toEqual({ status: "expired", integrationId: "github", scope: "team" })
  })

  test("an expired peek RECORDS the expiry so the client stops polling a dead attempt", async () => {
    // A read-only peek would leave the row pending forever and the client would
    // poll to its own cap for an attempt that can never complete.
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...deviceAttempt, now: 1_000 } as never)
    const past = 1_000 + ATTEMPT_TTL_MS + 1

    await expect(t.mutation(api.connectionAttempts.peek, { ...SVC, state: "state_1", now: past } as never))
      .resolves.toBeNull()
    const row = (await t.run(async (ctx) => ctx.db.query("connection_attempts").collect()))[0]!
    expect(row.status).toBe("expired")
    expect(row.expires_at).toBe(past + ATTEMPT_RETENTION_MS)
  })

  test("settle records the outcome and refuses to re-settle a terminal attempt", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)
    await t.mutation(api.connectionAttempts.consume, { ...SVC, state: "state_1", now: 1_100 } as never)

    await expect(t.mutation(api.connectionAttempts.settle, { ...SVC, state: "state_1", ok: true, now: 1_200 } as never))
      .resolves.toEqual({ settled: true })
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: 1_300 } as never))
      .resolves.toEqual({ status: "complete", integrationId: "github", scope: "team" })

    // A late loser of the settle race must not rewrite a recorded outcome.
    await expect(t.mutation(api.connectionAttempts.settle, { ...SVC, state: "state_1", ok: false, now: 1_400 } as never))
      .resolves.toEqual({ settled: false })
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: 1_500 } as never))
      .resolves.toMatchObject({ status: "complete" })
  })

  test("a failure carries its message; expiry is reported as expired, not as a refusal", async () => {
    // Only "expired" is worth restarting, and the two carry different copy —
    // collapsing them would tell a user who merely took too long that
    // authorization was refused.
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)
    await t.mutation(api.connectionAttempts.settle, {
      ...SVC,
      state: "state_1",
      ok: false,
      message: "device_denied",
      now: 1_100,
    } as never)
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: 1_200 } as never))
      .resolves.toEqual({ status: "failed", integrationId: "github", scope: "team", message: "device_denied" })

    const other = convexTest(schema, modules)
    await other.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)
    await expect(other.mutation(api.connectionAttempts.expire, { ...SVC, state: "state_1", now: 1_100 } as never))
      .resolves.toEqual({ expired: true })
    await expect(other.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: 1_200 } as never))
      .resolves.toEqual({ status: "expired", integrationId: "github", scope: "team" })
  })

  test("the personal scope's owner round-trips; a team attempt carries none", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, {
      ...redirectAttempt,
      scope: "personal",
      owner: "user_7",
      now: 1_000,
    } as never)

    await expect(t.mutation(api.connectionAttempts.consume, { ...SVC, state: "state_1", now: 1_100 } as never))
      .resolves.toEqual({ integrationId: "github", scope: "personal", owner: "user_7", verifier: "verifier_1" })
  })

  test("sweep expires stale pending rows, then collects terminal rows past retention", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)
    const past = 1_000 + ATTEMPT_TTL_MS + 1

    // First tick: pending -> expired, and the row SURVIVES so a last poll can
    // still learn why the attempt ended.
    await expect(t.mutation(internal.connectionAttempts.sweepExpired, { now: past } as never))
      .resolves.toEqual({ expired: 1, deleted: 0 })
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: past } as never))
      .resolves.toMatchObject({ status: "expired" })

    // Second tick, past retention: collected.
    await expect(t.mutation(internal.connectionAttempts.sweepExpired, {
      now: past + ATTEMPT_RETENTION_MS + 1,
    } as never)).resolves.toEqual({ expired: 0, deleted: 1 })
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: past } as never))
      .resolves.toBeNull()
  })

  test("sweep leaves a mid-consume attempt pending so a slow token exchange still settles", async () => {
    // Ported deliberately from the in-memory store's own test: only `settle`
    // may move a row that a holder has claimed, or a slow provider exchange
    // would report a spurious "expired" instead of its real outcome.
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)
    await t.mutation(api.connectionAttempts.consume, { ...SVC, state: "state_1", now: 1_100 } as never)
    const past = 1_000 + ATTEMPT_TTL_MS + 1

    await expect(t.mutation(internal.connectionAttempts.sweepExpired, { now: past } as never))
      .resolves.toEqual({ expired: 0, deleted: 0 })
    await expect(t.mutation(api.connectionAttempts.settle, { ...SVC, state: "state_1", ok: true, now: past } as never))
      .resolves.toEqual({ settled: true })
    await expect(t.query(api.connectionAttempts.status, { ...SVC, state: "state_1", now: past } as never))
      .resolves.toMatchObject({ status: "complete" })
  })

  test("every read and write requires the control-plane service token", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.connectionAttempts.create, { ...redirectAttempt, now: 1_000 } as never)

    await expect(t.query(api.connectionAttempts.status, { service_token: "wrong", state: "state_1", now: 1_000 } as never))
      .rejects.toThrow()
    await expect(t.mutation(api.connectionAttempts.consume, { service_token: "wrong", state: "state_1", now: 1_000 } as never))
      .rejects.toThrow()
  })
})
