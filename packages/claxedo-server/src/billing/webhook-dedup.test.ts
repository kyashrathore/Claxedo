/**
 * The Polar webhook is deduplicated on `webhook-id`.
 *
 * ## What was missing
 *
 * `webhook-id` was read only as signature input (`standard-webhooks.ts`), never
 * as a delivery identity. Polar retries a delivery up to 10 times, so a
 * redelivery re-ran `applyPolarState`. The existing protection is the single
 * writer's `source_ts` guard (`the billing authority`), which is a per-org
 * monotonic timestamp check — it no-ops a re-apply at an already-seen ts, but it
 * is an ORDERING invariant, not a delivery-identity one, and it cannot tell a
 * redelivery from a legitimately-concurrent event.
 *
 * Both layers stay. This test covers the delivery-identity half.
 *
 * ## Two isolates
 *
 * Two `BillingRoutes(...)` instances sharing ONE fake store — the same
 * construction as `rate-limit.shared-store.test.ts` and
 * `http-idempotency.durable.test.ts`. Each test carries its positive
 * control: the same redelivery with NO store, asserted to apply twice.
 */

import { describe, expect, test, vi } from "vitest"
import { BillingRoutes, type PolarClientLike } from "./routes"
import type { BillingStore } from "./store-contract"
import type { DurableIdempotencyStore } from "../authority/http/idempotency"
import { signStandardWebhook } from "./standard-webhooks"

const SECRET = "polar-test-secret"
const ENV = {
  CLAXEDO_POLAR_WEBHOOK_SECRET: SECRET,
  CLAXEDO_POLAR_ACCESS_TOKEN: "polar_at_test",
  CLAXEDO_POLAR_PRODUCT_MONTHLY: "prod_monthly",
}

function fakeStore(): BillingStore & { applyPolarState: ReturnType<typeof vi.fn> } {
  return {
    entitlementState: vi.fn(async () => ({ found: false as const })),
    applyPolarState: vi.fn(async () => ({ results: [{ org_id: "org_doc_1", applied: true }], unresolved: [] })),
    checkoutContext: vi.fn(async () => ({ org_id: "org_doc_1", member_count: 1 })),
    listReconcileFlagged: vi.fn(async () => []),
    listDeletedWithSubscription: vi.fn(async () => []),
  } as never
}

/** Shared across "isolates", exactly as one authority deployment is. */
function fakeIdempotencyStore(clock = { now: 1_000 }) {
  const rows = new Map<string, {
    fingerprint: string
    state: "in_flight" | "completed"
    leaseExpiresAt: number
    resultJson?: string
  }>()
  const store: DurableIdempotencyStore & { rows: typeof rows; clock: typeof clock } = {
    rows,
    clock,
    async begin({ cacheKey, fingerprint }) {
      const existing = rows.get(cacheKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { state: "conflict" }
        if (existing.state === "completed") {
          return {
            state: "completed",
            ...(existing.resultJson === undefined ? {} : { resultJson: existing.resultJson }),
          }
        }
        if (existing.leaseExpiresAt > clock.now) return { state: "in_flight" }
      }
      rows.set(cacheKey, { fingerprint, state: "in_flight", leaseExpiresAt: clock.now + 60_000 })
      return { state: "acquired" }
    },
    async complete({ cacheKey, fingerprint, resultJson }) {
      const existing = rows.get(cacheKey)
      if (!existing || existing.fingerprint !== fingerprint) return
      rows.set(cacheKey, {
        ...existing,
        state: "completed",
        ...(resultJson === undefined ? {} : { resultJson }),
        leaseExpiresAt: 0,
      })
    },
    async release({ cacheKey, fingerprint }) {
      const existing = rows.get(cacheKey)
      if (!existing || existing.fingerprint !== fingerprint || existing.state === "completed") return
      rows.delete(cacheKey)
    },
  }
  return store
}

const eventPayload = (customerId = "cus_1") =>
  JSON.stringify({
    type: "customer.state_changed",
    data: { id: customerId, modified_at: "2026-07-12T10:00:00.000Z", active_subscriptions: [] },
  })

/** A correctly signed delivery. `id` is the `webhook-id` the dedup keys on. */
async function delivery(input: { id: string; payload: string }) {
  const timestampSeconds = Math.floor(Date.now() / 1000)
  const signature = await signStandardWebhook({
    payload: input.payload,
    id: input.id,
    timestampSeconds,
    secret: SECRET,
  })
  return new Request("http://cp.test/polar/webhook", {
    method: "POST",
    body: input.payload,
    headers: {
      "webhook-id": input.id,
      "webhook-timestamp": String(timestampSeconds),
      "webhook-signature": signature,
    },
  })
}

function isolate(input: { store: BillingStore; idempotencyStore?: DurableIdempotencyStore }) {
  return BillingRoutes({
    env: ENV,
    store: input.store,
    polar: {} as unknown as PolarClientLike,
    ...(input.idempotencyStore ? { idempotencyStore: input.idempotencyStore } : {}),
  })
}

