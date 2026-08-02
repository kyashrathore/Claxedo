import { describe, expect, test, vi } from "vitest"
import { BillingRoutes, POLAR_INTERACTIVE_TIMEOUT_MS, type PolarClientLike } from "./routes"
import type { BillingStore } from "./store"
import { signStandardWebhook } from "./standard-webhooks"

/**
 * Worker billing routes (D4; ADR 014 addendum — Option B):
 * webhook signature accept/reject, checkout auth + seat floor + lazy customer
 * linkage, portal. Polar is a structural fake (no live Polar, per S2 gating);
 * the Convex store is a fake of the billing-store port.
 */

const SECRET = "polar-test-secret"
const ENV = {
  CLAXEDO_POLAR_WEBHOOK_SECRET: SECRET,
  CLAXEDO_POLAR_ACCESS_TOKEN: "polar_at_test",
  CLAXEDO_POLAR_PRODUCT_MONTHLY: "prod_monthly",
  CLAXEDO_POLAR_PRODUCT_YEARLY: "prod_yearly",
}

// Bearer convention: "subject@org/role" — the fake verifier parses it, the
// fake store reports the role.
const authConfig = { enabled: true as const, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" }
const verifier = async (token: string) => {
  const [subject, org] = token.split("@")
  return {
    mode: "signed" as const,
    user: {
      subject: subject!,
      tokenIdentifier: `https://clerk.test|${subject}`,
      issuer: "https://clerk.test",
      ...(org ? { orgId: org.split("/")[0]! } : {}),
    },
  }
}

function fakeStore(overrides: Partial<BillingStore> = {}): BillingStore & { applyPolarState: ReturnType<typeof vi.fn> } {
  return {
    entitlementState: vi.fn(async () => ({ found: false as const })),
    applyPolarState: vi.fn(async () => ({ results: [{ org_id: "org_doc_1", applied: true }], unresolved: [] })),
    checkoutContext: vi.fn(async (token: string) => ({
      org_id: "org_doc_1",
      clerk_org_id: "org_a",
      role: token.includes("/member") ? "member" : "owner",
      member_count: 3,
      plan: undefined,
    })),
    listReconcileFlagged: vi.fn(async () => []),
    ...overrides,
  } as never
}

function fakePolar(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    checkouts: {
      create: vi.fn(async () => ({ id: "chk_1", url: "https://polar.sh/checkout/chk_1" })),
    },
    customerSessions: {
      create: vi.fn(async () => ({ token: "cs_tok", customerPortalUrl: "https://polar.sh/portal/cs_1" })),
    },
    customers: {
      getState: vi.fn(async () => ({ id: "cus_1", modified_at: "2026-07-12T00:00:00Z", active_subscriptions: [] })),
    },
    ...overrides,
  } as unknown as PolarClientLike & {
    checkouts: { create: ReturnType<typeof vi.fn> }
    customerSessions: { create: ReturnType<typeof vi.fn> }
  }
}

function app(input: { store?: BillingStore; polar?: PolarClientLike; env?: Record<string, string | undefined> } = {}) {
  return BillingRoutes({
    env: input.env ?? ENV,
    authConfig,
    verifier,
    store: input.store ?? fakeStore(),
    polar: input.polar ?? fakePolar(),
  })
}

async function webhookRequest(payload: string, options: { secret?: string; headers?: Record<string, string> } = {}) {
  const timestampSeconds = Math.floor(Date.now() / 1000)
  const signature = await signStandardWebhook({
    payload,
    id: "msg_1",
    timestampSeconds,
    secret: options.secret ?? SECRET,
  })
  return new Request("http://cp.test/polar/webhook", {
    method: "POST",
    body: payload,
    headers: {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestampSeconds),
      "webhook-signature": signature,
      ...(options.headers ?? {}),
    },
  })
}

const stateChangedPayload = JSON.stringify({
  type: "customer.state_changed",
  data: {
    id: "cus_1",
    modified_at: "2026-07-12T10:00:00.000Z",
    active_subscriptions: [
      {
        id: "sub_1",
        status: "active",
        product_id: "prod_monthly",
        seats: 3,
        modified_at: "2026-07-12T10:00:00.000Z",
        current_period_end: "2026-08-12T10:00:00.000Z",
        metadata: { org_id: "org_doc_1" },
      },
    ],
  },
})

