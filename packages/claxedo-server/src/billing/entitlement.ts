/**
 * requireEntitlement — the ONE entitlement predicate (ADR 014 §3/§5).
 *
 * Entitlement is a pure function of the mirrored org row: no Polar call ever
 * happens at request time, so a Polar outage cannot lock
 * a paying customer out (ADR §3 "why not query-at-request-time").
 *
 * Capabilities are the hosted deltas (free = self-host-equivalent, ADR §5):
 * - "cloud-workspace":    hosted cloud workspace creation/orchestration
 * - "hosted-connections": the hosted connections credential surface
 *
 * Fail-closed (I-4): unknown org, absent fields, unknown status → free tier →
 * not entitled. `active` and `trialing` entitle; `past_due` entitles within
 * the grace window (CLAXEDO_BILLING_PAST_DUE_GRACE_DAYS, default 7 — plan OQ-4),
 * anchored on the FIRST past_due transition (past_due_since) — not
 * re-anchored per dunning webhook.
 *
 * Seat over-capacity: even an otherwise-entitling subscription does NOT
 * grant hosted access to an org that has MORE members than it has licensed
 * seats. The provider webhook mirror no longer hard-blocks a join (that 500'd the
 * whole Svix mirror), so this is where the seat ceiling is enforced: an
 * over-seat org is denied with the typed `seat_over_capacity` error carrying
 * the counts, and the owner is told to buy seats or remove members. A personal
 * org (member_count 1, seats_licensed 1 or absent) is never seat-limited.
 */

import { reportPaymentError } from "../platform/telemetry/errors/report"
import type { BillingStore, EntitlementState, EntitlementStateRef } from "./store-contract"

export type EntitlementCapability = "cloud-workspace" | "hosted-connections"

export const DEFAULT_PAST_DUE_GRACE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export class BillingEntitlementError extends Error {
  readonly status = 402
  constructor(
    public readonly code: "billing_entitlement_required" | "seat_over_capacity",
    public readonly capability: EntitlementCapability,
    message: string,
    /** Present for `seat_over_capacity`: the counts the owner needs to act on. */
    public readonly details?: { memberCount: number; seatsLicensed: number },
  ) {
    super(message)
    this.name = "BillingEntitlementError"
  }
}

export function pastDueGraceDays(env: Record<string, string | undefined>): number {
  const raw = env.CLAXEDO_BILLING_PAST_DUE_GRACE_DAYS?.trim()
  if (!raw) return DEFAULT_PAST_DUE_GRACE_DAYS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PAST_DUE_GRACE_DAYS
}

export type EntitlementDecision =
  | { entitled: true; status: string }
  | { entitled: false; reason: "no_org" | "free_tier" | "grace_expired" | "not_entitling_status" }
  | { entitled: false; reason: "seat_over_capacity"; memberCount: number; seatsLicensed: number }

/**
 * Pure decision over the mirrored state. Every hosted capability maps to
 * "the org pays" today (one flat plan); the capability parameter exists so a
 * future plan split changes THIS function only. The seat over-capacity gate
 * applies to every hosted capability identically.
 */
export function entitlementDecision(
  state: EntitlementState,
  _capability: EntitlementCapability,
  options: { graceDays?: number; now?: () => number } = {},
): EntitlementDecision {
  if (!state.found) return { entitled: false, reason: "no_org" }
  if (state.plan !== "pro") return { entitled: false, reason: "free_tier" }
  const status = state.subscription_status
  const statusDecision = ((): EntitlementDecision => {
    if (status === "active" || status === "trialing") return { entitled: true, status }
    if (status === "past_due") {
      const graceDays = options.graceDays ?? DEFAULT_PAST_DUE_GRACE_DAYS
      // Grace anchors on the FIRST past_due transition (past_due_since),
      // which applyPolarState stamps once and preserves across dunning retries —
      // NOT on polar_state_modified_at / billing_synced_at, which each dunning
      // webhook refreshes (that would re-extend grace for the whole dunning
      // cycle). Fall back to the older anchors only for rows written before the
      // field existed. Without any anchor, fail closed rather than granting an
      // unbounded grace.
      const anchor = state.past_due_since ?? state.polar_state_modified_at ?? state.billing_synced_at
      if (anchor === undefined) return { entitled: false, reason: "grace_expired" }
      const now = options.now?.() ?? Date.now()
      if (now <= anchor + graceDays * DAY_MS) return { entitled: true, status }
      return { entitled: false, reason: "grace_expired" }
    }
    return { entitled: false, reason: "not_entitling_status" }
  })()
  if (!statusDecision.entitled) return statusDecision
  // Seat over-capacity: the subscription itself entitles, but an org with
  // more members than licensed seats does not get hosted access for the
  // over-cap members. `seats_licensed` absent (personal org, or seats not yet
  // re-derived after a missed subscription.* webhook) means there is no
  // cap to exceed, so it stays entitled rather than fail toward blocking a
  // paying customer.
  if (
    state.seats_licensed !== undefined &&
    state.member_count !== undefined &&
    state.member_count > state.seats_licensed
  ) {
    return {
      entitled: false,
      reason: "seat_over_capacity",
      memberCount: state.member_count,
      seatsLicensed: state.seats_licensed,
    }
  }
  return statusDecision
}

