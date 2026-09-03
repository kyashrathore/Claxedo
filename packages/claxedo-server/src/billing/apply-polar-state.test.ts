import { describe, expect, test } from "vitest"
import { customerStateToApplyArgs, subscriptionEventToApplyArgs, webhookEventToApplyArgs } from "./apply-polar-state"
import { polarProductConfig } from "./routes"

/**
 * Payload translation: Polar wire/SDK payloads → the normalized org-state
 * writes the single authority writer applies. Wire fixtures use Polar's
 * snake_case JSON; SDK-shaped fixtures use camelCase + Date to prove the
 * reconciliation path shares the module.
 */

const PRODUCTS = {
  knownProductIds: new Set(["prod_monthly", "prod_yearly"]),
  allowAllProductsWhenUnconfigured: false,
}

const wireSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  product_id: "prod_monthly",
  customer_id: "cus_1",
  seats: 3,
  modified_at: "2026-07-12T10:00:00.000Z",
  current_period_end: "2026-08-12T10:00:00.000Z",
  metadata: { org_id: "org_doc_1" },
  ...overrides,
})

describe("customer.state_changed translation", () => {
  test("maps an active subscription to a pro org state keyed by metadata.org_id", () => {
    const args = customerStateToApplyArgs(
      {
        id: "cus_1",
        modified_at: "2026-07-12T09:00:00.000Z",
        active_subscriptions: [wireSubscription()],
      },
      PRODUCTS,
    )
    expect(args).toMatchObject({
      polar_customer_id: "cus_1",
      source: "customer_state",
      org_states: [
        {
          org_id: "org_doc_1",
          state: {
            plan: "pro",
            subscription_status: "active",
            polar_subscription_id: "sub_1",
            seats_licensed: 3,
            current_period_end: Date.parse("2026-08-12T10:00:00.000Z"),
          },
        },
      ],
    })
    // Source ts = max of customer + subscription modified_at.
    expect(args!.source_ts).toBe(Date.parse("2026-07-12T10:00:00.000Z"))
  })

  test("empty state (no subscriptions) still targets the customer so mirrored orgs downgrade", () => {
    const args = customerStateToApplyArgs(
      { id: "cus_1", modified_at: "2026-07-12T09:00:00.000Z", active_subscriptions: [] },
      PRODUCTS,
    )
    expect(args).toMatchObject({ polar_customer_id: "cus_1", source: "customer_state", org_states: [] })
  })

  test("subscriptions for foreign products are ignored", () => {
    const args = customerStateToApplyArgs(
      {
        id: "cus_1",
        modified_at: "2026-07-12T09:00:00.000Z",
        active_subscriptions: [wireSubscription({ product_id: "prod_other" })],
      },
      PRODUCTS,
    )
    expect(args!.org_states).toEqual([])
  })

  test("subscription entries without seats set preserve_seats (SDK 0.48.1 state payloads omit seats)", () => {
    const args = customerStateToApplyArgs(
      {
        id: "cus_1",
        modified_at: "2026-07-12T09:00:00.000Z",
        active_subscriptions: [wireSubscription({ seats: undefined })],
      },
      PRODUCTS,
    )
    expect(args!.org_states[0]!.state).toMatchObject({ plan: "pro", preserve_seats: true })
    expect(args!.org_states[0]!.state.seats_licensed).toBeUndefined()
  })

  test("accepts SDK-shaped (camelCase, Date) customer state — the reconciliation path", () => {
    const args = customerStateToApplyArgs(
      {
        id: "cus_1",
        modifiedAt: new Date("2026-07-12T09:00:00.000Z"),
        activeSubscriptions: [
          {
            id: "sub_1",
            status: "trialing",
            productId: "prod_yearly",
            modifiedAt: new Date("2026-07-12T10:00:00.000Z"),
            currentPeriodEnd: new Date("2027-07-12T10:00:00.000Z"),
            metadata: { org_id: "org_doc_1" },
          },
        ],
      },
      PRODUCTS,
      "reconciliation",
    )
    expect(args).toMatchObject({
      source: "reconciliation",
      org_states: [
        {
          org_id: "org_doc_1",
          state: { plan: "pro", subscription_status: "trialing", polar_subscription_id: "sub_1" },
        },
      ],
    })
  })

  describe("A payload with no usable source timestamp is rejected, never stamped now()", () => {
    test("no customer modified_at AND no subscription timestamps → undefined (replay guard preserved)", () => {
      const args = customerStateToApplyArgs({ id: "cus_1", active_subscriptions: [] }, PRODUCTS)
      expect(args).toBeUndefined()
    })

    test("a subscription that carries modified_at is enough to anchor, even without a customer modified_at", () => {
      const args = customerStateToApplyArgs(
        { id: "cus_1", active_subscriptions: [wireSubscription()] },
        PRODUCTS,
      )
      expect(args).toBeDefined()
      expect(args!.source_ts).toBe(Date.parse("2026-07-12T10:00:00.000Z"))
    })

    test("webhook routing surfaces the timestamp-less customer.state_changed as untranslatable (route reports + acks)", () => {
      expect(
        webhookEventToApplyArgs({ type: "customer.state_changed", data: { id: "cus_1", active_subscriptions: [] } }, PRODUCTS),
      ).toBeUndefined()
    })
  })

  test("multiple org subscriptions on one customer split into per-org states", () => {
    const args = customerStateToApplyArgs(
      {
        id: "cus_1",
        modified_at: "2026-07-12T09:00:00.000Z",
        active_subscriptions: [
          wireSubscription(),
          wireSubscription({ id: "sub_2", metadata: { org_id: "org_doc_2" }, seats: 7 }),
        ],
      },
      PRODUCTS,
    )
    expect(args!.org_states.map((entry) => entry.org_id).sort()).toEqual(["org_doc_1", "org_doc_2"])
  })
})

