import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from "jose"
import { PI_LAUNCH_PROVIDERS } from "@claxedo/agent-runtime-contract"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

import { coreAppHomeOrigin, createHostedCoreApp } from "./hosted-core-app"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { createInMemoryCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { hostedOrgCredentials } from "../../credentials/worker"
import { miniflareControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { fetchUrl } from "../../test-support/fetch-calls"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"
import type { McpClientInputs } from "@claxedo/mcp"

const ROOT = path.resolve(import.meta.dirname, "../../..")

function plane(): HostedControlPlane {
  const sessionAuthority = {
    reserveSession: vi.fn(async (_auth: unknown, input: Record<string, unknown>) => ({ ...input, changed: true, state: "reserved" })),
    registerRuntimeSession: vi.fn(async () => ({})),
    markSessionRegistrationAmbiguous: vi.fn(async () => ({})),
    beginSessionCompensation: vi.fn(async () => ({})),
    completeSessionCompensation: vi.fn(async () => ({})),
    authorizeRuntimeSession: vi.fn(async () => undefined),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
  }
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
      verifier: vi.fn(async (token: string) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: `issuer|${token}`, issuer: "https://issuer.test" },
      })),
    },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async () => "org-1"),
      usersMe: vi.fn(async () => ({ id: "user-1", user_id: "user-1" })),
      listOrgs: vi.fn(async () => [{ org_id: "org-1", name: "Test organization" }]),
      listSessionShares: vi.fn(async () => [{ grant_id: "share-1", granted_to_user_id: "user-2" }]),
      listWorkspaces: vi.fn(async () => []),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { backing: "cloud-vm", home_region: "us-east" },
      })),
      auditAllow: vi.fn(async () => ({})),
      auditDeny: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    cliSessionTokenRegistry: createInMemoryCliSessionTokenRegistry(),
    privateSessionAuthority: sessionAuthority,
    runtimeSessionAuthority: sessionAuthority,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
  } as unknown as HostedControlPlane
}

const options = {
  authentication: testRequestAuthenticationAdapter(),
  liveSyncRoom: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
  },
  sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
  serviceCatalog: async () => [],
  cloudWorkspaceAdmission: async () => ({
    status: 403 as const,
    body: { error: { code: "cloud_workspace_capability_unavailable", message: "Capability unavailable" } },
  }),
  product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
  requestGuardExemptions: [],
  userDeployedIdentityAdmission: {
    admit: vi.fn(async (_auth, input) => ({
      state: "active" as const,
      userId: `user:${input.identity.subject}`,
      actorId: `actor:${input.identity.subject}`,
    })),
  },
}

describe("cloud-workspace admission", () => {
  test("the core app puts the composed admission hook in front of every hosted wake", async () => {
    // The gate is enforced at wake, not at create, and it only reaches that
    // choke point if this composition passes it through to the workspace
    // routes. A hosted core that dropped it wakes a cancelled subscription.
    const admitted: string[] = []
    const app = createHostedCoreApp(plane(), {
      ...options,
      cloudWorkspaceAdmission: async (tenant) => {
        admitted.push(tenant.auth?.user.subject ?? "")
        return {
          status: 402 as const,
          body: { error: { code: "billing_entitlement_required", message: "subscription required" } },
        }
      },
    }) as unknown as Hono

    const response = await app.request("/api/workspace/ws_1/connection", {
      headers: { authorization: "Bearer alice", "content-type": "application/json" },
    })

    expect(response.status).toBe(402)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "billing_entitlement_required" } })
    expect(admitted).toEqual(["alice"])
  })
})

describe("deployment posture on the deployed central", () => {
  // The app reads this before its first render, with nobody signed in, to learn
  // whether it must gate at all. Asserted through the composed app rather than
  // the route alone because everything in front of the route decides whether an
  // anonymous caller ever reaches it — the unsigned-local gate and the default
  // request guard both run first.
  test("an anonymous browser reads the posture it has to satisfy", async () => {
    const app = createHostedCoreApp(plane(), options) as unknown as Hono

    const response = await app.request("/api/claxedo/bootstrap")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ deployment: { issuesSessions: true } })
  })

  // This composition builds its own `enabled: true` auth config, so there is no
  // misconfigured hosted central that serves a declaration: it either has auth
  // or it never composes.
  test("carries nothing that belongs to a machine", async () => {
    const app = createHostedCoreApp(plane(), options) as unknown as Hono

    const body = (await (await app.request("/api/claxedo/bootstrap")).json()) as Record<string, unknown>

    expect(body.events).toEqual({ hostAggregate: false })
    expect(body.host).toBeUndefined()
    expect(body.path).toBeUndefined()
  })
})

