/**
 * The Polar webhook's body cap and IP-keyed rate limit.
 *
 * This was the sharpest gap in the whole finding. `POST /api/billing/polar/webhook`
 * is unauthenticated by construction (Polar proves itself with a
 * Standard-Webhooks signature, not a bearer token), and the limiter built in
 * `BillingRoutes` keys on `auth.user.subject`, so it reached /checkout and
 * /portal only. The route was therefore both unauthenticated AND unlimited, and
 * `await c.req.text()` buffered the entire body into the isolate BEFORE the
 * signature was verified — an anonymous caller chose how much memory the Worker
 * allocated, and paid nothing for it.
 *
 * Two ordering properties matter as much as the caps themselves, so both are
 * asserted rather than assumed:
 *   - The limiter runs before the body read and the signature HMAC.
 *   - The cap holds on the ACTUAL bytes read, not just a `content-length` claim,
 *     because omitting or lying about that header is free.
 */

import { describe, expect, test, vi } from "vitest"
import {
  BillingRoutes,
  POLAR_WEBHOOK_MAX_BODY_BYTES,
  readCappedBody,
  type PolarClientLike,
} from "./routes"
import type { BillingStore } from "./store-contract"
import { signStandardWebhook } from "./standard-webhooks"
import { createFixedWindowConnectionRateLimiter } from "../platform/auth/rate-limit"

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
    checkoutContext: vi.fn(async () => ({
      org_id: "org_doc_1",
      provider_org_id: "org_a",
      role: "owner",
      member_count: 1,
      plan: undefined,
    })),
    listReconcileFlagged: vi.fn(async () => []),
  } as never
}

function app(
  options: { webhookMaxBodyBytes?: number; webhookRateLimiter?: ReturnType<typeof createFixedWindowConnectionRateLimiter> } = {},
) {
  return BillingRoutes({
    env: ENV,
    store: fakeStore(),
    polar: {} as unknown as PolarClientLike,
    ...options,
  })
}

const eventPayload = (markerBytes = 0) =>
  JSON.stringify({
    type: "customer.state_changed",
    data: {
      id: "cus_1",
      modified_at: "2026-07-12T10:00:00.000Z",
      active_subscriptions: [],
      // Padding to push the body over a cap without changing its shape.
      ...(markerBytes ? { padding: "x".repeat(markerBytes) } : {}),
    },
  })

/** A correctly signed webhook request. */
async function signedRequest(payload: string, headers: Record<string, string> = {}) {
  const timestampSeconds = Math.floor(Date.now() / 1000)
  const signature = await signStandardWebhook({ payload, id: "msg_1", timestampSeconds, secret: SECRET })
  return new Request("http://cp.test/polar/webhook", {
    method: "POST",
    body: payload,
    headers: {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestampSeconds),
      "webhook-signature": signature,
      ...headers,
    },
  })
}