describe("POST /polar/webhook", () => {
  test("verified customer.state_changed is applied through the single writer", async () => {
    const store = fakeStore()
    const res = await app({ store }).request(await webhookRequest(stateChangedPayload))
    expect(res.status).toBe(200)
    expect(store.applyPolarState).toHaveBeenCalledTimes(1)
    const args = store.applyPolarState.mock.calls[0]![0]
    expect(args).toMatchObject({
      polar_customer_id: "cus_1",
      source: "customer_state",
      org_states: [{ org_id: "org_doc_1", state: { plan: "pro", subscription_status: "active", seats_licensed: 3 } }],
    })
  })

  test("bad signature → 401 and state is NEVER applied", async () => {
    const store = fakeStore()
    const request = await webhookRequest(stateChangedPayload, { secret: "wrong-secret" })
    const res = await app({ store }).request(request)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_webhook_signature" } })
    expect(store.applyPolarState).not.toHaveBeenCalled()
  })

  test("missing signature headers → 401, state never applied", async () => {
    const store = fakeStore()
    const res = await app({ store }).request(
      new Request("http://cp.test/polar/webhook", { method: "POST", body: stateChangedPayload }),
    )
    expect(res.status).toBe(401)
    expect(store.applyPolarState).not.toHaveBeenCalled()
  })

  test("missing webhook secret env → 503 fail-closed (Polar will retry)", async () => {
    const store = fakeStore()
    const res = await app({ store, env: { ...ENV, CLAXEDO_POLAR_WEBHOOK_SECRET: undefined } })
      .request(await webhookRequest(stateChangedPayload))
    expect(res.status).toBe(503)
    expect(store.applyPolarState).not.toHaveBeenCalled()
  })

  test("verified but non-billing event (order.paid) is acked 202 without a write", async () => {
    const store = fakeStore()
    const payload = JSON.stringify({ type: "order.paid", data: { id: "ord_1" } })
    const res = await app({ store }).request(await webhookRequest(payload))
    expect(res.status).toBe(202)
    expect(store.applyPolarState).not.toHaveBeenCalled()
  })

  test("F19: customer.state_changed with no usable source timestamp is acked 202 without a write", async () => {
    const store = fakeStore()
    // No customer modified_at and no subscription timestamps: the replay guard
    // cannot be anchored, so the state must NOT be stamped with now() and
    // applied. The route acks (202) so Polar stops retrying and pages instead.
    const payload = JSON.stringify({ type: "customer.state_changed", data: { id: "cus_1", active_subscriptions: [] } })
    const res = await app({ store }).request(await webhookRequest(payload))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ received: true, applied: false })
    expect(store.applyPolarState).not.toHaveBeenCalled()
  })

  test("mirror write failure → 500 so Polar retries the delivery", async () => {
    const store = fakeStore({
      applyPolarState: vi.fn(async () => {
        throw new Error("convex down")
      }),
    })
    const res = await app({ store }).request(await webhookRequest(stateChangedPayload))
    expect(res.status).toBe(500)
  })
})

