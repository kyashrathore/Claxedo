import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

import { coreAppHomeOrigin, createHostedCoreApp } from "./hosted-core-app"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { durableCliSessionTokenRegistry } from "../../test-support/cli-session-registry"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"

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
      auditAllow: vi.fn(async () => ({})),
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
    cliSessionTokenRegistry: durableCliSessionTokenRegistry().registry,
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

describe("resource-closed hosted core app", () => {
  test("mounts core multiplayer routes and no optional-service or billing route", () => {
    const app = createHostedCoreApp(plane(), options) as unknown as Hono
    const paths = [...new Set(app.routes.map((route) => route.path))].toSorted()
    for (const expected of [
      "/api/claxedo/auth/descriptor",
      "/api/claxedo/auth/bootstrap-owner",
      "/api/claxedo/auth/profile",
      "/api/claxedo/bootstrap",
      "/api/claxedo/events",
      "/api/control/sessions",
      "/api/control/session-list",
      "/api/control/orgs",
      "/api/control/orgs/:orgId/teams",
      "/api/control/teams/:teamId/members",
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
      route.startsWith("/api/workgraph") ||
      route.startsWith("/internal/workgraph") ||
      route.startsWith("/documents") ||
      route.startsWith("/api/billing")
    )).toEqual([])
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

  test("has no static WorkGraph, wakes, Documents, billing, or Polar implementation edge", () => {
    const entry = "src/deployments/hosted-shared/hosted-core-app.ts"
    const closure = sourceClosure({ entry: path.join(ROOT, entry), root: ROOT, runtimeOnly: true })
    expect(closure.unresolved).toEqual([])
    expect(closure.opaque).toEqual([])
    const files = closure.modules.map((module) => module.relative.toLowerCase())
    expect(files.filter((file) => ["hosts/workgraph", "hosts/wakes", "documents/", "billing/"].some((part) => file.includes(part)))).toEqual([])
    expect(
      closure.packages.filter((name) =>
        [
          "@claxedo/workgraph",
          "@claxedo/workgraph-service",
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

  test("returns an empty service catalog to anonymous and signed bootstraps", async () => {
    const app = createHostedCoreApp(plane(), options)
    const anonymous = await app.fetch(new Request("https://core.test/api/claxedo/bootstrap"))
    expect(await anonymous.json()).toMatchObject({
      authenticated: false,
      services: [],
      auth: {
        adapter: "better-auth",
        browser: { transport: "cookie", trustedOrigins: ["https://app.test"] },
        native: {
          cli: { flow: "device-authorization", clientId: "claxedo-cli" },
          desktop: { flow: "authorization-code-pkce", clientId: "claxedo-desktop" },
        },
      },
    })
    const signed = await app.fetch(new Request("https://core.test/api/claxedo/bootstrap", {
      headers: { authorization: "Bearer user-1" },
    }))
    expect(await signed.json()).toMatchObject({ authenticated: true, services: [] })
    const cookieSigned = await app.fetch(new Request("https://core.test/api/claxedo/bootstrap", {
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

    // The app may read resource timing for an admitted origin.
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

  test("projects operator service metadata out of signed bootstrap JSON", async () => {
    const app = createHostedCoreApp(plane(), {
      ...options,
      serviceCatalog: async () => [{
        serviceId: "workgraph",
        protocolVersion: "claxedo.service.v1",
        schemaVersion: 1,
        state: "installed_disabled",
        bindingName: "WORKGRAPH_SERVICE",
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
    const response = await app.fetch(new Request("https://core.test/api/claxedo/bootstrap", {
      headers: { authorization: "Bearer user-1" },
    }))
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({
      services: [{
        serviceId: "workgraph",
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
      openWorkspace: vi.fn(async () => ({ role: "owner", workspace: { access: "cloud", backing: "cloud-vm" } })),
      ...services.authority,
      ...authority,
    }
    return createHostedCoreApp(base, options) as unknown as Hono
  }
  const signed = { authorization: "Bearer user-1" }

  test("lists a workspace's sessions through the authority", async () => {
    const listSessions = vi.fn(async () => [])
    const response = await core({ listSessions }).request(
      "/api/control/session-list?scope=workspace&limit=5&workspaceId=ws_1",
      { headers: signed },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ mode: "signed" }), { workspaceId: "ws_1" })
  })

  /**
   * The sidebar sends a PROJECT id and never a workspace id (rail-sidebar's
   * ProjectBlock). The read must resolve the project's workspaces itself
   * rather than 400 — the exact behaviour the canonical route had and the
   * hosted roots lacked.
   */
  test("resolves a project-scoped list to the project's workspaces", async () => {
    const listWorkspaces = vi.fn(async () => [{ workspace_id: "ws_9", project_id: "prj_1" }])
    const listSessions = vi.fn(async () => [])
    const response = await core({ listWorkspaces, listSessions }).request(
      "/api/control/session-list?scope=project&limit=5&projectId=prj_1",
      { headers: signed },
    )
    expect(response.status).toBe(200)
    expect(listWorkspaces).toHaveBeenCalled()
    expect(listSessions).toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws_9" })
  })

  /**
   * The acceptance the user actually asked for: a session created ON the
   * machine, in a shared workspace, listed by the hosted app. The registry has
   * no row for it; the list must come from the host through the relay.
   */
  test("lists a user-hosted workspace's sessions from the host, not the empty registry", async () => {
    const base = plane()
    const services = base.services as unknown as {
      authority: Record<string, unknown>
      relay: Record<string, unknown>
    }
    services.authority = {
      ...services.authority,
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "user-hosted", backing: "local-worktree", org_id: "org_1", project_id: "prj_1" },
      })),
      activeWorkspaceHost: vi.fn(async () => ({
        active: true, host_id: "host_laptop", workspace_id: "ws_1",
        expires_at: Date.now() + 60_000, last_seen_at: Date.now(),
      })),
      listSessions: vi.fn(async () => []),
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
      const url = String(input)
      if (url.endsWith("/workspaces/ws_1/global/health")) return Response.json({ workspaceId: "ws_1" })
      if (url.endsWith("/workspaces/ws_1/session")) {
        return Response.json([{ id: "ses_laptop", title: "created locally", directory: "/repo", time: { created: 5, updated: 6 } }])
      }
      return new Response("not found", { status: 404 })
    }) as unknown as typeof globalThis.fetch
    try {
      const app = createHostedCoreApp(base, options) as unknown as Hono
      const response = await app.request(
        "/api/control/session-list?scope=workspace&limit=5&workspaceId=ws_1",
        { headers: { authorization: "Bearer user-1" } },
      )
      expect(response.status).toBe(200)
      const body = await response.json() as { items: Array<{ sessionId: string; title: string }> }
      expect(body.items.map((item) => [item.sessionId, item.title])).toEqual([["ses_laptop", "created locally"]])
      // Routed like a registry row: the directory is the workspace, not the host's path.
      expect(body.items[0]).toMatchObject({ directory: "ws_1", sessionRef: "workspace:ws_1:session:ses_laptop" })
      expect(services.authority.listSessions, "the registry is not the source for a user-hosted workspace").not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  /** Direct workspace scope: an offline host is the answer, not an empty list. */
  test("answers the host being offline with its own status, not an empty list", async () => {
    const response = await core({
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "user-hosted", backing: "local-worktree", org_id: "org_1" },
      })),
      activeWorkspaceHost: vi.fn(async () => ({ active: false })),
      listSessions: vi.fn(async () => []),
      usersMe: vi.fn(async () => ({ actor_id: "actor_user_1", actor_kind: "human" })),
    }).request("/api/control/session-list?scope=workspace&limit=5&workspaceId=ws_1", { headers: signed })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: { code: "user_hosted_workspace_unavailable", message: expect.any(String) } })
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
      body: JSON.stringify({ display_name: "browser" }),
    })
    expect(response.status).toBe(404)
  })
})
