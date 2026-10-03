import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { z } from "zod"
import { pluginManifestSchema } from "@claxedo/plugin-api/manifest"
import { AuthenticationError, type ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { activatePluginBackend, deactivatePluginBackend } from "../lifecycle"
import { pluginBackendRouteContribution } from "../routes"
import { pluginSupervisor, type PluginSupervisorNamespace } from "../supervisor.cf"

export { PluginSupervisor } from "../supervisor.cf"
export { PluginOutbound, PluginPlatform } from "../entrypoints.cf"

type Env = { CONTROL_PLANE_DB: D1Database; PLUGIN_SUPERVISOR: PluginSupervisorNamespace; DEPLOYMENT_ID: string }

const bearerClaims = z.object({ userId: z.string(), actorId: z.string(), subject: z.string() })

/**
 * The plugin-backend route over the real D1 authority. The identity provider
 * is the one stand-in: a bearer token is the base64url JSON of the user, actor
 * and better-auth subject a provider would have verified, and the authority
 * still checks them against its own identity rows before resolving an
 * organization.
 */
function principalFromBearer(request: Request, env: Env): ControlPlanePrincipal {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  const claims = token ? bearerClaims.safeParse(JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/")))) : undefined
  if (!claims?.success) throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
  const { userId, actorId, subject } = claims.data
  const origin = new URL(request.url).origin
  return {
    userId,
    actorId,
    actorKind: "human",
    deploymentId: env.DEPLOYMENT_ID,
    sessionId: `session:${subject}`,
    authenticatedAt: 1_800_000_000_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: origin, scopes: ["openid"], origin: "https://app.test" },
    identity: { adapter: "better-auth", issuer: "https://auth.test", subject },
  }
}

const activeInput = z.object({ orgId: z.string(), pluginId: z.string(), epoch: z.number() })
const activateInput = z.object({ orgId: z.string(), manifest: pluginManifestSchema, bundleHash: z.string(), changedBy: z.string(), now: z.number() })
const deactivateInput = z.object({ orgId: z.string(), pluginId: z.string(), changedBy: z.string(), now: z.number() })

/** The operator side of activation, which has no public route yet, and the supervisor's own epoch check. */
async function admin(request: Request, env: Env) {
  const url = new URL(request.url)
  const body: unknown = await request.json()
  const ports = { database: env.CONTROL_PLANE_DB, supervisors: env.PLUGIN_SUPERVISOR }
  if (url.pathname === "/__admin/active") {
    const input = activeInput.parse(body)
    return Response.json({ active: await pluginSupervisor(env.PLUGIN_SUPERVISOR, input.orgId).active(input) })
  }
  if (url.pathname === "/__admin/activate") await activatePluginBackend(ports, activateInput.parse(body))
  else await deactivatePluginBackend(ports, deactivateInput.parse(body))
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
      authentication: { ...testRequestAuthenticationAdapter(), authenticate: async (incoming) => principalFromBearer(incoming, env) },
      authority,
      supervisors: env.PLUGIN_SUPERVISOR,
    })
    return new Hono().route(contribution.path, contribution.routes).fetch(request, env)
  },
}
