/**
 * Billing state store — the Worker's ONLY doorway to the Convex billing
 * mirror (convex/billing.ts). Everything here rides the same service-token
 * calling convention as the control-plane Convex adapter
 * (`control-plane/adapters/convex/`): service reads/writes carry
 * CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN; the checkout context call runs as the
 * END USER (bearer token) through a builder-gated authedMutation.
 *
 * Worker-safe: ConvexHttpClient is fetch-based; no node:* imports.
 */

import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"

export class BillingStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BillingStoreUnavailableError"
  }
}

type BillingApi = {
  billing: {
    applyPolarState: FunctionReference<"mutation">
    entitlementState: FunctionReference<"query">
    checkoutContext: FunctionReference<"mutation">
    listReconcileFlagged: FunctionReference<"query">
    listDeletedWithSubscription: FunctionReference<"query">
  }
}

const billingApi = anyApi as unknown as BillingApi

export type OrgBillingStateWrite = {
  plan: "free" | "pro"
  subscription_status?: string
  polar_subscription_id?: string
  seats_licensed?: number
  current_period_end?: number
  preserve_seats?: boolean
}

export type ApplyPolarStateArgs = {
  polar_customer_id: string
  source_ts: number
  source: "customer_state" | "subscription_event" | "reconciliation"
  org_states: Array<{ org_id?: string; state: OrgBillingStateWrite }>
}

export type ApplyPolarStateResult = {
  results: Array<{ org_id: string; applied: boolean; reason?: string }>
  unresolved: string[]
}

export type EntitlementStateRef = { orgId?: string; clerkOrgId?: string }

export type EntitlementState =
  | { found: false }
  | {
      found: true
      org_id: string
      plan?: "free" | "pro"
      subscription_status?: string
      seats_licensed?: number
      current_period_end?: number
      billing_synced_at?: number
      polar_state_modified_at?: number
      /** F11: wall-clock of the FIRST past_due transition — the grace anchor. */
      past_due_since?: number
    }

export type CheckoutContext = {
  org_id: string
  clerk_org_id?: string
  role?: string
  member_count: number
  plan?: "free" | "pro"
  subscription_status?: string
  seats_licensed?: number
  polar_customer_id?: string
}

export type BillingStore = {
  entitlementState(ref: EntitlementStateRef): Promise<EntitlementState>
  applyPolarState(args: ApplyPolarStateArgs): Promise<ApplyPolarStateResult>
  checkoutContext(userToken: string, clerkOrgId?: string): Promise<CheckoutContext>
  listReconcileFlagged(): Promise<Array<{ org_id: string; polar_customer_id: string }>>
  listDeletedWithSubscription(): Promise<
    Array<{ org_id: string; polar_customer_id: string; polar_subscription_id: string }>
  >
}

export type BillingStoreEnv = Record<string, string | undefined>

function clean(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Convex-backed store. Construction never touches the network; missing config
 * fails CLOSED at call time (I-4: an unreadable billing state is the free
 * tier for entitlement callers, a 503 for billing routes — never fail open).
 */
export function createBillingStore(env: BillingStoreEnv): BillingStore {
  const url = () => {
    const value = clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
    if (!value) throw new BillingStoreUnavailableError("CLAXEDO_WORKSPACE_AUTHORITY_URL is not configured")
    return value
  }
  const serviceToken = () => {
    const value = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
    if (!value) throw new BillingStoreUnavailableError("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN is not configured")
    return value
  }
  const serviceClient = () => new ConvexHttpClient(url())

  return {
    async entitlementState(ref) {
      return (await serviceClient().query(billingApi.billing.entitlementState as never, {
        service_token: serviceToken(),
        ...(ref.orgId ? { org_id: ref.orgId } : {}),
        ...(ref.clerkOrgId ? { clerk_org_id: ref.clerkOrgId } : {}),
      } as never)) as EntitlementState
    },
    async applyPolarState(args) {
      return (await serviceClient().mutation(billingApi.billing.applyPolarState as never, {
        service_token: serviceToken(),
        ...args,
      } as never)) as ApplyPolarStateResult
    },
    async checkoutContext(userToken, clerkOrgId) {
      const client = new ConvexHttpClient(url())
      client.setAuth(userToken)
      return (await client.mutation(billingApi.billing.checkoutContext as never, {
        ...(clerkOrgId ? { clerk_org_id: clerkOrgId } : {}),
      } as never)) as CheckoutContext
    },
    async listReconcileFlagged() {
      return (await serviceClient().query(billingApi.billing.listReconcileFlagged as never, {
        service_token: serviceToken(),
      } as never)) as Array<{ org_id: string; polar_customer_id: string }>
    },
    async listDeletedWithSubscription() {
      return (await serviceClient().query(billingApi.billing.listDeletedWithSubscription as never, {
        service_token: serviceToken(),
      } as never)) as Array<{ org_id: string; polar_customer_id: string; polar_subscription_id: string }>
    },
  }
}