describe("hosted production Pi and connection discovery", () => {
  const catalogPath = "/api/claxedo/agent-config/providers?nativeHarness=pi"
  const headers = (subject = "alice") => ({ authorization: `Bearer ${subject}`, "content-type": "application/json" })

  test("credentials disabled still exposes canonical disconnected providers, defers models to the runtime, and refuses writes", async () => {
    const app = createHostedCoreApp(plane(), options) as unknown as Hono
    expect((await app.request(catalogPath)).status).toBe(401)
    const response = await app.request(catalogPath, { headers: headers() })
    expect(response.status).toBe(200)
    const catalog = await response.json()
    // The canonical list, not a copy of it: a provider Pi can be launched on is
    // one the harness writes an overlay for and the broker has a destination
    // for, and both of those are decided in `PI_LAUNCH_PROVIDERS`.
    expect(catalog.all.map((provider: { id: string }) => provider.id).sort())
      .toEqual([...PI_LAUNCH_PROVIDERS].sort())
    expect(catalog.all.every((provider: { models: object }) => Object.keys(provider.models).length === 0)).toBe(true)
    expect(catalog.modelAvailability).toBe("runtime_required")
    expect(catalog.connected).toEqual([])
    expect((await app.request("/auth/openai?harness=pi", { method: "PUT", headers: headers(), body: JSON.stringify({ auth: { key: "secret" } }) })).status).toBe(503)
    const connections = "/api/claxedo/agent-config/connections"
    expect((await app.request(connections)).status).toBe(401)
    expect(await (await app.request(connections, { headers: headers() })).json()).toEqual({ status: "unsupported", reason: "operator_local_configuration" })
    expect((await app.request("/api/claxedo/agent-config/harness/acp-connections", { headers: headers() })).status).toBe(404)
  })

  test("enabled catalog and mutations use authority orgs and encrypted credentials; failures remain errors", async () => {
    const base = plane()
    base.env = { ...base.env, CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1", CLAXEDO_CREDENTIALS_KEK: Buffer.alloc(32, 3).toString("base64") }
    base.services.authority!.resolveOrgId = vi.fn(async (auth) => `internal-${auth.user.subject}` as never)
    const controlPlane = await miniflareControlPlaneDatabase(["0039_hosted_provider_credentials.sql"])
    let broken = false
    base.orgCredentials = (orgId) => {
      if (broken) throw new Error("CONTROL_PLANE_DB unavailable")
      return hostedOrgCredentials(orgId, { database: controlPlane.database, env: base.env })
    }
    try {
      const app = createHostedCoreApp(base, options) as unknown as Hono
      const connected = async (subject: string) => (await (await app.request(catalogPath, { headers: headers(subject) })).json()).connected
      expect((await app.request("/auth/openai?harness=pi&orgId=internal-bob", { method: "PUT", headers: headers(), body: JSON.stringify({ auth: { key: "alice-key" } }) })).status).toBe(200)
      expect(await connected("alice")).toEqual(["openai"])
      expect(await connected("bob")).toEqual([])
      const credentials = hostedOrgCredentials("internal-alice", { database: controlPlane.database, env: base.env })
      await credentials.putCredential({ provider_id: "codex-app-server", kind: "oauth_token", source: "managed", secret: "oauth-secret" })
      expect((await connected("alice")).sort()).toEqual(["openai", "openai-codex"])
      expect((await app.request("/auth/openai-codex?harness=pi", { method: "PUT", headers: headers(), body: JSON.stringify({ auth: { key: "not-oauth" } }) })).status).toBe(400)
      await credentials.updateCredentialStatus("codex-app-server", "revoked")
      expect(await connected("alice")).toEqual(["openai"])
      expect((await app.request("/auth/openai?harness=pi", { method: "DELETE", headers: headers("bob") })).status).toBe(200)
      expect(await connected("alice")).toEqual(["openai"])
      expect((await app.request("/auth/openai?harness=pi", { method: "DELETE", headers: headers() })).status).toBe(200)
      expect(await connected("alice")).toEqual([])
      const stored = await controlPlane.database
        .prepare("select org_id, secret_envelope from hosted_provider_credentials")
        .all<{ org_id: string; secret_envelope: string }>()
      expect(stored.results.map((row) => row.org_id)).toEqual(["internal-alice"])
      expect(stored.results.every((row) => row.secret_envelope.startsWith("cenc1:") && !row.secret_envelope.includes("oauth-secret"))).toBe(true)
      broken = true
      expect((await app.request(catalogPath, { headers: headers() })).status).toBe(500)
    } finally {
      await controlPlane.dispose()
    }
  })
})

describe("resource-closed hosted core app", () => {
  test("mounts core multiplayer routes and no optional-service or billing route", () => {
    const app = createHostedCoreApp(plane(), options) as unknown as Hono
    const paths = [...new Set(app.routes.map((route) => route.path))].toSorted()
    for (const expected of [
      "/api/claxedo/auth/descriptor",
      "/api/claxedo/auth/bootstrap-owner",
      "/api/claxedo/auth/profile",
      "/api/claxedo/services",
      "/api/cp/events",
      "/api/control/sessions",
      "/api/control/session-list",
      "/api/control/orgs",
      "/api/control/orgs/:orgId/teams",
      "/api/control/teams/:teamId/members",
      "/api/control/sessions/:sessionId/messages",
      "/api/control/sessions/:sessionId/outline",
      "/api/control/sessions/:sessionId/participants",
      "/api/control/sessions/:sessionId/shares",
      "/api/control/user-deployed/identity-admissions",
      "/api/control/session-registrations/reserve",
      "/api/runtime-authority/session-authorize",
      "/api/workspace/:id/connection",
      "/internal/relay/target",
    ]) {
      expect(paths).toContain(expected)
    }
    expect(paths.filter((route) =>
      route.startsWith("/documents") ||
      route.startsWith("/api/billing")
    )).toEqual([])
  })

  test("the session outline route refuses a request without a workspaceId, and otherwise answers with the authority's outline", async () => {
    const hosted = plane()
    const outline = { allowed: true, role: "owner", turns: [{ id: "msg_1", messages: 2 }], complete: true }
    const readSessionOutline = vi.fn(async () => outline)
    Object.assign(hosted.services.authority!, { readSessionOutline })
    const app = createHostedCoreApp(hosted, options) as unknown as Hono
    const headers = { authorization: "Bearer alice" }
    const unscoped = await app.request("/api/control/sessions/ses_1/outline", { headers })
    expect(unscoped.status).toBe(400)
    await expect(unscoped.json()).resolves.toMatchObject({ error: { code: "WORKSPACE_ID_REQUIRED" } })
    const read = await app.request("/api/control/sessions/ses_1/outline?workspaceId=ws_1", { headers })
    expect(read.status).toBe(200)
    await expect(read.json()).resolves.toEqual(outline)
    expect(readSessionOutline).toHaveBeenCalledWith(expect.anything(), { sessionId: "ses_1", workspaceId: "ws_1" })
  })

  test("mounts build-composed route contributions and the integrations family under their own owners", async () => {
    const { Hono } = await import("hono")
    const contribution = new Hono().get("/", (c) => c.json({ plugins: true }))
    const integrations = new Hono().get("/", (c) => c.json({ integrations: true }))
    const app = createHostedCoreApp(plane(), {
      ...options,
      routeContributions: [{ id: "agent-plugins", path: "/api/claxedo/plugins", routes: contribution }],
      integrationRoutes: integrations,
    })
    const plugins = await app.fetch(new Request("https://core.test/api/claxedo/plugins"))
    expect(await plugins.json()).toEqual({ plugins: true })
    const integrationsResponse = await app.fetch(new Request("https://core.test/api/claxedo/integrations"))
    expect(await integrationsResponse.json()).toEqual({ integrations: true })
    // The base composition serves neither family at all.
    const base = createHostedCoreApp(plane(), options)
    expect((await base.fetch(new Request("https://core.test/api/claxedo/plugins"))).status).toBe(404)
    expect((await base.fetch(new Request("https://core.test/api/claxedo/integrations"))).status).toBe(404)
  })

  test("mounts the first-party MCP under its own owner and admits the CLI JWT as the whole account", async () => {
    const inputs: McpClientInputs[] = []
    const stubClient: ClaxedoMcpClient = {
      deployment: "hosted",
      runtime: async () => async () => new Response(null, { status: 204 }),
      resolveTarget: async () => ({ kind: "relay", baseUrl: "", headers: {} }),
      server: () => Promise.reject(new Error("unused")),
      workspaces: async () => [],
    }
    const app = createHostedCoreApp(plane(), {
      ...options,
      firstPartyMcp: {
        createClient: (input) => {
          inputs.push(input)
          return stubClient
        },
      },
    })
    const initialize = (headers: Record<string, string>) =>
      app.fetch(new Request("https://core.test/api/claxedo/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli", version: "0" } },
        }),
      }))
    expect(app.routes.map((route) => route.path)).toContain("/api/claxedo/mcp")
    expect((await createHostedCoreApp(plane(), options).routes.map((route) => route.path))).not.toContain("/api/claxedo/mcp")

    const anonymous = await initialize({})
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("www-authenticate")).toContain('resource_metadata="https://core.test/.well-known/oauth-protected-resource"')

    const metadataUrl = /resource_metadata="([^"]+)"/.exec(anonymous.headers.get("www-authenticate") ?? "")?.[1]
    const metadata = await app.fetch(new Request(metadataUrl!))
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toMatchObject({
      resource: "https://core.test/api/claxedo/mcp",
      authorization_servers: ["https://auth.test"],
    })
    expect((await createHostedCoreApp(plane(), options).fetch(new Request(metadataUrl!))).status).toBe(404)

    const signed = await initialize({ authorization: "Bearer user-1" })
    expect(signed.status).toBe(200)
    expect(signed.headers.get("mcp-session-id")).toMatch(/\S/)
    expect(inputs[0]).toMatchObject({
      deployment: "hosted",
      credential: { kind: "user", actorId: "actor:user-1", clientId: "cli", readOnly: false },
    })
    expect(inputs[0]?.local).toBeUndefined()
  })

  test("authenticates org and session-share routes through the Better Auth cookie adapter", async () => {
    const app = createHostedCoreApp(plane(), options)
    const headers = { cookie: "__Secure-claxedo.session_token=browser-session" }

    const orgs = await app.fetch(new Request("https://core.test/api/control/orgs", { headers }))
    expect(orgs.status).toBe(200)
    await expect(orgs.json()).resolves.toEqual([{ org_id: "org-1", name: "Test organization" }])

    const shares = await app.fetch(new Request(
      "https://core.test/api/control/sessions/session-1/shares?workspaceId=workspace-1",
      { headers },
    ))
    expect(shares.status).toBe(200)
    await expect(shares.json()).resolves.toEqual([{ grant_id: "share-1", granted_to_user_id: "user-2" }])
  })

  test("admits a provider-verified subject through the authenticated user-deployed lifecycle", async () => {
    const app = createHostedCoreApp(plane(), options)
    const response = await app.fetch(new Request(
      "https://core.test/api/control/user-deployed/identity-admissions",
      {
        method: "POST",
        headers: {
          cookie: "__Secure-claxedo.session_token=browser-session",
          origin: "https://app.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ subject: "better-auth-member", role: "member" }),
      },
    ))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      admitted: true,
      role: "member",
      user: { id: "user:better-auth-member" },
    })
    expect(options.userDeployedIdentityAdmission.admit).toHaveBeenCalledWith(
      expect.objectContaining({ principal: expect.objectContaining({ userId: "browser-user" }) }),
      {
        identity: { adapter: "better-auth", issuer: "https://auth.test", subject: "better-auth-member" },
        role: "member",
      },
    )
  })

  test("has no static wakes, Documents, billing, or Polar implementation edge", () => {
    const entry = "src/deployments/hosted-shared/hosted-core-app.ts"
    const closure = sourceClosure({ entry: path.join(ROOT, entry), root: ROOT, runtimeOnly: true })
    expect(closure.unresolved).toEqual([])
    expect(closure.opaque).toEqual([])
    const files = closure.modules.map((module) => module.relative.toLowerCase())
    expect(files.filter((file) => ["hosts/wakes", "documents/", "billing/"].some((part) => file.includes(part)))).toEqual([])
    expect(
      closure.packages.filter((name) =>
        [
          "@claxedo/documents-service",
          "@claxedo/wakes",
          "@polar-sh/sdk",
        ].includes(name),
      ),
    ).toEqual([])
  })

  test("requires the cross-isolate limiter, LiveSyncRoom, catalog, and admission policy", () => {
    for (const missing of [
      "liveSyncRoom",
      "authentication",
      "sharedRateLimitStore",
      "serviceCatalog",
      "cloudWorkspaceAdmission",
      "product",
      "requestGuardExemptions",
      "userDeployedIdentityAdmission",
    ] as const) {
      expect(() => createHostedCoreApp(plane(), { ...options, [missing]: undefined } as never)).toThrow(missing === "liveSyncRoom"
        ? /LIVE_SYNC_ROOM/
        : missing === "authentication"
          ? /authentication adapter/
        : missing === "sharedRateLimitStore"
          ? /CLAXEDO_REQUEST_LIMITER/
          : new RegExp(
              missing === "serviceCatalog"
                ? "service catalog"
                : missing === "cloudWorkspaceAdmission"
                  ? "admission policy"
                  : missing === "userDeployedIdentityAdmission"
                    ? "identity admission"
                  : missing === "product"
                    ? "product descriptor"
                    : "request-guard inventory",
            ))
    }
  })

  test("refuses a hosted multiplayer root without both private-session ports", () => {
    const missingPrivate = plane()
    delete missingPrivate.privateSessionAuthority
    expect(() => createHostedCoreApp(missingPrivate, options)).toThrow(/private-session authority is not composed/)

    const missingRuntime = plane()
    delete missingRuntime.runtimeSessionAuthority
    expect(() => createHostedCoreApp(missingRuntime, options)).toThrow(/runtime private-session authority is not composed/)
  })

  test("returns an empty service catalog to anonymous and signed callers", async () => {
    const app = createHostedCoreApp(plane(), options)
    const anonymous = await app.fetch(new Request("https://core.test/api/claxedo/services"))
    expect(await anonymous.json()).toEqual({ authenticated: false, services: [] })
    // The auth descriptor is its own route; the service catalog never restates it.
    const descriptor = await app.fetch(new Request("https://core.test/api/claxedo/auth/descriptor"))
    expect(await descriptor.json()).toMatchObject({
      adapter: "better-auth",
      browser: { transport: "cookie", trustedOrigins: ["https://app.test"] },
      native: {
        cli: { flow: "device-authorization", clientId: "claxedo-cli" },
        desktop: { flow: "authorization-code-pkce", clientId: "claxedo-desktop" },
      },
    })
    const signed = await app.fetch(new Request("https://core.test/api/claxedo/services", {
      headers: { authorization: "Bearer user-1" },
    }))
    expect(await signed.json()).toMatchObject({ authenticated: true, services: [] })
    const cookieSigned = await app.fetch(new Request("https://core.test/api/claxedo/services", {
      headers: { cookie: "__Secure-claxedo.session_token=browser-session" },
    }))
    expect(await cookieSigned.json()).toMatchObject({ authenticated: true, services: [] })
    const mode = await app.fetch(new Request("https://core.test/api/claxedo/mode"))
    expect(await mode.json()).toMatchObject({
      product: { productPosture: "user-deployed", organizationPolicy: "single-org", billing: "absent", multiplayer: true },
    })
  })

  test("publishes only the selected public auth descriptor before sign-in", async () => {
    const app = createHostedCoreApp(plane(), options)
    const response = await app.fetch(new Request("https://core.test/api/claxedo/auth/descriptor"))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.text()
    expect(JSON.parse(body)).toEqual(options.authentication.descriptor)
    for (const secretField of ["secret", "clientSecret", "privateKey", "introspectionSecret"]) {
      expect(body).not.toContain(secretField)
    }
  })

  test("enforces exact-origin credentialed CORS and CSRF for cookie mutations", async () => {
    const app = createHostedCoreApp(plane(), options)
    const preflight = await app.fetch(new Request("https://core.test/api/workspace/create", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "POST",
      },
    }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.test")
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true")

    const read = await app.fetch(new Request("https://core.test/api/claxedo/auth/descriptor", {
      headers: { origin: "https://app.test" },
    }))
    expect(read.headers.get("timing-allow-origin")).toBe("https://app.test")

    const mutation = (headers: Record<string, string>) => app.fetch(new Request(
      "https://core.test/api/workspace/create",
      { method: "POST", headers, body: "{}" },
    ))
    expect((await mutation({
      cookie: "__Secure-claxedo.session_token=browser-session",
      "content-type": "application/json",
    })).status).toBe(403)
    expect((await mutation({
      cookie: "__Secure-claxedo.session_token=browser-session",
      origin: "https://lookalike.test",
      "content-type": "application/json",
    })).status).toBe(403)
    expect((await mutation({
      cookie: "__Secure-claxedo.session_token=browser-session",
      origin: "https://app.test",
      "content-type": "text/plain",
    })).status).toBe(415)
    const accepted = await mutation({
      cookie: "__Secure-claxedo.session_token=browser-session",
      origin: "https://app.test",
      "content-type": "application/json",
    })
    expect([403, 415]).not.toContain(accepted.status)
  })

  test("projects operator service metadata out of the signed service catalog JSON", async () => {
    const app = createHostedCoreApp(plane(), {
      ...options,
      serviceCatalog: async () => [{
        serviceId: "documents",
        protocolVersion: "claxedo.service.v1",
        schemaVersion: 1,
        state: "installed_disabled",
        bindingName: "DOCUMENTS_SERVICE",
        entrypoint: "https://operator-only.internal",
        trust: {
          environmentId: "environment-secret",
          deploymentId: "deployment-secret",
          bindingProvenance: "binding-secret",
        },
        lastHealthProbe: {
          status: "ready",
          checkedAt: "2026-08-28T00:00:00.000Z",
          serviceBuildId: "build-secret",
        },
      }],
    })
    const response = await app.fetch(new Request("https://core.test/api/claxedo/services", {
      headers: { authorization: "Bearer user-1" },
    }))
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({
      services: [{
        serviceId: "documents",
        protocolVersion: "claxedo.service.v1",
        schemaVersion: 1,
        state: "installed_disabled",
      }],
    })
    for (const operatorOnly of [
      "entrypoint",
      "bindingName",
      "environment-secret",
      "deployment-secret",
      "binding-secret",
      "build-secret",
      "lastHealthProbe",
    ]) expect(body).not.toContain(operatorOnly)
  })
})


