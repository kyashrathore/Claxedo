/**
 * Billing state store — the Worker's ONLY doorway to the Convex billing
 * mirror (convex/billing.ts). Everything here rides the same service-token
 * calling convention as the control-plane Convex adapter
 * (`authority/adapters/convex/`): service reads/writes carry
 * CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN; the checkout context call runs as the
 * END USER (bearer token) through a builder-gated authedMutation.
 *
 * Worker-safe: ConvexHttpClient is fetch-based; no node:* imports.
 */

import { cleanString as clean } from "@claxedo/server-core/platform/runtime/lib/strings"
import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { controlPlaneTimeoutMs, withTimeout } from "../authority/adapters/convex/timeout"
import type {
  ApplyPolarStateArgs,
  ApplyPolarStateResult,
  BillingStore,
  BillingStoreEnv,
  CheckoutContext,
  EntitlementState,
} from "./store-contract"

export type { BillingStore } from "./store-contract"

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
      return (await withTimeout(serviceClient().query(billingApi.billing.entitlementState as never, {
        service_token: serviceToken(),
        ...(ref.orgId ? { org_id: ref.orgId } : {}),
        ...(ref.clerkOrgId ? { clerk_org_id: ref.clerkOrgId } : {}),
      } as never), controlPlaneTimeoutMs("read", env))) as EntitlementState
    },
    async applyPolarState(args) {
      return (await withTimeout(serviceClient().mutation(billingApi.billing.applyPolarState as never, {
        service_token: serviceToken(),
        ...args,
      } as never), controlPlaneTimeoutMs("mutation", env))) as ApplyPolarStateResult
    },
    async checkoutContext(userToken, clerkOrgId) {
      const client = new ConvexHttpClient(url())
      client.setAuth(userToken)
      return (await withTimeout(client.mutation(billingApi.billing.checkoutContext as never, {
        ...(clerkOrgId ? { clerk_org_id: clerkOrgId } : {}),
      } as never), controlPlaneTimeoutMs("mutation", env))) as CheckoutContext
    },
    async listReconcileFlagged() {
      return (await withTimeout(serviceClient().query(billingApi.billing.listReconcileFlagged as never, {
        service_token: serviceToken(),
      } as never), controlPlaneTimeoutMs("read", env))) as Array<{ org_id: string; polar_customer_id: string }>
    },
    async listDeletedWithSubscription() {
      return (await withTimeout(serviceClient().query(billingApi.billing.listDeletedWithSubscription as never, {
        service_token: serviceToken(),
      } as never), controlPlaneTimeoutMs("read", env))) as Array<{ org_id: string; polar_customer_id: string; polar_subscription_id: string }>
    },
  }
}