describe("Polar webhook body cap", () => {
  test("a body over the cap is rejected 413, and the state is never applied", async () => {
    const store = fakeStore()
    const routes = BillingRoutes({
      env: ENV,
      store,
      polar: {} as unknown as PolarClientLike,
      webhookMaxBodyBytes: 512,
    })

    const response = await routes.fetch(await signedRequest(eventPayload(2_000)))

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: "billing_webhook_body_too_large" } })
    // The cap is upstream of everything: no authority write happened.
    expect(store.applyPolarState).not.toHaveBeenCalled()
  })

  test("a body under the cap still succeeds — the cap does not break real deliveries", async () => {
    // Strangler check. A cap that also rejects legitimate Polar traffic would be
    // a regression dressed as a fix.
    const store = fakeStore()
    const routes = BillingRoutes({ env: ENV, store, polar: {} as unknown as PolarClientLike })

    const response = await routes.fetch(await signedRequest(eventPayload()))

    expect(response.status).toBe(200)
    expect(store.applyPolarState).toHaveBeenCalled()
  })

  test("the cap holds on ACTUAL bytes when content-length is absent (chunked upload)", async () => {
    // The bypass a content-length-only precheck would hand an attacker: send the
    // body as a stream and declare nothing. The count on the real read is what
    // makes the cap unavoidable.
    const oversized = new Uint8Array(4_096)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Several chunks so the running total, not a single length, is what trips.
        for (let i = 0; i < 4; i += 1) controller.enqueue(oversized)
        controller.close()
      },
    })
    const request = new Request("http://cp.test/polar/webhook", {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required for a streaming body and is not in the DOM lib here
      duplex: "half",
    })

    expect(request.headers.get("content-length")).toBeNull()
    await expect(readCappedBody(request, 1_024)).resolves.toEqual({ ok: false })
  })

  test("a LYING content-length does not get a free pass", async () => {
    // Declaring 10 bytes and sending 4 KiB must still be rejected, for the same
    // reason: the header is the caller's claim, not a fact.
    const body = "x".repeat(4_096)
    const request = new Request("http://cp.test/polar/webhook", {
      method: "POST",
      body,
      headers: { "content-length": "10" },
    })

    await expect(readCappedBody(request, 1_024)).resolves.toEqual({ ok: false })
  })

  test("an oversized content-length is rejected without consuming the body", async () => {
    // The cheap path: reject the honest oversized declaration up front, without
    // ever getting a reader on the body. `bodyUsed` is the observable proof —
    // it flips only when something reads the stream.
    const request = new Request("http://cp.test/polar/webhook", {
      method: "POST",
      body: "x".repeat(64),
      headers: { "content-length": String(POLAR_WEBHOOK_MAX_BODY_BYTES + 1) },
    })

    await expect(readCappedBody(request, POLAR_WEBHOOK_MAX_BODY_BYTES)).resolves.toEqual({ ok: false })
    expect(request.bodyUsed).toBe(false)

    // Contrast: a body that must actually be counted DOES get read, so the
    // assertion above is about the precheck rather than about `bodyUsed` being
    // trivially false for every request.
    const counted = new Request("http://cp.test/polar/webhook", { method: "POST", body: "x".repeat(64) })
    await readCappedBody(counted, POLAR_WEBHOOK_MAX_BODY_BYTES)
    expect(counted.bodyUsed).toBe(true)
  })

  test("readCappedBody returns the exact bytes, so the signature still verifies", async () => {
    // The HMAC is over the bytes Polar sent. A decode that altered them (a lost
    // multi-byte character at a chunk boundary) would turn every signed delivery
    // into a 401 — a much worse failure than the one being fixed.
    const payload = JSON.stringify({ type: "customer.state_changed", note: "emoji ✅ and accents éü" })
    const request = new Request("http://cp.test/polar/webhook", { method: "POST", body: payload })

    const result = await readCappedBody(request, POLAR_WEBHOOK_MAX_BODY_BYTES)
    expect(result).toEqual({ ok: true, payload })
  })

  test("the cap holds even when the webhook secret is unconfigured", async () => {
    // The cap must not be reachable-only-when-configured. If the missing-secret
    // 503 ran first, an unconfigured deploy would buffer arbitrary bodies from
    // anonymous callers — and "unconfigured" is the state a deploy that just lost
    // its secret is in, which is exactly when you least want that.
    const routes = BillingRoutes({
      env: {},
      store: fakeStore(),
      polar: {} as unknown as PolarClientLike,
      webhookMaxBodyBytes: 512,
    })

    const response = await routes.fetch(await signedRequest(eventPayload(2_000)))

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: "billing_webhook_body_too_large" } })

    // A normal-sized body on that same unconfigured deploy still gets the 503, so
    // the fail-closed contract for a lost secret is unchanged.
    const configured = await routes.fetch(await signedRequest(eventPayload()))
    expect(configured.status).toBe(503)
  })

  test("the default cap is tighter than the app-wide default guard", () => {
    // The plane's only unauthenticated write surface should not inherit the
    // general 1 MiB allowance.
    expect(POLAR_WEBHOOK_MAX_BODY_BYTES).toBe(512 * 1024)
    expect(POLAR_WEBHOOK_MAX_BODY_BYTES).toBeLessThan(1024 * 1024)
  })
})