describe("hosted-core usage", () => {
  async function signedTurnLease(env: Record<string, string>, claims: Record<string, unknown>) {
    const now = Math.floor(Date.now() / 1_000)
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("claxedo-control-plane")
      .setAudience("workspace-runtime-session-turn")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(await importPKCS8(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM, "EdDSA"))
  }

  test("serves the signed account's usage view from the composed ledger and files runtime reports into it", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    }
    const base = plane()
    const composed = {
      ...base,
      env,
      runtimeSessionAuthority: {
        ...base.runtimeSessionAuthority,
        resolveCloudTurnUsageOwner: vi.fn(async () => ({ org_id: "org-1", user_id: "alice" })),
      },
    } as unknown as HostedControlPlane
    const usageDashboard = vi.fn(async () => ({
      totals: { turn_count: 3 },
      daily: [],
      models: [{ value: "anthropic/claude-sonnet-4-5", input_tokens: 1_000_000 }],
      locations: [],
    }))
    const cloudUsageFacts = vi.fn(async () => [])
    const writeRevision = vi.fn(async () => ({ status: "accepted" as const }))
    const app = createHostedCoreApp(composed, { ...options, usageLedger: { writeRevision, usageDashboard, cloudUsageFacts } })

    const view = await app.fetch(new Request("https://core.test/api/claxedo/usage?since=1&until=2", {
      headers: { authorization: "Bearer alice" },
    }))
    expect(view.status).toBe(200)
    // The hosted plane prices from the catalog compiled into the Worker, never
    // one refreshed from disk or the network.
    expect(await view.json()).toMatchObject({
      claxedo: {
        totals: { turnCount: 3 },
        scope: "cross-machine",
        cost: { estimatedUsd: 3, pricedTokens: 1_000_000, catalog: { source: "bundled-seed" } },
      },
    })
    expect(usageDashboard).toHaveBeenCalledWith(expect.objectContaining({ org_id: "org-1", user_id: "alice" }))
    expect((await app.fetch(new Request("https://core.test/api/claxedo/usage?since=1&until=2"))).status).toBe(401)

    const facts = await app.fetch(new Request("https://core.test/api/claxedo/usage/cloud-facts?since=1&until=2", {
      headers: { authorization: "Bearer alice" },
    }))
    expect(facts.status).toBe(200)
    expect(await facts.json()).toEqual({ facts: [] })
    expect(cloudUsageFacts).toHaveBeenCalledWith({ org_id: "org-1", user_id: "alice", since: 1, until: 2, limit: 10_001 })
    expect((await app.fetch(new Request("https://core.test/api/claxedo/usage/cloud-facts?since=1&until=2"))).status).toBe(401)

    const leaseId = await signedTurnLease(env, {
      principal_kind: "user", actor_id: "actor:alice", actor_kind: "human", org_id: "org-1", workspace_id: "ws_cloud",
      transport: "deferred-grant", grant_id: "grant_1", session_id: "ses_cloud", action: "write", turn_id: "msg_user_1",
      authority_lease_id: "turn_lease_1", fencing_token: 4, acquired_at: Date.now(), authority_expires_at: Date.now() + 60_000,
    })
    const reported = await app.fetch(new Request("https://core.test/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "usage_report", sessionId: "ses_cloud", turnId: "msg_user_1", leaseId, fencingToken: 4,
        facts: [{
          turnId: "msg_user_1",
          messageId: "msg_assistant_1", revision: 1, observedAt: Date.now(), settlement: "final", status: "completed",
          harness: "claude", providerId: "anthropic", modelId: "claude-sonnet-5",
          tokens: { input: 1, output: 1, reasoning: null, cache: { read: null, write: null } },
          quality: { source: "provider", knownCategories: ["input", "output"] },
        }],
      }),
    }))
    expect(reported.status).toBe(200)
    expect(writeRevision).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_cloud", workspaceId: "ws_cloud", hostId: "workspace:ws_cloud", location: "cloud-workspace" }),
      { owner: { org_id: "org-1", user_id: "alice" }, turnId: "msg_user_1" },
    )

    const bare = createHostedCoreApp(composed, options)
    expect((await bare.fetch(new Request("https://core.test/api/claxedo/usage?since=1&until=2", {
      headers: { authorization: "Bearer alice" },
    }))).status).toBe(404)
  })
})


