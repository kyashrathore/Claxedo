import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { z } from "zod"
import { pluginSupervisor, type PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import { AuthenticationError, type ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { AgentPluginR2Bucket } from "../../agent-plugins/artifacts/r2-artifact-adapter"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { hostedOrgAdministers } from "../../credentials/worker/org-administers"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { hostedAppPluginRoutes } from "../compose"
import { registryKeysWithTestKey } from "../registry-test-key"

export { PluginSupervisor } from "../supervisor.cf"
export { PluginOutbound, PluginPlatform } from "@claxedo/plugin-runtime/entrypoints"

type Env = {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_AGENT_PLUGINS: AgentPluginR2Bucket
  PLUGIN_SUPERVISOR: PluginSupervisorNamespace
  DEPLOYMENT_ID: string
  CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY: string
}

const FIXTURE_REGISTRY_URL = "https://registry.test"

const bearerClaims = z.object({ userId: z.string(), actorId: z.string(), subject: z.string() })

/**
 * The app-plugin routes over the real D1 authority, the R2 bucket and the
 * supervisor, as the Agent Plugins entry composes them. The identity provider
 * is the one stand-in: a bearer token is the base64url JSON of the user, actor
 * and better-auth subject a provider would have verified, and the authority
 * still checks them against its own identity rows before resolving an
 * organization. The registry's keys add the test key.
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

/** The supervisor's own answer to whether an epoch is current, which no public route exposes. */
async function epochActive(request: Request, env: Env) {
  const input = activeInput.parse(await request.json())
  return Response.json({ active: await pluginSupervisor(env.PLUGIN_SUPERVISOR, input).active(input) })
}

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/__supervisor/active") return epochActive(request, env)
    const authority = new D1WorkspaceAuthority(env.CONTROL_PLANE_DB, {
      deploymentId: env.DEPLOYMENT_ID,
      product: { kind: "claxedo-hosted" },
    })
    const app = new Hono()
    const contributions = hostedAppPluginRoutes({
      authentication: { ...testRequestAuthenticationAdapter(), authenticate: async (incoming) => principalFromBearer(incoming, env) },
      authority,
      database: env.CONTROL_PLANE_DB,
      bucket: env.CLAXEDO_AGENT_PLUGINS,
      supervisors: env.PLUGIN_SUPERVISOR,
      administers: hostedOrgAdministers(env.CONTROL_PLANE_DB),
      registry: { url: FIXTURE_REGISTRY_URL, keys: registryKeysWithTestKey(env), fetch: (url) => fetch(url) },
    })
    for (const contribution of contributions) app.route(contribution.path, contribution.routes)
    return app.fetch(request, env)
  },
}
