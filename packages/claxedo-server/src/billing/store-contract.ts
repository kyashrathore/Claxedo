/** Provider-neutral durable billing mirror owned by the Claxedo-hosted product. */
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

export type EntitlementStateRef = { orgId?: string; providerOrgId?: string }

export type EntitlementState =
  | { found: false }
  | {
      found: true
      org_id: string
      plan?: "free" | "pro"
      subscription_status?: string
      seats_licensed?: number
      member_count?: number
      current_period_end?: number
      billing_synced_at?: number
      polar_state_modified_at?: number
      past_due_since?: number
    }

export type CheckoutContext = {
  org_id: string
  provider_org_id?: string
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
  checkoutContext(userToken: string, providerOrgId?: string): Promise<CheckoutContext>
  listReconcileFlagged(): Promise<Array<{ org_id: string; polar_customer_id: string }>>
  listDeletedWithSubscription(): Promise<
    Array<{ org_id: string; polar_customer_id: string; polar_subscription_id: string }>
  >
}

export type BillingStoreEnv = Record<string, string | undefined>