/**
 * What a HUMAN gets when they point a browser at the control plane.
 *
 * Hono's default answers every unrouted path with the bare text
 * "404 Not Found", which a browser renders as the entire document. A user who
 * opened this host on their phone saw precisely that and reported it as "the
 * app returns 404" — while the app, on its own origin, was serving fine. The
 * control plane is an API; it has no page, and its root is the one path a
 * person is actually likely to type.
 */
describe("control-plane root and unrouted paths", () => {
  function appWith(origins: string | undefined) {
    const base = plane()
    const withOrigins = {
      ...base,
      env: { ...base.env, ...(origins === undefined ? {} : { CLAXEDO_APP_ORIGINS: origins }) },
    } as unknown as HostedControlPlane
    return createHostedCoreApp(withOrigins, options) as unknown as Hono
  }

  test("sends someone who opens the root to the app", async () => {
    const response = await appWith("https://app.example.test").request("/")
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://app.example.test")
  })

  /**
   * The deployment this exists for binds the SINGULAR name. The first version
   * read only the plural and went live redirecting nothing — the root answered
   * JSON 404 with no `location`, which is better than a rendered "404 Not
   * Found" but not the product.
   */
  test("redirects from the singular binding the locked worker actually uses", async () => {
    const base = plane()
    const singular = {
      ...base,
      env: { ...base.env, CLAXEDO_APP_ORIGIN: "https://app.single.test" },
    } as unknown as HostedControlPlane
    const response = await (createHostedCoreApp(singular, options) as unknown as Hono).request("/")
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://app.single.test")
  })

  test("answers an unrouted path as JSON, never as a rendered page", async () => {
    const response = await appWith("https://app.example.test").request("/not-a-route")
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toMatchObject({ error: { code: "route_not_found" } })
    // The exact shape that was rendered to a user as a whole web page.
    const again = await appWith("https://app.example.test").request("/not-a-route")
    expect(await again.text()).not.toBe("404 Not Found")
  })

  test("still answers JSON at the root when no app origin is configured", async () => {
    const response = await appWith(undefined).request("/")
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: "route_not_found" } })
  })
})