export type EntitlementReader = (ref: EntitlementStateRef) => Promise<EntitlementState>

/**
 * THE predicate: resolve the org's mirrored state and throw the typed 402
 * when the capability is not paid for. Store/read failures propagate — an
 * unreachable mirror is an infrastructure 5xx for the caller to surface, not
 * a silent entitlement grant (and not a fake 402 either).
 */
export async function requireEntitlement(
  ref: EntitlementStateRef,
  capability: EntitlementCapability,
  options: { reader: EntitlementReader; graceDays?: number; now?: () => number },
): Promise<void> {
  const state = await options.reader(ref)
  const decision = entitlementDecision(state, capability, options)
  if (decision.entitled) return
  if (decision.reason === "seat_over_capacity") {
    // A distinct typed error carrying the counts, so the app can render the
    // "you have N members but M seats — buy more or remove members" surface.
    throw new BillingEntitlementError(
      "seat_over_capacity",
      capability,
      `Your org has ${decision.memberCount} members but only ${decision.seatsLicensed} licensed seats; add seats or remove members to use ${capability}`,
      { memberCount: decision.memberCount, seatsLicensed: decision.seatsLicensed },
    )
  }
  throw new BillingEntitlementError(
    "billing_entitlement_required",
    capability,
    `An active Claxedo Cloud subscription is required for ${capability} (${decision.reason})`,
  )
}

export type EntitlementGateEnv = Record<string, string | undefined>

export type EntitlementDenial = {
  status: 402 | 503
  body: { error: { code: string; message: string } }
}

/**
 * Launch posture (pricing decision 2026-07-12): LAUNCH FREE. The billing spine
 * ships built but DORMANT — enforcement is an explicit opt-in, so free→paid is
 * a config flip (set the flag + create Polar products), not engineering.
 * Anything other than exactly "1" leaves every org entitled.
 *
 * This is deliberately a positive ENFORCE flag rather than a bypass flag: an
 * unconfigured deployment (self-host, staging without billing vars) behaves
 * like the free launch, and turning billing ON is the deliberate act.
 */
export function billingEnforced(env: EntitlementGateEnv): boolean {
  return env.CLAXEDO_BILLING_ENFORCE?.trim() === "1"
}

/**
 * Composition helper for the two choke points (hosted-workspace create;
 * connections-host gate): a checker that returns a ready-to-serve denial
 * instead of throwing, so the call sites stay one-liners. Store config
 * missing → 503 fail-closed (hosted boot should have refused already).
 *
 * With enforcement off (the launch-free default) the gate grants without
 * reading the mirror at all — a deployment with no billing store configured
 * must not 503 its way into blocking free users.
 */
export function createEntitlementGate(input: {
  env: EntitlementGateEnv
  store?: BillingStore
  now?: () => number
}) {
  const enforced = billingEnforced(input.env)
  const store = input.store
  const graceDays = pastDueGraceDays(input.env)
  return async (ref: EntitlementStateRef, capability: EntitlementCapability): Promise<EntitlementDenial | undefined> => {
    if (!enforced) return undefined
    if (!store) {
      return {
        status: 503,
        body: {
          error: {
            code: "billing_state_unavailable",
            message: "Billing state is unavailable; hosted capability refused (fail-closed)",
          },
        },
      }
    }
    try {
      await requireEntitlement(ref, capability, {
        reader: (r) => store.entitlementState(r),
        graceDays,
        ...(input.now ? { now: input.now } : {}),
      })
      return undefined
    } catch (err) {
      if (err instanceof BillingEntitlementError) {
        return { status: 402, body: { error: { code: err.code, message: err.message } } }
      }
      // Mirror unreadable (missing config, storage error): fail CLOSED with a
      // 503 — a billing hiccup must never open a paid capability (I-4). This
      // is a paying-customer-facing failure → payment page class.
      reportPaymentError(err, {
        tags: { source: "billing_entitlement_gate" },
        extra: { capability },
      })
      return {
        status: 503,
        body: {
          error: {
            code: "billing_state_unavailable",
            message: "Billing state is unavailable; hosted capability refused (fail-closed)",
          },
        },
      }
    }
  }
}

export type EntitlementGate = ReturnType<typeof createEntitlementGate>
