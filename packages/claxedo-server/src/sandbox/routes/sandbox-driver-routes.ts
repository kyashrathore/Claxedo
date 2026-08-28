import {
  SandboxDriverSettingsRoutes,
  type SandboxDriverSettingsRouteOptions,
} from "@claxedo/server-core/sandbox/routes/sandbox-driver-settings-routes"
import {
  defaultControlPlaneCredentials,
  type ControlPlaneServices,
} from "../../authority/services"
import {
  signedAccessOptions,
  signedOrError,
  type WorkspaceRouteOptions,
} from "../../workspace/route-support"

export function sandboxDriverRoutes(
  services?: ControlPlaneServices,
  options: WorkspaceRouteOptions = {},
) {
  const routeOptions: SandboxDriverSettingsRouteOptions = {
    credentials: sandboxDriverCredentials(options, services),
    ...(options.authConfig ? { authConfig: options.authConfig } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    authorizeRead: async (request) => {
      const gate = await signedOrError(request, signedAccessOptions(request, options), services)
      if (!("error" in gate)) return
      return Response.json(gate.error, { status: gate.status })
    },
  }
  return SandboxDriverSettingsRoutes(routeOptions)
}

export function sandboxDriverCredentials(
  options: WorkspaceRouteOptions,
  services?: ControlPlaneServices,
) {
  return options.credentials ?? services?.credentials ?? defaultControlPlaneCredentials()
}