describe("coreAppHomeOrigin", () => {
  test("takes the first exact origin", () => {
    expect(coreAppHomeOrigin("https://a.test,https://b.test")).toBe("https://a.test")
  })

  /** A wildcard names a SHAPE, not a destination — redirecting to one emits a literal asterisk. */
  test("skips wildcard entries", () => {
    expect(coreAppHomeOrigin("https://*.example.test,https://real.test")).toBe("https://real.test")
    expect(coreAppHomeOrigin("https://*.example.test")).toBeUndefined()
  })

  test("is absent when nothing is configured", () => {
    expect(coreAppHomeOrigin(undefined)).toBeUndefined()
    expect(coreAppHomeOrigin("")).toBeUndefined()
  })
})

/**
 * The rail's paginated read, on the root the deployed worker actually uses.
 *
 * Path presence (asserted above) is not enough — the route existed on the Node
 * roots the whole time and the hosted app still 404'd, because the workerd root
 * never mounted it. These exercise the wiring: the request reaches the shared
 * `signedSessionList` and that reaches the authority with the right scope.
 */
describe("hosted-core session-list", () => {
  function core(authority: Record<string, unknown>) {
    const base = plane()
    const services = base.services as unknown as { authority: Record<string, unknown> }
    services.authority = {
      openWorkspace: vi.fn(async () => ({ role: "owner", workspace: { backing: "cloud-vm" } })),
      ...services.authority,
      ...authority,
    }
    return createHostedCoreApp(base, options) as unknown as Hono
  }
  const signed = { authorization: "Bearer user-1" }

  test("pages a workspace's sessions through the authority", async () => {
    const listSessionPage = vi.fn(async () => [])
    const response = await core({ listSessionPage }).request(
      "/api/control/session-list?scope=workspace&limit=5&workspaceId=ws_1",
      { headers: signed },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(listSessionPage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed" }),
      expect.objectContaining({ workspaceId: "ws_1", limit: 6 }),
    )
  })

  test("pages a project's sessions in one read, machine-placed workspaces included", async () => {
    const listSessionPage = vi.fn(async () => [
      { session_id: "ses_host", workspace_id: "ws_host", project_id: "prj_1", created_at: 1, updated_at: 1 },
    ])
    const response = await core({ listSessionPage }).request(
      "/api/control/session-list?scope=project&limit=5&projectId=prj_1",
      { headers: signed },
    )
    expect(response.status).toBe(200)
    expect(listSessionPage).toHaveBeenCalledTimes(1)
    expect(listSessionPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ projectId: "prj_1" }))
    expect(((await response.json()) as { items: Array<{ sessionRef: string }> }).items.map((item) => item.sessionRef))
      .toEqual(["workspace:ws_host:session:ses_host"])
  })

  /**
   * The composer's harness status for a machine-placed workspace comes from the
   * host's runtime through the relay, in the shape the daemon's own status
   * route reports. The route and its probe both existed on this root while the
   * probe was never composed, so the app saw 404 and defaulted to opencode.
   */
  test("answers a machine-placed workspace's harness status from the host through the relay", async () => {
    const base = plane()
    const services = base.services as unknown as {
      authority: Record<string, unknown>
      relay: Record<string, unknown>
    }
    services.authority = {
      ...services.authority,
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { backing: "local-worktree", org_id: "org_1", project_id: "prj_1" },
      })),
      activeWorkspaceHost: vi.fn(async () => ({
        active: true, host_id: "host_laptop", workspace_id: "ws_1",
        expires_at: Date.now() + 60_000, last_seen_at: Date.now(),
      })),
      usersMe: vi.fn(async () => ({ actor_id: "actor_user_1", actor_kind: "human" })),
    }
    services.relay = {
      ...services.relay,
      provider: {
        mintRuntimeAccessToken: vi.fn(async () => ({ token: "rat", expiresAt: 0, jti: "j" })),
        getRelayEndpoint: vi.fn(async () => "https://relay.test"),
      },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = fetchUrl(input)
      if (url.endsWith("/workspaces/ws_1/global/health")) return Response.json({ workspaceId: "ws_1" })
      if (url.endsWith("/workspaces/ws_1/api/wr/health?sessionId=ses_1")) {
        return Response.json({ ok: true, status: "ready", harness: { kind: "native", harnessId: "claude" }, activeHarness: { kind: "native", harnessId: "claude" }, harnessHealth: { status: "ok" } })
      }
      return new Response("not found", { status: 404 })
    }) as unknown as typeof globalThis.fetch
    try {
      const app = createHostedCoreApp(base, options) as unknown as Hono
      const response = await app.request(
        "/api/claxedo/agent-config/harness?workspaceId=ws_1&sessionId=ses_1",
        { headers: { authorization: "Bearer user-1" } },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        workspaceId: "ws_1",
        sessionId: "ses_1",
        status: "ready",
        ready: true,
        harness: { kind: "native", harnessId: "claude" },
        activeHarness: { kind: "native", harnessId: "claude" },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("refuses an unsigned caller with JSON, not a rendered 404", async () => {
    const response = await core({}).request("/api/control/session-list?scope=workspace&limit=5&workspaceId=ws_1")
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
  })
})

