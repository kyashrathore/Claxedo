import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
} from "@claxedo/server-core/platform/auth/auth"

import type { HostedControlPlane } from "../../authority/hosted-services"
import {
  BILLING_WEBHOOK_GUARD_EXEMPTION,
  BillingRoutes,
  type BillingRouteOptions,
} from "../../billing/routes"
import { createEntitlementGate, type EntitlementGate } from "../../billing/entitlement"
import type { BillingStore } from "../../billing/store-contract"
import {
  createHostedCoreApp,
  type HostedCoreAppOptions,
  type HostedCoreProductWorkspaceOptions,
} from "./hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"

type BillingOverrides = Omit<BillingRouteOptions, "env" | "authentication" | "authConfig" | "verifier" | "store">

export type ClaxedoHostedProductAppOptions = Omit<
  HostedCoreAppOptions,
  "cloudWorkspaceAdmission" | "product" | "productWorkspace" | "requestGuardExemptions"
> & {
  billingStore: BillingStore
  entitlementGate?: EntitlementGate
  billing?: BillingOverrides
  productWorkspace?: HostedCoreProductWorkspaceOptions
}

/** Multi-org multiplayer product root with explicit Polar billing ownership. */
export function createClaxedoHostedProductApp(
  plane: HostedControlPlane,
  options: ClaxedoHostedProductAppOptions,
) {
  const { billingStore, entitlementGate: suppliedGate, billing, productWorkspace, ...core } = options
  const entitlementGate = suppliedGate ?? createEntitlementGate({ env: plane.env, store: billingStore })
  const requireCloudWorkspaceEntitlement: HostedCoreAppOptions["cloudWorkspaceAdmission"] = async (auth) => {
    const authority = plane.services.authority
    if (!authority) {
      return {
        status: 503,
        body: { error: { code: "workspace_authority_unavailable", message: "Workspace authority is not configured" } },
      }
    }
    try {
      return await entitlementGate({ orgId: await authority.resolveOrgId(auth) }, "cloud-workspace")
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return { status: error.status, body: controlPlaneAuthErrorBody(error) }
      }
      throw error
    }
  }

  const app = createHostedCoreApp(plane, {
    ...core,
    cloudWorkspaceAdmission: requireCloudWorkspaceEntitlement,
    product: STATIC_PRODUCT_DESCRIPTORS["claxedo-hosted"],
    requestGuardExemptions: [BILLING_WEBHOOK_GUARD_EXEMPTION],
    ...(productWorkspace ? { productWorkspace } : {}),
  })
  app.route(
    "/api/billing",
    BillingRoutes({
      ...(billing ?? {}),
      env: plane.env,
      store: billingStore,
      authentication: core.authentication,
    }),
  )
  return app
}
