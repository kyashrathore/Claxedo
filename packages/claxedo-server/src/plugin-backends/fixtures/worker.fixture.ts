import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { AuthenticationError, type ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { activatePluginBackend, deactivatePluginBackend } from "../lifecycle"
import { pluginBackendRouteContribution } from "../routes"
import { pluginSupervisor, type PluginSupervisorNamespace } from "../supervisor.cf"

export { PluginSupervisor } from "../supervisor.cf"
export { PluginOutbound, PluginPlatform } from "../entrypoints.cf"

type Env = { CONTROL_PLANE_DB: D1Database; PLUGIN_SUPERVISOR: PluginSupervisorNamespace; DEPLOYMENT_ID: string }

/**
 * The plugin-backend route over the real D1 authority. The identity provider
 * is the one stand-in: a bearer token is the base64url JSON of the principal
 * a provider would have verified, and the authority still checks it against
 * its own identity rows before resolving an organization.
 */
function principalFromBearer(request: Request): ControlPlanePrincipal {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!token) throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
  return JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/"))) as ControlPlanePrincipal
}

/** The operator side of activation, which has no public route yet, and the supervisor's own generation check. */
async function admin(request: Request, env: Env) {
  const url = new URL(request.url)
  const input = (await request.json()) as Parameters<typeof activatePluginBackend>[1] & { pluginId: string; generation: string }
  const ports = { database: env.CONTROL_PLANE_DB, supervisors: env.PLUGIN_SUPERVISOR }
  if (url.pathname === "/__admin/active") return Response.json({ active: await pluginSupervisor(env.PLUGIN_SUPERVISOR, input.orgId).active(input) })
  if (url.pathname === "/__admin/activate") await activatePluginBackend(ports, input)
  else await deactivatePluginBackend(ports, input.orgId, input.pluginId)
  return new Response(null, { status: 204 })
}

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith("/__admin/")) return admin(request, env)
    const authority = new D1WorkspaceAuthority(env.CONTROL_PLANE_DB, {
      deploymentId: env.DEPLOYMENT_ID,
      product: { kind: "claxedo-hosted" },
    })
    const contribution = pluginBackendRouteContribution({
      authentication: { ...testRequestAuthenticationAdapter(), authenticate: async (incoming) => principalFromBearer(incoming) },
      authority,
      supervisors: env.PLUGIN_SUPERVISOR,
    })
    return new Hono().route(contribution.path, contribution.routes).fetch(request, env)
  },
}
