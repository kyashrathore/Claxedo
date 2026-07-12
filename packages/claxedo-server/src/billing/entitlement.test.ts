import { describe, expect, test } from "vitest"
import type { EntitlementState } from "./billing-store"
import {
  BillingEntitlementError,
  createEntitlementGate,
  entitlementDecision,
  pastDueGraceDays,
  requireEntitlement,
  type EntitlementCapability,
} from "./entitlement"

/**
 * D6/B4 entitlement matrix (launch plan 012 I-4; ADR 014 §3/§5): entitlement
 * is a pure function of the mirrored org row. active + trialing entitle;
 * past_due entitles within the grace window; absent/free/canceled/unknown
 * fail closed to the free tier — for BOTH capabilities.
 */

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const now = () => NOW

const CAPABILITIES: EntitlementCapability[] = ["cloud-workspace", "hosted-connections"]

function proState(status: string, appliedAt: number = NOW): EntitlementState {
  return {
    found: true,
    org_id: "org_doc_1",
    plan: "pro",
    subscription_status: status,
    seats_licensed: 3,
    polar_state_modified_at: appliedAt,
    billing_synced_at: appliedAt,
  }
}

describe("entitlement matrix", () => {
  const matrix: Array<[string, EntitlementState, boolean]> = [
    ["absent org (unknown = free tier)", { found: false }, false],
    ["org without billing fields", { found: true, org_id: "org_doc_1" }, false],
    ["explicit free plan", { found: true, org_id: "org_doc_1", plan: "free" }, false],
    ["active", proState("active"), true],
    ["trialing", proState("trialing"), true],
    ["past_due within grace (day 3 of 7)", proState("past_due", NOW - 3 * DAY), true],
    ["past_due beyond grace (day 8 of 7)", proState("past_due", NOW - 8 * DAY), false],
    ["past_due with no grace anchor fails closed", { found: true, org_id: "o", plan: "pro", subscription_status: "past_due" }, false],
    ["canceled", proState("canceled"), false],
    ["revoked", proState("revoked"), false],
    ["unpaid", proState("unpaid"), false],
    ["unknown status string", proState("mystery_future_status"), false],
  ]

  for (const [label, state, expected] of matrix) {
    for (const capability of CAPABILITIES) {
      test(`${label} → ${expected ? "entitled" : "not entitled"} (${capability})`, () => {
        expect(entitlementDecision(state, capability, { graceDays: 7, now }).entitled).toBe(expected)
      })
    }
  }

  test("grace window length honors CLAXEDO_BILLING_PAST_DUE_GRACE_DAYS (default 7)", () => {
    expect(pastDueGraceDays({})).toBe(7)
    expect(pastDueGraceDays({ CLAXEDO_BILLING_PAST_DUE_GRACE_DAYS: "14" })).toBe(14)
    expect(pastDueGraceDays({ CLAXEDO_BILLING_PAST_DUE_GRACE_DAYS: "garbage" })).toBe(7)
    // day 10 past_due: outside the default 7, inside an explicit 14.
    const state = proState("past_due", NOW - 10 * DAY)
    expect(entitlementDecision(state, "cloud-workspace", { graceDays: 7, now }).entitled).toBe(false)
    expect(entitlementDecision(state, "cloud-workspace", { graceDays: 14, now }).entitled).toBe(true)
  })

  test("requireEntitlement throws the typed 402 error for a free org", async () => {
    await expect(
      requireEntitlement({ orgId: "org_doc_1" }, "cloud-workspace", {
        reader: async () => ({ found: false }),
        now,
      }),
    ).rejects.toThrow(BillingEntitlementError)
    await expect(
      requireEntitlement({ orgId: "org_doc_1" }, "cloud-workspace", {
        reader: async () => proState("active"),
        now,
      }),
    ).resolves.toBeUndefined()
  })
})

describe("entitlement gate composition (choke-point adapter)", () => {
  test("entitled → undefined; free tier → 402 typed denial", async () => {
    const gate = createEntitlementGate({
      env: {},
      store: {
        entitlementState: async (ref) => (ref.orgId === "org_paid" ? proState("active") : { found: false }),
        applyPolarState: async () => ({ results: [], unresolved: [] }),
        checkoutContext: async () => ({ org_id: "x", member_count: 1 }),
        listReconcileFlagged: async () => [],
      },
      now,
    })
    expect(await gate({ orgId: "org_paid" }, "cloud-workspace")).toBeUndefined()
    const denied = await gate({ orgId: "org_free" }, "hosted-connections")
    expect(denied).toMatchObject({ status: 402, body: { error: { code: "billing_entitlement_required" } } })
  })

  test("mirror unreadable → 503 fail-closed denial, never a grant", async () => {
    const gate = createEntitlementGate({
      env: {},
      store: {
        entitlementState: async () => {
          throw new Error("convex down")
        },
        applyPolarState: async () => ({ results: [], unresolved: [] }),
        checkoutContext: async () => ({ org_id: "x", member_count: 1 }),
        listReconcileFlagged: async () => [],
      },
      now,
    })
    const denied = await gate({ orgId: "org_paid" }, "cloud-workspace")
    expect(denied).toMatchObject({ status: 503, body: { error: { code: "billing_state_unavailable" } } })
  })

  test("missing store config (no env) fails closed with 503", async () => {
    const gate = createEntitlementGate({ env: {}, now })
    const denied = await gate({ orgId: "org_paid" }, "cloud-workspace")
    expect(denied).toMatchObject({ status: 503 })
  })
})
