import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { z } from "zod"
import { pluginSupervisor, type PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import { AuthenticationError, type ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { AppPluginsBucket } from "../bundles"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { hostedOrgAdministers } from "../../credentials/worker/org-administers"
import type { LiveSyncRoomNamespace } from "../../platform/http/live-sync-publish"
import { hostedSessionFixture } from "../../test-support/hosted-session-fixture"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { hostedAppPluginRoutes } from "../compose"
import { registryKeysWithTestKey } from "../registry-test-key"
import { composeHostedSessionPorts, type HostedSessionPorts } from "../sessions/compose"
import { hostedPluginSupervisorClass, type HostedPluginBackendEnv } from "../supervisor.cf"

export { PluginOutbound, PluginPlatform } from "@claxedo/plugin-runtime/entrypoints"

type Env = {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_AGENT_PLUGINS: AppPluginsBucket
  PLUGIN_SUPERVISOR: PluginSupervisorNamespace
  LIVE_SYNC_ROOM: LiveSyncRoomNamespace
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

/** Stands in for `LiveSyncRoom`: it records every nudge a publisher sends it, for the test to read. */
export class RecordingRoom {
  constructor(private readonly state: { storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } }) {}

  async fetch(request: Request): Promise<Response> {
    const stored = await this.state.storage.get("events")
    const recorded = Array.isArray(stored) ? stored : []
    if (new URL(request.url).pathname !== "/nudge") return Response.json(recorded)
    const nudged: unknown = await request.json()
    await this.state.storage.put("events", [...recorded, ...(Array.isArray(nudged) ? nudged : [nudged])])
    return Response.json({ delivered: 0, held: 0 })
  }
}

let sessionFixture: ReturnType<typeof hostedSessionFixture> | undefined
let sessionPorts: HostedSessionPorts | undefined

/**
 * One session fixture per isolate, shared by the supervisor's session host and
 * the hooks the fake runtime calls back through, as the deployed Worker shares
 * one composition between its routes and its supervisor.
 */
function sessions(env: Env) {
  sessionFixture ??= hostedSessionFixture(env.CONTROL_PLANE_DB, env.DEPLOYMENT_ID)
  sessionPorts ??= composeHostedSessionPorts({ services: sessionFixture.services, database: env.CONTROL_PLANE_DB, sandboxStart: sessionFixture.starts.start })
  return { fixture: sessionFixture, ports: sessionPorts }
}

export class PluginSupervisor extends hostedPluginSupervisorClass((env: Env & HostedPluginBackendEnv) => sessions(env).ports) {}

const workspaceInput = z.object({ workspaceId: z.string(), repoUrl: z.string() })

/** Files a cloud workspace in the caller's own organization's project, as `POST /api/workspace/create` would. */
async function createWorkspace(request: Request, env: Env) {
  const principal = principalFromBearer(request, env)
  const input = workspaceInput.parse(await request.json())
  const auth = {
    mode: "signed" as const,
    token: "fixture",
    user: { subject: principal.userId, tokenIdentifier: `https://auth.test|${principal.identity?.subject ?? principal.userId}`, issuer: "https://auth.test" },
    principal,
  }
  const { authority } = sessions(env).fixture
  await authority.createCloudWorkspace(auth, {
    workspaceId: input.workspaceId,
    displayName: input.workspaceId,
    repoUrl: input.repoUrl,
    gitBranch: "main",
    remoteDirectory: "/workspace",
    homeRegion: "us-east",
  })
  const row = await env.CONTROL_PLANE_DB.prepare("select project_id from workspaces where workspace_id = ?").bind(input.workspaceId).first<{ project_id: string }>()
  return Response.json({ projectId: row?.project_id })
}

const activeInput = z.object({ orgId: z.string(), pluginId: z.string(), epoch: z.number() })
const wakeInput = z.object({ orgId: z.string(), pluginId: z.string(), now: z.number() })

/**
 * The supervisor's own answers no public route exposes: whether an epoch is
 * current, the wakes due at a later time than the clock's, and what a room
 * was nudged with; and the session fixture's, which the fake runtime calls.
 */
async function supervisorHook(request: Request, env: Env) {
  const path = new URL(request.url).pathname
  if (path === "/__workspace") return createWorkspace(request, env)
  if (path !== "/__supervisor/active" && path !== "/__supervisor/wake-due" && path !== "/__room") return sessions(env).fixture.hooks.fetch(request)
  if (path === "/__room") {
    const name = new URL(request.url).searchParams.get("name") ?? ""
    return env.LIVE_SYNC_ROOM.get(env.LIVE_SYNC_ROOM.idFromName(name)).fetch(new Request("https://room.test/events"))
  }
  if (path === "/__supervisor/wake-due") {
    const input = wakeInput.parse(await request.json())
    return Response.json({ delivered: await pluginSupervisor(env.PLUGIN_SUPERVISOR, input).wakeDue(input, input.now) })
  }
  const input = activeInput.parse(await request.json())
  return Response.json({ active: await pluginSupervisor(env.PLUGIN_SUPERVISOR, input).active(input) })
}

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith("/__")) return supervisorHook(request, env)
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
