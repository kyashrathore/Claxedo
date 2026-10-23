import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { betterAuthD1WorkerEnv, workerDatabases, WORKER_ORIGIN, type WorkerDatabases } from "../../test-support/better-auth-d1-worker-env"
import { createBetterAuthD1Foundation } from "../../platform/auth/better-auth-d1-foundation"
import { resolveBetterAuthConfiguration } from "../../platform/auth/better-auth-configuration"
import { betterAuthNativeResource } from "../../platform/auth/better-auth-native-clients"
import { createHostedCoreApp } from "../hosted-shared/hosted-core-app"
import { composeHostedDocumentsPlugin } from "../../documents/compose"
import { composeBetterAuthD1AgentPlugins, stringEnvironment } from "./better-auth-d1-worker.agent-plugins.cf"
import { d1SessionStart, PRIMARY_READS } from "./better-auth-d1-worker.cf"
import { composeWithCloudSandbox } from "./full-hosted-sandbox"

vi.mock("cloudflare:workers", () => ({ DurableObject: Object, WorkerEntrypoint: Object }))

/**
 * The GET routes a signed browser may have answered by a read replica, each
 * reviewed: it writes nothing, or nothing a later replica read depends on.
 * A GET route that is neither here nor in `PRIMARY_READS` fails below, so a
 * new route is classified by someone who read what it writes.
 */
