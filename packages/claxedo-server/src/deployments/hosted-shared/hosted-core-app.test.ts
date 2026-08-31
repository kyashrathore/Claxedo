import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

import { createHostedCoreApp } from "./hosted-core-app"
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
