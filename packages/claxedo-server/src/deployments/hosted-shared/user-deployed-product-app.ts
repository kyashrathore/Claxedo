import type { HostedControlPlane } from "../../authority/hosted-services"
import { createHostedCoreApp, type HostedCoreAppOptions } from "./hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"

export type UserDeployedProductAppOptions = Omit<
  HostedCoreAppOptions,
  "product" | "productWorkspace" | "requestGuardExemptions"
>

/**
 * Static one-org multiplayer product root. It has no product extension hook:
 * Claxedo billing cannot enter this artifact through configuration or secrets.
 */
export function createUserDeployedProductApp(
  plane: HostedControlPlane,
  options: UserDeployedProductAppOptions,
) {
  return createHostedCoreApp(plane, {
    ...options,
    product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
    requestGuardExemptions: [],
  })
}
