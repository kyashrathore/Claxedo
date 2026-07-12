/**
 * applyPolarState — D5's single translation module (launch plan 012 D5,
 * ADR 014 §3 + addendum): turns a Polar payload (webhook event or
 * reconciliation fetch) into org-field writes through the ONE builder-gated
 * Convex service mutation (convex/billing.ts `applyPolarState`). Nothing else
 * anywhere writes the mirrored billing fields — enforced grep-style by
 * billing-architecture.test.ts.
 *
 * Semantics (ADR 014 §3):
 * - state-APPLYING, not event-interpreting: `customer.state_changed` carries
 *   the customer's full current state and is the canonical source; the
 *   granular `subscription.*` events are triggers for the same recompute;
 * - idempotent under duplicates and reordering via the source-timestamp guard
 *   in the Convex mutation (older-than-last-applied → no-op);
 * - fail-closed: anything unattributable or non-entitling resolves toward the
 *   free tier; only FRESH state ever downgrades (the reconciliation sweep
 *   reports and leaves state on fetch failure — see reconcile.ts).
 *
 * Payload tolerance: webhook bodies arrive in Polar wire format (snake_case,
 * ISO dates); the reconciliation path goes through `@polar-sh/sdk`, which
 * yields camelCase models with Date objects. The readers below accept both so
 * one module serves both sources.
 */

import type { ApplyPolarStateArgs, ApplyPolarStateResult, BillingStore, OrgBillingStateWrite } from "./billing-store"

/** Subscription statuses that entitle (ADR 014 §3: past_due is grace-managed in entitlement.ts). */
const ENTITLING_STATUSES = new Set(["active", "trialing", "past_due"])

type Rec = Record<string, unknown>

