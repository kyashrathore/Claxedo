/**
 * D5 billing reconciliation sweep — Worker half (launch plan 012 D5/D13;
 * ADR 014 §3 "the failure mode webhooks alone can't cover"): Polar disables a
 * webhook endpoint after 10 consecutive failed deliveries, silently stopping
 * all future events. The Convex cron (convex/crons.ts) FLAGS orgs whose
 * mirror is stale; this sweep — driven by the same Cloudflare Cron Trigger as
 * the D13 reaper via worker.ts `scheduled` — fetches each flagged org's
 * current customer state from Polar and re-applies it through the single
 * writer (billing.applyPolarState), which clears the flag.
 *
 * Failure semantics (the load-bearing rule): Polar unreachable / errors →
 * reportPaymentError and LEAVE STATE AS IS. Only a successfully fetched FRESH
 * state ever downgrades an org; a reconciliation failure never does.
 */

import { reportPaymentError } from "../observability/report"
import { createBillingStore, type BillingStore } from "./billing-store"
import { customerStateToApplyArgs, type PolarProductConfig } from "./apply-polar-state"
import { polarClientFromEnv, polarProductConfig, type BillingEnv, type PolarClientLike } from "./billing-routes"

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
  for (const org of flagged) {
    try {
      const state = await polar.customers.getState({ id: org.polar_customer_id })
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
}
