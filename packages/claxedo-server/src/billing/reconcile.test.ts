import { describe, expect, test, vi } from "vitest"
import { reconcileBillingState, runScheduledBillingReconciliation } from "./reconcile"
import type { BillingStore } from "./billing-store"
import type { PolarClientLike } from "./billing-routes"

/**
 * D5 reconciliation sweep, Worker half: fetch fresh Polar customer state for
 * flagged orgs and re-apply via the single writer. The load-bearing rule under
 * test: Polar-unreachable → report + leave state — NEVER a downgrade. Only a
 * successfully fetched fresh state writes anything.
 */

const ENV = {
  CLAXEDO_POLAR_ACCESS_TOKEN: "polar_at_test",
  CLAXEDO_POLAR_PRODUCT_MONTHLY: "prod_monthly",
  CLAXEDO_POLAR_PRODUCT_YEARLY: "prod_yearly",
}

function fakeStore(flagged: Array<{ org_id: string; polar_customer_id: string }>) {
  return {
    entitlementState: vi.fn(async () => ({ found: false as const })),
    applyPolarState: vi.fn(async () => ({ results: [], unresolved: [] })),
    checkoutContext: vi.fn(),
    listReconcileFlagged: vi.fn(async () => flagged),
  } as unknown as BillingStore & { applyPolarState: ReturnType<typeof vi.fn> }
}

function fakePolar(getState: (args: { id: string }) => Promise<unknown>) {
  return {
    checkouts: { create: vi.fn() },
    customerSessions: { create: vi.fn() },
    customers: { getState: vi.fn(getState) },
  } as unknown as PolarClientLike
}

describe("reconcileBillingState", () => {
  test("re-applies freshly fetched customer state for each flagged org", async () => {
    const store = fakeStore([{ org_id: "org_doc_1", polar_customer_id: "cus_1" }])
    const polar = fakePolar(async () => ({
      id: "cus_1",
      modified_at: "2026-07-12T10:00:00.000Z",
      active_subscriptions: [
        {
          id: "sub_1",
          status: "active",
          product_id: "prod_monthly",
          modified_at: "2026-07-12T10:00:00.000Z",
          metadata: { org_id: "org_doc_1" },
        },
      ],
    }))

    const result = await reconcileBillingState({ env: ENV, store, polar })
    expect(result).toEqual({ flagged: 1, applied: 1, failed: 0 })
    expect(store.applyPolarState).toHaveBeenCalledWith(
      expect.objectContaining({
        polar_customer_id: "cus_1",
        source: "reconciliation",
        org_states: [expect.objectContaining({ org_id: "org_doc_1" })],
      }),
    )
  })

  test("Polar unreachable → reports, leaves state, applies NOTHING (no downgrade on failure)", async () => {
    const store = fakeStore([
      { org_id: "org_doc_1", polar_customer_id: "cus_1" },
      { org_id: "org_doc_2", polar_customer_id: "cus_2" },
    ])
    const polar = fakePolar(async () => {
      throw new Error("polar is down")
    })

    const result = await reconcileBillingState({ env: ENV, store, polar })
    expect(result).toEqual({ flagged: 2, applied: 0, failed: 2 })
    expect(store.applyPolarState).not.toHaveBeenCalled()
  })

  test("one customer failing does not stop the sweep for the others", async () => {
    const store = fakeStore([
      { org_id: "org_doc_1", polar_customer_id: "cus_broken" },
      { org_id: "org_doc_2", polar_customer_id: "cus_2" },
    ])
    const polar = fakePolar(async ({ id }) => {
      if (id === "cus_broken") throw new Error("boom")
      return { id, modified_at: "2026-07-12T10:00:00.000Z", active_subscriptions: [] }
    })

    const result = await reconcileBillingState({ env: ENV, store, polar })
    expect(result).toEqual({ flagged: 2, applied: 1, failed: 1 })
    expect(store.applyPolarState).toHaveBeenCalledTimes(1)
  })
})

describe("runScheduledBillingReconciliation (cron entrypoint)", () => {
  test("no-ops without a Polar access token (billing not deployed)", async () => {
    await expect(runScheduledBillingReconciliation({})).resolves.toBeUndefined()
  })

  test("never throws — a billing hiccup must not fail the shared cron run", async () => {
    // Token present but Convex/Polar config broken → reconcileBillingState
    // throws internally; the entrypoint reports and swallows.
    await expect(
      runScheduledBillingReconciliation({ CLAXEDO_POLAR_ACCESS_TOKEN: "tok" }),
    ).resolves.toBeUndefined()
  })
})