function rec(value: unknown): Rec | undefined {
  return value && typeof value === "object" ? (value as Rec) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Read either wire (snake_case) or SDK (camelCase) key. */
function field(source: Rec | undefined, snake: string, camel: string): unknown {
  if (!source) return undefined
  return source[snake] !== undefined && source[snake] !== null ? source[snake] : source[camel]
}

/** ISO string | Date | epoch ms → epoch ms. */
function epochMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function subscriptionOrgId(subscription: Rec): string | undefined {
  return str(rec(subscription.metadata)?.org_id)
}

function subscriptionCustomerId(subscription: Rec): string | undefined {
  return str(field(subscription, "customer_id", "customerId")) ?? str(rec(subscription.customer)?.id)
}

function subscriptionProductId(subscription: Rec): string | undefined {
  return str(field(subscription, "product_id", "productId")) ?? str(rec(subscription.product)?.id)
}

function subscriptionModifiedAt(subscription: Rec): number | undefined {
  return epochMs(field(subscription, "modified_at", "modifiedAt")) ?? epochMs(field(subscription, "created_at", "createdAt"))
}

export type PolarProductConfig = {
  /**
   * Our per-seat product ids (CLAXEDO_POLAR_PRODUCT_MONTHLY/_YEARLY). When
   * configured, subscriptions for other products are ignored; when empty
   * (dev/sandbox), every subscription counts.
   */
  knownProductIds: ReadonlySet<string>
}

function relevantProduct(subscription: Rec, config: PolarProductConfig): boolean {
  if (config.knownProductIds.size === 0) return true
  const productId = subscriptionProductId(subscription)
  return !!productId && config.knownProductIds.has(productId)
}

function subscriptionState(subscription: Rec, source: "customer_state" | "subscription_event" | "reconciliation"): OrgBillingStateWrite {
  const status = str(subscription.status) ?? "unknown"
  if (!ENTITLING_STATUSES.has(status)) {
    // Terminal / non-entitling (canceled, revoked, unpaid, incomplete_expired,
    // incomplete, unknown): free tier, status recorded for supportability.
    return { plan: "free", subscription_status: status }
  }
  // S2-PENDING (ADR 014 §6.3 Q4): SDK 0.48.1 models carry `seats` (Polar
  // seat-based pricing) and NO plain `quantity` field anywhere — the ADR's
  // pre-decided fallback ladder (plain quantity → seats feature count) lands
  // on seats. `customer.state_changed` subscription entries omit seats
  // entirely, hence preserve_seats.
  const seats = num(subscription.seats) ?? num(subscription.quantity)
  return {
    plan: "pro",
    subscription_status: status,
    polar_subscription_id: str(subscription.id),
    ...(seats !== undefined ? { seats_licensed: seats } : {}),
    ...(epochMs(field(subscription, "current_period_end", "currentPeriodEnd")) !== undefined
      ? { current_period_end: epochMs(field(subscription, "current_period_end", "currentPeriodEnd")) }
      : {}),
    // customer-state payloads (webhook AND reconciliation getState) omit
    // seats in SDK 0.48.1 — never let them wipe a mirrored seat count.
    ...(source !== "subscription_event" && seats === undefined ? { preserve_seats: true } : {}),
  }
}

/**
 * Rank when one org somehow has several subscriptions in a state payload:
 * active > trialing > past_due (freshest entitlement wins).
 */
function statusRank(state: OrgBillingStateWrite): number {
  if (state.subscription_status === "active") return 3
  if (state.subscription_status === "trialing") return 2
  if (state.subscription_status === "past_due") return 1
  return 0
}

/** Normalize a Polar CUSTOMER STATE (webhook `customer.state_changed` data or `customers.getState` result). */
export function customerStateToApplyArgs(
  state: unknown,
  config: PolarProductConfig,
  source: "customer_state" | "reconciliation" = "customer_state",
): ApplyPolarStateArgs | undefined {
  const customer = rec(state)
  const customerId = str(customer?.id)
  if (!customer || !customerId) return undefined

  const subscriptions = (field(customer, "active_subscriptions", "activeSubscriptions") as unknown[] | undefined) ?? []
  const byOrg = new Map<string, OrgBillingStateWrite>()
  let sourceTs = epochMs(field(customer, "modified_at", "modifiedAt")) ?? 0
  for (const entry of subscriptions) {
    const subscription = rec(entry)
    if (!subscription || !relevantProduct(subscription, config)) continue
    sourceTs = Math.max(sourceTs, subscriptionModifiedAt(subscription) ?? 0)
    const orgId = subscriptionOrgId(subscription)
    if (!orgId) continue // unattributable → contributes nothing (fail-closed)
    const next = subscriptionState(subscription, source)
    const existing = byOrg.get(orgId)
    if (!existing || statusRank(next) > statusRank(existing)) byOrg.set(orgId, next)
  }
  // F19 (adversarial review): a customer-state payload with NO usable source
  // timestamp (no customer modified_at and no subscription modified_at/
  // created_at) must NOT be stamped with Date.now() — doing so defeats the
  // last-write-wins replay/stale guard (every such payload would read as the
  // freshest write and could clobber a newer real state, or let a replay land).
  // Reject the payload here; the caller (webhook route / reconcile sweep) treats
  // the undefined result as unapplied and surfaces it via reportPaymentError,
  // exactly as it does for an unattributable event.
  if (sourceTs === 0) return undefined

  return {
    polar_customer_id: customerId,
    source_ts: sourceTs,
    source,
    // Orgs previously mirrored to this customer but absent here are downgraded
    // by the Convex mutation (full-state semantics, past_due carve-out inside).
    org_states: [...byOrg.entries()].map(([org_id, state]) => ({ org_id, state })),
  }
}

/** Normalize a `subscription.*` webhook event's data (a full Subscription). */
export function subscriptionEventToApplyArgs(
  subscription: unknown,
  config: PolarProductConfig,
): ApplyPolarStateArgs | undefined {
  const sub = rec(subscription)
  if (!sub || !relevantProduct(sub, config)) return undefined
  const customerId = subscriptionCustomerId(sub)
  const orgId = subscriptionOrgId(sub)
  if (!customerId || !orgId) return undefined // unattributable → skip, route reports
  return {
    polar_customer_id: customerId,
    source_ts: subscriptionModifiedAt(sub) ?? Date.now(),
    source: "subscription_event",
    org_states: [{ org_id: orgId, state: subscriptionState(sub, "subscription_event") }],
  }
}

export type PolarWebhookEvent = { type?: unknown; data?: unknown }

/**
 * One verified webhook event → apply-args, or undefined when the event is not
 * billing-state-bearing (order.*, benefit.*, checkout.* …: the subscription
 * lifecycle + customer state cover the mirror; everything else is noise here).
 */
/**
 * True when the event type is one we DO translate into billing state. Lets the
 * route distinguish a harmless order/benefit event (silent ack) from a
 * subscription or customer-state event we failed to attribute to an org (F7:
 * ack so Polar stops retrying, but page — a charge may have no entitlement).
 */
export function isBillingRelevantEventType(event: PolarWebhookEvent): boolean {
  const type = str(event.type)
  if (!type) return false
  return type === "customer.state_changed" || type.startsWith("subscription.")
}

export function webhookEventToApplyArgs(event: PolarWebhookEvent, config: PolarProductConfig): ApplyPolarStateArgs | undefined {
  const type = str(event.type)
  if (!type) return undefined
  if (type === "customer.state_changed") {
    // The event payload nests the customer state as `data`.
    return customerStateToApplyArgs(event.data, config, "customer_state")
  }
  if (type.startsWith("subscription.")) {
    return subscriptionEventToApplyArgs(event.data, config)
  }
  return undefined
}

/** Apply a normalized snapshot through the single Convex writer. */
export async function applyPolarState(store: BillingStore, args: ApplyPolarStateArgs): Promise<ApplyPolarStateResult> {
  return await store.applyPolarState(args)
}