const REPLICA_READS: Readonly<Record<string, string>> = {
  "/api/claxedo/health": "static",
  "/api/claxedo/mode": "static",
  "/api/claxedo/compatibility": "static",
  "/api/claxedo/auth/descriptor": "static",
  "/global/health": "static",
  "/path": "static",
  "/api/claxedo/bootstrap": "static deployment block",
  "/.well-known/jwks.json": "keys from the environment",
  "/api/cp/events": "auth and the org, then the room's stream",
  "/api/claxedo/agent-config/providers": "catalog read",
  "/api/claxedo/agent-config/harness/options": "catalog read",
  "/api/claxedo/agent-config/providers/auth": "no database",
  "/api/claxedo/agent-config/harness": "relay read; its runtime token record is read only by the relay's resolver, on the writer",
  "/api/claxedo/agent-config/connections": "read",
  "/api/claxedo/agent-config": "read",
  "/api/claxedo/projects/:id/environment": "read",
  "/api/claxedo/credentials": "read",
  "/api/claxedo/credentials/effective": "read",
  "/api/claxedo/credentials/harness-models": "read",
  "/api/claxedo/credentials/account-sources": "read",
  "/api/claxedo/credentials/machine-logins": "read",
  "/api/claxedo/credentials/sandbox-drivers": "read",
  "/api/claxedo/credentials/:providerId": "read",
  "/provider/auth": "read",
  "/api/claxedo/auth/profile": "read; an invitation admission it makes is a guarded batch on the primary, and an owner claim goes to the writer",
  "/api/workspace": "read",
  "/api/workspace/shared-sessions": "read",
  "/api/workspace/resolve": "read",
  "/api/workspace/:id/connection": "lease read; the provisioner's notices carry the bookmark past its lease writes, and the token record it writes is read only by the relay's resolver, on the writer",
  "/api/workspace/:id/checkpoints": "relay read; token record as above",
  "/api/claxedo/host/enrollments": "read",
  "/api/claxedo/host/invitations": "read",
  "/api/claxedo/connect": "no database: the installer with this plane's URL",
  "/api/claxedo/connect.ps1": "no database: the installer with this plane's URL",
  "/api/claxedo/remote-access": "read",
  "/api/claxedo/remote-access/devices": "read; a machine's last-seen time is an observation",
  "/documents": "read",
  "/documents/statuses": "read",
  "/documents/:id": "read",
  "/documents/:id/shares": "read",
  "/documents/:id/availability": "read",
  "/documents/:id/git/snapshot": "read",
  "/documents/:id/content": "read",
  "/documents/:id/snapshots": "read",
  "/documents/:id/export": "read",
  "/p/:token": "public read",
  "/api/control/sessions": "read",
  "/api/control/session-list": "read; a status notice's bookmark covers the row it announces",
  "/api/control/sessions/:sessionId/gateway": "read",
  "/api/control/sessions/:sessionId/messages": "read",
  "/api/control/sessions/:sessionId/outline": "read",
  "/api/control/sessions/:sessionId/page": "read",
  "/api/control/sessions/:sessionId/part": "read",
  "/api/control/sessions/:sessionId/shares": "read",
  "/api/control/orgs": "read",
  "/api/control/orgs/:orgId/teams": "read",
  "/api/control/orgs/:orgId/members": "read",
  "/api/control/orgs/:orgId/invitations": "read",
  "/api/control/teams/:teamId/members": "read",
  "/api/control/teams/:teamId/projects": "read",
  "/api/control/projects/:projectId/access": "read",
  "/api/claxedo/usage": "read",
  "/api/claxedo/usage/cloud-facts": "read",
  "/api/claxedo/usage/credentials": "read",
  "/api/claxedo/usage/machine-time": "read",
  "/api/claxedo/integrations": "connection list",
  "/api/claxedo/plugins": "catalog read",
  "/api/claxedo/plugins/refresh": "catalog read from the sources",
  "/api/claxedo/plugins/oauth/client-metadata.json": "static",
  "/api/claxedo/plugins/runtime/self": "the gateway passes it records are read by the gateway, on the writer",
  "/api/claxedo/plugins/projects/:projectId": "catalog read",
  "/api/claxedo/plugins/projects/:projectId/refresh": "catalog read",
  "/api/claxedo/plugins/:pluginInstanceId/skills/:skill": "read",
  "/api/claxedo/plugins/projects/:projectId/:pluginInstanceId/skills/:skill": "read",
  "/api/claxedo/plugins/sources": "read",
  "/api/claxedo/tasks/capabilities": "read",
  "/api/claxedo/tasks/presets": "read",
  "/api/claxedo/tasks/presets/:presetId": "read",
  "/api/claxedo/tasks/tasks": "read",
  "/api/claxedo/tasks/tasks/:taskId": "read",
  "/api/claxedo/tasks/tasks/:taskId/children": "read",
  "/api/claxedo/tasks/tasks/:taskId/attachments/:attachmentId": "read",
  "/api/plugins/:pluginId/*": "plugin backend; its supervisor reads on the bare binding, the primary",
  "/api/auth/get-session": "read; the expiry it extends is not read back",
  "/api/auth/list-sessions": "read",
  "/api/auth/list-accounts": "read",
  "/api/auth/account-info": "read",
  "/api/auth/ok": "static",
  "/api/auth/error": "static",
  "/api/auth/oauth2/userinfo": "bearer read",
  "/api/auth/oauth2/public-client": "read",
  "/api/auth/oauth2/get-consent": "read",
  "/api/auth/oauth2/get-consents": "read",
  "/api/auth/oauth2/get-client": "read",
  "/api/auth/oauth2/get-clients": "read",
  "/api/auth/.well-known/openid-configuration": "static",
  "/api/auth/.well-known/oauth-authorization-server": "static",
  "/api/auth/admin/oauth2/resources": "read",
  "/api/auth/admin/oauth2/resources/:identifier": "read",
}

let databases: WorkerDatabases
let routes: string[]

/** A sample request path for a route pattern: every parameter and wildcard filled. */
function sample(pattern: string) {
  return pattern.replace(/:[A-Za-z]+/g, "x").replace(/\*$/, "x")
}

function routeIn(list: readonly string[], pattern: string) {
  const path = sample(pattern)
  return list.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
}