describe("subscription.* event translation", () => {
  test("entitling statuses map to pro; terminal statuses map to free with the status recorded", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      const args = subscriptionEventToApplyArgs(wireSubscription({ status }), PRODUCTS)
      expect(args!.org_states[0]!.state).toMatchObject({ plan: "pro", subscription_status: status })
      expect(args!.source).toBe("subscription_event")
    }
    for (const status of ["canceled", "revoked", "unpaid", "incomplete_expired"]) {
      const args = subscriptionEventToApplyArgs(wireSubscription({ status }), PRODUCTS)
      expect(args!.org_states[0]!.state).toMatchObject({ plan: "free", subscription_status: status })
    }
  })

  test("a subscription without metadata.org_id is unattributable and yields nothing (fail-closed)", () => {
    expect(subscriptionEventToApplyArgs(wireSubscription({ metadata: {} }), PRODUCTS)).toBeUndefined()
  })
})

describe("empty product allowlist", () => {
  test("production rejects subscription events and full customer snapshots", () => {
    const products = polarProductConfig({})

    expect(
      webhookEventToApplyArgs({ type: "subscription.updated", data: wireSubscription() }, products),
    ).toBeUndefined()
    expect(
      customerStateToApplyArgs(
        {
          id: "cus_1",
          modified_at: "2026-07-12T09:00:00.000Z",
          active_subscriptions: [wireSubscription()],
        },
        products,
        "reconciliation",
      ),
    ).toBeUndefined()
  })

  test("an explicit sandbox server accepts subscriptions without configured product ids", () => {
    const products = polarProductConfig({ CLAXEDO_POLAR_SERVER: "sandbox" })

    expect(
      webhookEventToApplyArgs({ type: "subscription.updated", data: wireSubscription() }, products),
    ).toBeDefined()
    expect(
      customerStateToApplyArgs(
        {
          id: "cus_1",
          modified_at: "2026-07-12T09:00:00.000Z",
          active_subscriptions: [wireSubscription()],
        },
        products,
        "reconciliation",
      ),
    ).toMatchObject({
      source: "reconciliation",
      org_states: [{ org_id: "org_doc_1", state: { plan: "pro" } }],
    })
  })
})

describe("webhook event routing", () => {
  test("customer.state_changed and subscription.* translate; other events are ignored", () => {
    expect(
      webhookEventToApplyArgs(
        { type: "customer.state_changed", data: { id: "cus_1", modified_at: "2026-07-12T09:00:00.000Z", active_subscriptions: [] } },
        PRODUCTS,
      ),
    ).toBeDefined()
    expect(webhookEventToApplyArgs({ type: "subscription.updated", data: wireSubscription() }, PRODUCTS)).toBeDefined()
    for (const type of ["order.paid", "benefit_grant.created", "checkout.updated", "customer.created"]) {
      expect(webhookEventToApplyArgs({ type, data: {} }, PRODUCTS)).toBeUndefined()
    }
  })
})