describe("hosted-core remote access (the owner's view)", () => {
  const signed = { authorization: "Bearer user-1" }
  function core(authority: Record<string, unknown>) {
    const base = plane()
    const services = base.services as unknown as { authority: Record<string, unknown>; relay: Record<string, unknown> }
    services.authority = { ...services.authority, ...authority }
    services.relay = { ...services.relay, provider: {} }
    return createHostedCoreApp(base, options) as unknown as Hono
  }

  test("lists the account's machines, including one that serves nothing yet", async () => {
    const response = await core({
      listHostAssignments: vi.fn(async () => [
        { host_id: "host_a", display_name: "laptop", last_seen_at: 10, expires_at: 99, workspace_ids: ["ws_1", "ws_2"], acked_workspace_ids: ["ws_1"] },
      ]),
      activeHostEnrollment: vi.fn(async () => ({ active: true, host_id: "host_b", display_name: "desk", last_seen_at: 20, expires_at: 99 })),
    }).request("/api/claxedo/remote-access/devices", { headers: signed })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      devices: [
        { host_id: "host_b", display_name: "desk", last_seen_at: 20, workspace_ids: [] },
        { host_id: "host_a", display_name: "laptop", last_seen_at: 10, workspace_ids: ["ws_1", "ws_2"] },
      ],
    })
  })

  test("revokes one of the account's machines", async () => {
    const revokeHostEnrollment = vi.fn(async () => ({ revoked: 1, runtime_tokens_revoked: 2 }))
    const response = await core({ revokeHostEnrollment }).request("/api/claxedo/remote-access/devices/host_a", {
      method: "DELETE",
      headers: signed,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revoked: true })
    expect(revokeHostEnrollment).toHaveBeenCalledWith(expect.objectContaining({ token: "user-1" }), { hostId: "host_a" })
  })

  test("refuses an unsigned caller with JSON", async () => {
    const response = await core({}).request("/api/claxedo/remote-access/devices")
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  test("has no machine side: enrolling happens in the desktop app on the machine", async () => {
    const response = await core({}).request("/api/claxedo/remote-access/enable", {
      method: "POST",
      headers: { ...signed, "content-type": "application/json" },
      body: JSON.stringify({ start_at_login: false }),
    })
    expect(response.status).toBe(404)
  })
})