beforeAll(async () => {
  databases = await workerDatabases()
  const env = betterAuthD1WorkerEnv(databases, {
    CLAXEDO_SANDBOX_POSTURE: "full-hosted",
    CLAXEDO_AUTH_METHODS: "github,email-password",
    CLAXEDO_EMAIL_FROM: "auth@example.test",
    EMAIL: { send: async () => ({ messageId: "m" }) },
    CLAXEDO_CREDENTIALS_KEK: Buffer.alloc(32, 7).toString("base64"),
    CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
    CLAXEDO_SANDBOX_IMAGE: "ghcr.io/claxedo/claxedo-sandbox:test",
    CLAXEDO_PUBLIC_URL: WORKER_ORIGIN,
    CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL: "https://gateway.example.test/",
    PLUGIN_SUPERVISOR: { idFromName: (name: string) => name, get: () => ({}) },
    CLAXEDO_AGENT_PLUGINS: { get: async () => null, put: async () => null },
  })
  const room = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ delivered: 0, held: 0 }) }) }
  const composed = composeWithCloudSandbox(
    { database: databases.controlPlaneDatabase, signingEnv: {}, provisioner: { idFromName: (name: string) => name, get: () => ({}) as never }, keyDrivers: { drivers: [], create: () => undefined }, room },
    (extra) => composeBetterAuthD1AgentPlugins(env, extra),
  )
  await composed.authReady
  const documents = composeHostedDocumentsPlugin({
    bucket: { get: async () => null, put: async () => null, delete: async () => undefined, list: async () => ({ objects: [] }) } as never,
    plane: composed.plane,
    access: composed.documentAccess,
    authentication: composed.options.authentication,
    rateLimit: async () => true,
  })
  const app = createHostedCoreApp(composed.plane, {
    ...composed.options,
    plugins: [documents, ...(composed.options.plugins ?? [])],
    idempotency: {} as never,
    liveSyncRoom: room,
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
  })
  const core = app.routes.filter((route) => (route.method === "GET" || route.method === "ALL") && !route.path.endsWith("/*") || route.path === "/api/plugins/:pluginId/*")
    .map((route) => route.path)
  const foundation = createBetterAuthD1Foundation({
    database: databases.authDatabase,
    configuration: resolveBetterAuthConfiguration({ env: stringEnvironment(env), emailSender: { send: async () => undefined } }),
    resource: betterAuthNativeResource(WORKER_ORIGIN),
  })
  await foundation.$context
  const auth = Object.values(foundation.api as Record<string, { path?: string; options?: { method?: string | string[] } }>)
    .filter((endpoint) => endpoint.path && [endpoint.options?.method].flat().some((method) => method === "GET" || method === "*"))
    .map((endpoint) => `/api/auth${endpoint.path}`)
  routes = [...new Set([...core, ...auth])].toSorted()
}, 60_000)

afterAll(async () => {
  await databases?.dispose()
})

test("every GET route the Worker serves is either reviewed as a replica read or runs on the writer", () => {
  expect(routes.length).toBeGreaterThan(80)
  const unclassified = routes.filter((route) => !routeIn(PRIMARY_READS, route) && !(route in REPLICA_READS))
  expect(unclassified).toEqual([])
  const reviewedTwice = routes.filter((route) => routeIn(PRIMARY_READS, route) && route in REPLICA_READS)
  expect(reviewedTwice).toEqual([])
  expect(Object.keys(REPLICA_READS).filter((route) => !routes.includes(route))).toEqual([])
})

test("a signed browser's GET starts where its classification says, and so does the same route on a bearer token or with no credential", () => {
  const signed = { cookie: "__Secure-claxedo.session_token=token" }
  for (const route of routes) {
    const url = `${WORKER_ORIGIN}${sample(route)}`
    const onWriter = routeIn(PRIMARY_READS, route)
    expect(d1SessionStart(new Request(url, { headers: signed })), route).toBe(onWriter ? "primary" : "replica")
    if (!onWriter) {
      expect(d1SessionStart(new Request(url, { headers: { authorization: "Bearer machine" } })), route).toBe("primary")
      expect(d1SessionStart(new Request(url)), route).toBe("replica")
    }
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    expect(d1SessionStart(new Request(`${WORKER_ORIGIN}/api/workspace`, { method, headers: signed }))).toBe("primary")
  }
})