describe("Polar webhook dedup on webhook-id", () => {
  test("a redelivery of the same webhook-id applies ONCE across two isolates", async () => {
    const billing = fakeStore()
    const idempotency = fakeIdempotencyStore()
    const payload = eventPayload()

    const first = await isolate({ store: billing, idempotencyStore: idempotency })
      .fetch(await delivery({ id: "msg_dedup_1", payload }))
    const second = await isolate({ store: billing, idempotencyStore: idempotency })
      .fetch(await delivery({ id: "msg_dedup_1", payload }))

    expect(first.status).toBe(200)
    // The redelivery is ACKED (2xx), not refused: Polar must stop retrying, and
    // it gets the same body the first delivery produced.
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(await first.clone().json())
    expect(billing.applyPolarState).toHaveBeenCalledTimes(1)

    // POSITIVE CONTROL: identical redelivery with no dedup store — the pre-fix
    // behavior, and proof the two isolates are really separate.
    const leaky = fakeStore()
    await isolate({ store: leaky }).fetch(await delivery({ id: "msg_dedup_1", payload }))
    await isolate({ store: leaky }).fetch(await delivery({ id: "msg_dedup_1", payload }))
    expect(leaky.applyPolarState).toHaveBeenCalledTimes(2)
  })

  test("distinct webhook-ids both apply — dedup does not swallow real events", async () => {
    // Strangler check. A dedup that also drops legitimate deliveries would be a
    // regression dressed as a fix, and billing events are not recoverable.
    const billing = fakeStore()
    const idempotency = fakeIdempotencyStore()
    const routes = isolate({ store: billing, idempotencyStore: idempotency })

    await routes.fetch(await delivery({ id: "msg_a", payload: eventPayload("cus_a") }))
    await routes.fetch(await delivery({ id: "msg_b", payload: eventPayload("cus_b") }))

    expect(billing.applyPolarState).toHaveBeenCalledTimes(2)
  })

  test("a failed apply releases the claim so Polar's retry can succeed", async () => {
    // the authority was down, so nothing was mirrored. Deduping the retry against a
    // delivery that never applied would lose the billing event permanently.
    const billing = fakeStore()
    billing.applyPolarState
      .mockRejectedValueOnce(new Error("authority unreachable"))
      .mockResolvedValueOnce({ results: [{ org_id: "org_doc_1", applied: true }], unresolved: [] })
    const idempotency = fakeIdempotencyStore()
    const payload = eventPayload()

    // 500 makes Polar retry — the delivery was good, we were not.
    const failed = await isolate({ store: billing, idempotencyStore: idempotency })
      .fetch(await delivery({ id: "msg_retry", payload }))
    expect(failed.status).toBe(500)
    expect(idempotency.rows.size).toBe(0)

    const retried = await isolate({ store: billing, idempotencyStore: idempotency })
      .fetch(await delivery({ id: "msg_retry", payload }))
    expect(retried.status).toBe(200)
    expect(billing.applyPolarState).toHaveBeenCalledTimes(2)
  })

  test("a concurrent duplicate delivery gets a retryable 500, not a double apply", async () => {
    const billing = fakeStore()
    const gate = Promise.withResolvers<void>()
    billing.applyPolarState.mockImplementation(async () => {
      await gate.promise
      return { results: [{ org_id: "org_doc_1", applied: true }], unresolved: [] }
    })
    const idempotency = fakeIdempotencyStore()
    const payload = eventPayload()

    const inFlight = isolate({ store: billing, idempotencyStore: idempotency })
      .fetch(await delivery({ id: "msg_concurrent", payload }))
    await vi.waitFor(() => expect(billing.applyPolarState).toHaveBeenCalledTimes(1))

    // 500 rather than a 2xx ack: the in-flight attempt may still fail, and
    // acking here would consume the only delivery that could have applied it.
    const concurrent = await isolate({ store: billing, idempotencyStore: idempotency })
      .fetch(await delivery({ id: "msg_concurrent", payload }))
    expect(concurrent.status).toBe(500)
    expect(billing.applyPolarState).toHaveBeenCalledTimes(1)

    gate.resolve()
    expect((await inFlight).status).toBe(200)
  })

  test("the dedup key is authenticated: a delivery with no webhook-id never reaches apply", async () => {
    // Why the dedup can trust `webhook-id`: it is signed over
    // (`id.timestamp.payload`), so a caller cannot forge or omit it to dodge
    // dedup. A missing header fails signature verification with a 401 and never
    // reaches the apply — which is also why there is no undeduped fallback path
    // for it in the route.
    const billing = fakeStore()
    const idempotency = fakeIdempotencyStore()
    const payload = eventPayload()
    const timestampSeconds = Math.floor(Date.now() / 1000)
    const signature = await signStandardWebhook({ payload, id: "msg_signed", timestampSeconds, secret: SECRET })

    const response = await isolate({ store: billing, idempotencyStore: idempotency }).fetch(
      new Request("http://cp.test/polar/webhook", {
        method: "POST",
        body: payload,
        headers: { "webhook-timestamp": String(timestampSeconds), "webhook-signature": signature },
      }),
    )

    expect(response.status).toBe(401)
    expect(billing.applyPolarState).not.toHaveBeenCalled()
    expect(idempotency.rows.size).toBe(0)
  })

  test("a forged webhook-id cannot bypass dedup", async () => {
    // The dedup key is only as good as its binding to the payload. Replaying a
    // valid body under a DIFFERENT id would otherwise defeat dedup entirely, so
    // the signature (computed over the id) is what makes the key trustworthy.
    const billing = fakeStore()
    const idempotency = fakeIdempotencyStore()
    const payload = eventPayload()
    const timestampSeconds = Math.floor(Date.now() / 1000)
    const signature = await signStandardWebhook({ payload, id: "msg_real", timestampSeconds, secret: SECRET })

    const routes = isolate({ store: billing, idempotencyStore: idempotency })
    expect((await routes.fetch(await delivery({ id: "msg_real", payload }))).status).toBe(200)

    const forged = await routes.fetch(
      new Request("http://cp.test/polar/webhook", {
        method: "POST",
        body: payload,
        headers: {
          // Same signed bytes, a new id — the signature no longer matches.
          "webhook-id": "msg_forged",
          "webhook-timestamp": String(timestampSeconds),
          "webhook-signature": signature,
        },
      }),
    )

    expect(forged.status).toBe(401)
    expect(billing.applyPolarState).toHaveBeenCalledTimes(1)
  })
})
