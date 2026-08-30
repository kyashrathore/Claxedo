import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import type { ControlPlaneRouteAuthOptions } from "../../platform/http/control-plane-route-auth"

/** Host options for the app-facing OpenCode-shaped route family. */
export type OpenCodeCompatRouteOptions = ControlPlaneRouteAuthOptions & {
  env?: Record<string, string | undefined>
  services?: ControlPlaneServicesContract
}