/**
 * The ADAPTER-NATIVE device-login seam.
 *
 * `HostedDeviceAuthRoutes` mounts only when an adapter-native port or a device
 * issuer is composed. Nothing else asserts that, and the failure it guards
 * against is silent: the routes went unmounted while
 * `public-docs/writing-an-auth-or-storage-port.md` still documented the
 * extension point (implement `AdapterNativeSessionAuthPort` and pass it as
 * `native`, or bind `deviceAuthProvider`), so the code existed and no request
 * ever reached it. These pin the mount in both directions: absent for Better
 * Auth, whose own OAuth server owns device authorization, and present the moment
 * an adapter brings its own token sets.
 */
describe("hosted-core adapter-native device login", () => {
  const nativePort = (overrides: Record<string, unknown> = {}) => ({
    adapter: "custom" as const,
    acceptsAccessToken: (token: string) => token.startsWith("cli_at_"),
    acceptsRefreshToken: (token: string) => token.startsWith("cli_rt_"),
    issue: vi.fn(async () => ({ access_token: "cli_at_1", refresh_token: "cli_rt_1", expires_in: 900 })),
    refresh: vi.fn(async () => ({ access_token: "cli_at_2", refresh_token: "cli_rt_2", expires_in: 900 })),
    authenticate: vi.fn(async () => ({ mode: "signed", user: { subject: "user-1" } })),
    revoke: vi.fn(async () => ({ revokedAt: 1 })),
    ...overrides,
  })

  function core(mutate: (base: HostedControlPlane) => void) {
    const base = plane()
    mutate(base)
    return createHostedCoreApp(base, options) as unknown as Hono
  }

  /**
   * The certified composition. Better Auth implements neither port, so these
   * paths must not exist at all — a mounted fail-closed 501 would shadow the
   * device flow the auth descriptor points the CLI at.
   */
  test("does not mount the device endpoints for the Better Auth composition", async () => {
    const app = createHostedCoreApp(plane(), options) as unknown as Hono
    expect(app.routes.map((route) => route.path).filter((path) => path.startsWith("/api/auth/"))).toEqual([])
    for (const path of ["/api/auth/device/code", "/api/auth/device/token", "/api/auth/cli/exchange", "/api/auth/cli/revoke"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status, path).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: "route_not_found" } })
    }
  })

  test("mounts them for an adapter that owns its own token sets", async () => {
    const native = nativePort()
    const app = core((base) => {
      ;(base.services as unknown as { auth: Record<string, unknown> }).auth.native = native
    })
    expect(app.routes.map((route) => route.path)).toContain("/api/auth/device/token")

    // The native port answers a refresh it recognises, with no device issuer composed.
    const refreshed = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "cli_rt_1" }),
    })
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toEqual({ access_token: "cli_at_2", refresh_token: "cli_rt_2", expires_in: 900 })
    expect(native.refresh).toHaveBeenCalledWith("cli_rt_1")

    // Mounted, and honest about the half it cannot serve without an issuer.
    const code = await app.request("/api/auth/device/code", { method: "POST" })
    expect(code.status).toBe(501)
    expect(await code.json()).toMatchObject({ error: { code: "device_login_unconfigured" } })
  })

  test("brokers the device-code exchange against a composed deviceAuthProvider", async () => {
    const issuerFetch = vi.fn(async () =>
      Response.json({ device_code: "dev-1", user_code: "ABCD-EFGH", interval: 5 }),
    )
    const app = core((base) => {
      ;(base as { deviceAuthProvider?: unknown }).deviceAuthProvider = {
        issuer: "https://issuer.test",
        codeUrl: "https://issuer.test/device/code",
        tokenUrl: "https://issuer.test/device/token",
        audience: "claxedo-control-plane",
        fetch: issuerFetch,
      }
    })
    const response = await app.request("/api/auth/device/code", { method: "POST" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ device_code: "dev-1", user_code: "ABCD-EFGH" })
    expect(issuerFetch).toHaveBeenCalledWith("https://issuer.test/device/code", expect.objectContaining({ method: "POST" }))
  })
})