describe("Polar webhook rate limit", () => {
  test("a flood from one IP is limited, and other IPs are unaffected", async () => {
    const routes = app({ webhookRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 3, windowMs: 60_000 }) })
    const send = (ip: string) =>
      signedRequest(eventPayload(), { "cf-connecting-ip": ip }).then((request) => routes.fetch(request))

    const statuses: number[] = []
    for (let i = 0; i < 5; i += 1) statuses.push((await send("198.51.100.9")).status)

    expect(statuses).toEqual([200, 200, 200, 429, 429])

    // Per-IP, not global: one abusive sender must not lock out Polar itself.
    expect((await send("203.0.113.7")).status).toBe(200)
  })

  test("the 429 says what it is and when to retry", async () => {
    const routes = app({ webhookRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }) })
    await routes.fetch(await signedRequest(eventPayload(), { "cf-connecting-ip": "198.51.100.9" }))
    const rejected = await routes.fetch(await signedRequest(eventPayload(), { "cf-connecting-ip": "198.51.100.9" }))

    expect(rejected.status).toBe(429)
    const body = (await rejected.json()) as { error: { code: string; retryAfterMs: number } }
    expect(body.error.code).toBe("billing_webhook_rate_limited")
    expect(body.error.retryAfterMs).toBeGreaterThan(0)
  })

  test("the limiter runs BEFORE signature verification, so garbage is cheap to reject", async () => {
    // Ordering is the point. If verification came first, a flood of unsigned
    // bodies would each cost an HMAC over the whole payload — the limiter would
    // protect the authority but not the CPU.
    const routes = app({ webhookRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 2, windowMs: 60_000 }) })
    const unsigned = () =>
      routes.fetch(
        new Request("http://cp.test/polar/webhook", {
          method: "POST",
          body: eventPayload(),
          headers: { "cf-connecting-ip": "198.51.100.9" },
        }),
      )

    // Unsigned requests are 401s, and they still SPEND budget — otherwise an
    // attacker floods for free by never signing.
    expect((await unsigned()).status).toBe(401)
    expect((await unsigned()).status).toBe(401)
    expect((await unsigned()).status).toBe(429)
  })

  test("falls back to x-forwarded-for when cf-connecting-ip is absent (Node container)", async () => {
    const routes = app({ webhookRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }) })
    const send = (forwarded: string) =>
      signedRequest(eventPayload(), { "x-forwarded-for": forwarded }).then((request) => routes.fetch(request))

    expect((await send("198.51.100.9, 10.0.0.1")).status).toBe(200)
    expect((await send("198.51.100.9, 10.0.0.1")).status).toBe(429)
    // A different client behind the same proxy keeps its own budget.
    expect((await send("203.0.113.7, 10.0.0.1")).status).toBe(200)
  })

  test("the webhook limiter is INDEPENDENT of the checkout/portal limiter", async () => {
    // The old limiter keyed on auth.user.subject, which is exactly why it could
    // never cover the webhook. Sharing one bucket now would let webhook traffic
    // rate-limit a paying admin's checkout, or vice versa.
    const shared = createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 })
    const routes = BillingRoutes({
      env: ENV,
      store: fakeStore(),
      polar: {} as unknown as PolarClientLike,
      rateLimiter: shared,
      webhookRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 5, windowMs: 60_000 }),
    })

    for (let i = 0; i < 3; i += 1) {
      const response = await routes.fetch(await signedRequest(eventPayload(), { "cf-connecting-ip": "198.51.100.9" }))
      expect(response.status).toBe(200)
    }
    // The checkout limiter's single unit was never spent by webhook traffic.
    expect(shared.check({ userId: "admin", workspaceId: "billing" }).allowed).toBe(true)
  })
})