describe("POST /checkout", () => {
  const post = (bearer: string | undefined, body: unknown) =>
    new Request("http://cp.test/checkout", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    })

  test("anonymous → 401", async () => {
    const res = await app().request(post(undefined, { plan: "monthly" }))
    expect(res.status).toBe(401)
  })

  test("non-admin org member → 403", async () => {
    const res = await app().request(post("mallory@org_a/member", { plan: "monthly" }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: "billing_admin_required" } })
  })

  test("F9: owner checkout keys external_customer_id on the ORG (org_{id}), not the admin subject; metadata.org_id rides", async () => {
    const polar = fakePolar()
    const res = await app({ polar }).request(post("alice@org_a", { plan: "yearly", seats: 5 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ url: "https://polar.sh/checkout/chk_1", seats: 5, orgId: "org_doc_1" })
    expect(polar.checkouts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ["prod_yearly"],
        seats: 5,
        externalCustomerId: "org_org_doc_1",
        metadata: { org_id: "org_doc_1" },
      }),
      // W4.5: checkout is user-facing, so it carries the interactive deadline.
      { timeoutMs: POLAR_INTERACTIVE_TIMEOUT_MS },
    )
  })

  test("F9: a second, different admin of the same org resolves the SAME org-scoped customer id", async () => {
    const polar = fakePolar()
    // Both admins' checkoutContext resolves the same org_doc_1 (fakeStore), so
    // the external id must be identical regardless of which human checks out.
    await app({ polar }).request(post("alice@org_a", { plan: "monthly" }))
    await app({ polar }).request(post("bob@org_a", { plan: "monthly" }))
    const externalIds = polar.checkouts.create.mock.calls.map((call) => (call[0] as { externalCustomerId: string }).externalCustomerId)
    expect(externalIds).toEqual(["org_org_doc_1", "org_org_doc_1"])
  })

  test("F2: an org with a live subscription is blocked from a second checkout (409, no Polar call)", async () => {
    for (const status of ["active", "trialing", "past_due"]) {
      const polar = fakePolar()
      const store = fakeStore({
        checkoutContext: vi.fn(async () => ({
          org_id: "org_doc_1",
          clerk_org_id: "org_a",
          role: "owner",
          member_count: 3,
          plan: "pro" as const,
          subscription_status: status,
        })),
      })
      const res = await app({ polar, store }).request(post("alice@org_a", { plan: "monthly" }))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: { code: "billing_already_subscribed" } })
      expect(polar.checkouts.create).not.toHaveBeenCalled()
    }
  })

  test("F2: a free/canceled org still proceeds to checkout", async () => {
    const polar = fakePolar()
    const store = fakeStore({
      checkoutContext: vi.fn(async () => ({
        org_id: "org_doc_1",
        clerk_org_id: "org_a",
        role: "owner",
        member_count: 3,
        plan: "free" as const,
        subscription_status: "canceled",
      })),
    })
    const res = await app({ polar, store }).request(post("alice@org_a", { plan: "monthly" }))
    expect(res.status).toBe(200)
    expect(polar.checkouts.create).toHaveBeenCalledTimes(1)
  })

  test("defaults seats to the current member count; refuses below it (per-seat floor)", async () => {
    const polar = fakePolar()
    const ok = await app({ polar }).request(post("alice@org_a", { plan: "monthly" }))
    expect(ok.status).toBe(200)
    expect(polar.checkouts.create).toHaveBeenCalledWith(
      expect.objectContaining({ seats: 3 }),
      { timeoutMs: POLAR_INTERACTIVE_TIMEOUT_MS },
    )

    const below = await app({ polar }).request(post("alice@org_a", { plan: "monthly", seats: 2 }))
    expect(below.status).toBe(400)
    expect(await below.json()).toMatchObject({ error: { code: "seat_count_below_members" } })
  })

  test("missing Polar config → 503 fail-closed", async () => {
    const res = await app({ env: { ...ENV, CLAXEDO_POLAR_PRODUCT_MONTHLY: undefined } })
      .request(post("alice@org_a", { plan: "monthly" }))
    expect(res.status).toBe(503)
  })

  test("Polar API failure → 502 billing_provider_error", async () => {
    const polar = fakePolar({
      checkouts: {
        create: vi.fn(async () => {
          throw new Error("polar 500")
        }),
      },
    })
    const res = await app({ polar }).request(post("alice@org_a", { plan: "monthly" }))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: "billing_provider_error" } })
  })
})

describe("POST /portal", () => {
  const post = (bearer?: string) =>
    new Request("http://cp.test/portal", {
      method: "POST",
      ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    })

  test("anonymous → 401; non-admin → 403; owner gets the portal URL", async () => {
    expect((await app().request(post())).status).toBe(401)
    expect((await app().request(post("mallory@org_a/member"))).status).toBe(403)
    const res = await app().request(post("alice@org_a"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: "https://polar.sh/portal/cs_1" })
  })

  test("F9: portal resolves the ORG-scoped customer — a non-purchasing admin reaches the same customer", async () => {
    const polar = fakePolar()
    const res = await app({ polar }).request(post("bob@org_a"))
    expect(res.status).toBe(200)
    expect(polar.customerSessions.create).toHaveBeenCalledWith(
      { externalCustomerId: "org_org_doc_1" },
      // W4.5: the portal redirect is user-facing too.
      { timeoutMs: POLAR_INTERACTIVE_TIMEOUT_MS },
    )
  })
})
