/**
 * Billing reconciliation sweep — Worker half (ADR 014 §3, "the failure mode
 * webhooks alone can't cover"): Polar disables a webhook endpoint after 10
 * consecutive failed deliveries, silently stopping all future events. The
 * Convex cron (convex/crons.ts) FLAGS orgs whose mirror is stale; this sweep —
 * driven by the same Cloudflare Cron Trigger as the sandbox reaper via
 * worker.ts `scheduled` — fetches each flagged org's current customer state
 * from Polar and re-applies it through the single writer
 * (billing.applyPolarState), which clears the flag.
 *
 * Failure semantics (the load-bearing rule): Polar unreachable / errors →
 * reportPaymentError and LEAVE STATE AS IS. Only a successfully fetched FRESH
 * state ever downgrades an org; a reconciliation failure never does.
 */

import { reportPaymentError } from "../platform/telemetry/errors/report"
import { createBillingStore } from "./store"
import type { BillingStore } from "./store-contract"
import { customerStateToApplyArgs, type PolarProductConfig } from "./apply-polar-state"
import {
  polarClientFromEnv,
  polarProductConfig,
  POLAR_SWEEP_TIMEOUT_MS,
  type BillingEnv,
  type PolarClientLike,
} from "./routes"

export type ReconcileResult = {
  flagged: number
  applied: number
  failed: number
}

export async function reconcileBillingState(input: {
  env: BillingEnv
  store?: BillingStore
  polar?: PolarClientLike
  products?: PolarProductConfig
}): Promise<ReconcileResult> {
  const store = input.store ?? createBillingStore(input.env)
  const polar = input.polar ?? polarClientFromEnv(input.env)
  if (!polar) throw new Error("Polar access token is not configured (CLAXEDO_POLAR_ACCESS_TOKEN)")
  const products = input.products ?? polarProductConfig(input.env)

  const flagged = await store.listReconcileFlagged()
  let applied = 0
  let failed = 0
  // Concurrent/overlapping cron runs applying the same customer state are safe:
  // the single writer no-ops any source_ts <= the last recorded one per org
  // (convex/billing.ts:103), so a re-apply can never double-charge or clobber a
  // newer state — idempotent by source_ts.
  for (const org of flagged) {
    try {
      // Bound EVERY Polar call on this path. The loop is serial, so one
      // untimed call stalls not just this org but every org behind it — the
      // sweep silently stops making progress with nobody watching. The SDK
      // turns `timeoutMs` into a real AbortSignal, so a timed-out call is
      // cancelled rather than merely abandoned.
      const state = await polar.customers.getState(
        { id: org.polar_customer_id },
        { timeoutMs: POLAR_SWEEP_TIMEOUT_MS },
      )
      const applyArgs = customerStateToApplyArgs(state, products, "reconciliation")
      if (!applyArgs) {
        failed += 1
        reportPaymentError(new Error("Polar customer state was not normalizable during reconciliation"), {
          tags: { source: "billing_reconcile", reason: "unparseable_state" },
          extra: { orgId: org.org_id },
        })
        continue
      }
      // The mutation applies full-state semantics: if THIS org is absent from
      // the fresh state's subscriptions, it is downgraded — that is a fresh-
      // state downgrade, exactly the one downgrade reconciliation may do.
      await store.applyPolarState(applyArgs)
      applied += 1
    } catch (err) {
      // Leave state, keep the flag (applyPolarState is what clears it), page.
      failed += 1
      reportPaymentError(err, {
        tags: { source: "billing_reconcile", reason: "reconcile_failed" },
        extra: { orgId: org.org_id },
      })
    }
  }
  return { flagged: flagged.length, applied, failed }
}

export type CancelDeletedResult = {
  deleted: number
  canceled: number
  failed: number
}

/**
 * Adversarial review: an org deleted while it still holds a live Polar
 * subscription is billed forever — org delete cannot reach Polar (Convex holds
 * no Polar credentials), and the stale-sync sweep excludes deleted orgs. This
 * sweep closes that hole: for each deleted-but-subscribed org, cancel in Polar,
 * then clear the local subscription id through the single writer.
 *
 * The clear is applied as a `subscription_event` free-state write — a terminal
 * cancellation, targeting ONLY this org (subscription_event never does the
 * full-state sibling downgrade), so a customer that owns other live-subscribed
 * orgs under the same Polar customer is untouched.
 *
 * Failure semantics mirror reconcileBillingState: a Polar/Convex error reports
 * and LEAVES the org listed (it stays deleted-with-subscription, retried next
 * sweep) — a transient hiccup never silently abandons the cancel.
 */
export async function cancelDeletedOrgSubscriptions(input: {
  env: BillingEnv
  store?: BillingStore
  polar?: PolarClientLike
}): Promise<CancelDeletedResult> {
  const store = input.store ?? createBillingStore(input.env)
  const polar = input.polar ?? polarClientFromEnv(input.env)
  if (!polar) throw new Error("Polar access token is not configured (CLAXEDO_POLAR_ACCESS_TOKEN)")

  const deleted = await store.listDeletedWithSubscription()
  let canceled = 0
  let failed = 0
  for (const org of deleted) {
    try {
      // Same serial-loop hazard as reconcileBillingState above.
      await polar.subscriptions.revoke(
        { id: org.polar_subscription_id },
        { timeoutMs: POLAR_SWEEP_TIMEOUT_MS },
      )
      // Clear the local subscription id via the single writer (billing.ts
      // applyPolarState). Terminal cancel = free plan; subscription_event
      // source so only THIS org is touched.
      await store.applyPolarState({
        polar_customer_id: org.polar_customer_id,
        source_ts: Date.now(),
        source: "subscription_event",
        org_states: [{ org_id: org.org_id, state: { plan: "free", subscription_status: "canceled" } }],
      })
      canceled += 1
    } catch (err) {
      failed += 1
      reportPaymentError(err, {
        tags: { source: "billing_reconcile", reason: "deleted_org_cancel_failed" },
        extra: { orgId: org.org_id, polarSubscriptionId: org.polar_subscription_id },
      })
    }
  }
  return { deleted: deleted.length, canceled, failed }
}

/**
 * Cron-trigger entrypoint called from worker.ts `scheduled`. Deliberately
 * throw-free: the sandbox GC half of the shared cron must not be marked
 * failed by a billing hiccup (and vice versa the flag persists, so the next
 * run retries). Absent Polar/Convex billing config → clean no-op, so
 * deployments without billing (and worker.scheduled tests) are untouched.
 */
export async function runScheduledBillingReconciliation(env: BillingEnv): Promise<void> {
  if (!env.CLAXEDO_POLAR_ACCESS_TOKEN?.trim()) return
  try {
    await reconcileBillingState({ env })
  } catch (err) {
    reportPaymentError(err, { tags: { source: "billing_reconcile", reason: "sweep_failed" } })
  }
  // Independent try/catch: a stale-sync failure must not skip the deleted-org
  // cancel sweep (and vice versa) — the "bills forever" path is the costlier
  // one to starve.
  try {
    await cancelDeletedOrgSubscriptions({ env })
  } catch (err) {
    reportPaymentError(err, { tags: { source: "billing_reconcile", reason: "cancel_sweep_failed" } })
  }
}
