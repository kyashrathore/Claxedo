import { afterEach, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { createHostedApp } from "./hosted-app"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "./control-plane/hosted-services"
import type { ControlPlaneServices } from "./control-plane/services"
import { createFixedWindowConnectionRateLimiter } from "./control-plane/rate-limit"
import {
  createSandboxManager,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxManager,
} from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { HostedDeviceAuthRoutes, type HostedDeviceAuthProvider } from "./routes/hosted-device-auth"
import {
  configureCliSessionTokenRegistry,
  type CliSessionTokenRegistry,
} from "./control-plane/cli-session-registry"
import { durableCliSessionTokenRegistry } from "./test-helpers/cli-session-registry"
import { LiveSyncRoom, type LiveSyncRoomNamespace } from "./deployments/hosted-workerd/live-sync-room.cf"
import { mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import type { DocumentsRouteBackend } from "./routes/documents"

/**
 * Positive coverage for the hosted app: health/mode/JWKS/device routes mount
 * without any Node server adapter, and local-only routes are absent.
 */

const originalFetch = globalThis.fetch

function fakePlane(
  input: {
    sandboxManager?: SandboxManager
    deviceAuthProvider?: HostedDeviceAuthProvider
    /**
     * The plane's durable CLI session token registry. Tests that mint on one
     * app and verify on another must pass the SAME one to both: in production
     * every isolate reads the same Convex table, and a per-plane registry would
     * make a token minted by one app read as `unknown` on the next.
     */
    cliSessionTokenRegistry?: CliSessionTokenRegistry
  } = {},
): HostedControlPlane {
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" },
      verifier: vi.fn(async (token: string) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `https://clerk.test|${token}`,
          issuer: "https://clerk.test",
        },
      })),
    },
    relay: {
      relayUrl: "https://relay.test",
      resolverToken: "resolver-token",
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
    },
    sandbox: {
      ...(input.sandboxManager ? { sandboxManager: input.sandboxManager } : {}),
    },
    authority: {
      auditAllow: vi.fn(),
      usersMe: vi.fn(async () => ({ id: "user_1", user_id: "user_1" })),
      resolveOrgId: vi.fn(async (auth) => `org_${auth.user.subject}`),
      authorizeProject: vi.fn(async (auth, args) =>
        auth.user.subject === "tenant_a" && args.orgId === "org_tenant_a"
          ? { ok: true, role: args.action === "read" ? "viewer" : "editor", orgId: args.orgId }
          : { ok: false },
      ),
      openWorkspace: vi.fn(async (_auth, args) => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: args.workspaceId, access: "user-hosted", backing: "local-worktree" },
      })),
      listWorkspaces: vi.fn(async () => [
        {
          workspace_id: "ws-yash-staging-1",
          access: "user-hosted",
          display_name: "Yash staging",
          remote_directory: "/workspace",
        },
      ]),
      listSessions: vi.fn(async () => []),
      resolveSession: vi.fn(async (_auth, args) => ({
        session_id: args.sessionId,
        workspace_id: "ws_1",
      })),
      readSessionMessages: vi.fn(async () => ({ allowed: true, messages: [] })),
      syncSessionMessages: vi.fn(async () => ({})),
      upsertSessionVisibility: vi.fn(async () => ({})),
      replaceSessionVisibility: vi.fn(async () => ({})),
      deleteSessionVisibility: vi.fn(async () => ({})),
    },
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      sync_session_messages: vi.fn(async () => {}),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      read_session_messages: vi.fn(() => []),
      read_session_max_event_ordinal: vi.fn(() => 0),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => {}),
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
      // W3.2: the default guard's coarse ceiling. Kept high in tests so it never
      // becomes the reason an unrelated assertion sees a 429.
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({
      ...(input.sandboxManager ? { sandboxManager: input.sandboxManager } : {}),
      telemetry: services.telemetry,
    }),
    cliSessionTokenRegistry: input.cliSessionTokenRegistry ?? durableCliSessionTokenRegistry().registry,
    ...(input.deviceAuthProvider ? { deviceAuthProvider: input.deviceAuthProvider } : {}),
    // D9: hosted apps must declare their mode explicitly. No JWKS keys
    // configured → /.well-known/jwks.json returns 503.
    env: {
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
    },
  }
}

async function ed25519Pair() {
  const keyPair = await generateKeyPair("EdDSA", { extractable: true })
  return {
    privatePem: await exportPKCS8(keyPair.privateKey),
    publicPem: await exportSPKI(keyPair.publicKey),
  }
}

describe("hosted app", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    // Back to fail-closed: no test may inherit another's CLI token registry.
    configureCliSessionTokenRegistry(undefined)
  })

  test("health reports hosted mode without local execution", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/api/claxedo/health"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, mode: "hosted-control-plane", localExecution: false })
  })

  test("fails hosted boot when WorkGraph Convex service configuration is missing", () => {
    const plane = fakePlane()
    plane.env = { CLAXEDO_DEPLOYMENT_MODE: "hosted" }
    expect(() => createHostedApp(plane)).toThrow("Hosted WorkGraph requires Convex storage")
  })

  test("binds a successful WorkGraph command nudge to its request ExecutionContext", async () => {
    const nudges: Array<{ organizationId: string; ownerUserId: string }> = []
    const waitUntil = vi.fn()
    const app = createHostedApp(fakePlane(), {
      workGraphExecutor: {
        query: async () => ({}),
        mutation: async () => ({
          ok: true,
          operationId: "create_stream_a",
          cursor: "1",
          value: { streamId: "stream_a" },
        }),
      },
      workGraphSettlementDispatcherForRequest: (schedule) => ({
        nudge(tenant) {
          nudges.push(tenant)
          schedule(Promise.resolve())
        },
      }),
    })

    const response = await app.fetch(
      new Request("http://cp.test/api/workgraph/commands", {
        method: "POST",
        headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "create_stream_a",
          command: { version: 1, type: "create_stream", title: "Fast lane" },
        }),
      }),
      undefined,
      { waitUntil, passThroughOnException: vi.fn() } as never,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      operationId: "create_stream_a",
      cursor: "1",
      value: { streamId: "stream_a" },
    })
    expect(nudges).toEqual([{ organizationId: "org_tenant_a", ownerUserId: "user_1" }])
    expect(waitUntil).toHaveBeenCalledOnce()
    await Promise.all(waitUntil.mock.calls.map((call) => call[0]))
  })

  test("CORS allows deployment-configured app origins (exact and suffix) and denies unknown ones", async () => {
    const plane = fakePlane()
    plane.env = {
      ...plane.env,
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_APP_ORIGINS: "https://claxedo-app-staging.pages.dev, https://*.claxedo-app-staging.pages.dev",
    }
    const app = createHostedApp(plane)
    const health = (origin: string) =>
      app.fetch(
        new Request("http://cp.test/api/claxedo/health", {
          headers: { origin },
        }),
      )

    const exact = await health("https://claxedo-app-staging.pages.dev")
    expect(exact.headers.get("access-control-allow-origin")).toBe("https://claxedo-app-staging.pages.dev")

    const preview = await health("https://bb9ffc1f.claxedo-app-staging.pages.dev")
    expect(preview.headers.get("access-control-allow-origin")).toBe("https://bb9ffc1f.claxedo-app-staging.pages.dev")

    const unknown = await health("https://evil.pages.dev")
    expect(unknown.headers.get("access-control-allow-origin")).toBeNull()
    const insecure = await health("http://claxedo-app-staging.pages.dev")
    expect(insecure.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS does not grant loopback origins on the hosted worker by default", async () => {
    const plane = fakePlane()
    plane.env = {
      ...plane.env,
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_APP_ORIGINS: "https://app.claxedo-staging.test",
    }
    const app = createHostedApp(plane)
    const health = (origin: string) =>
      app.fetch(new Request("http://cp.test/api/claxedo/health", { headers: { origin } }))

    // A blanket loopback grant on the internet-facing plane means any local
    // port a visitor happens to be running gets a same-origin read of the
    // hosted control plane. Deployments opt in per-origin instead (below).
    for (const origin of ["http://localhost:31337", "http://127.0.0.1:31337"]) {
      expect((await health(origin)).headers.get("access-control-allow-origin")).toBeNull()
    }
  })

  test("CORS grants a loopback origin only when the deployment lists it explicitly", async () => {
    const plane = fakePlane()
    plane.env = {
      ...plane.env,
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_APP_ORIGINS: "http://localhost:4444",
    }
    const app = createHostedApp(plane)
    const health = (origin: string) =>
      app.fetch(new Request("http://cp.test/api/claxedo/health", { headers: { origin } }))

    expect((await health("http://localhost:4444")).headers.get("access-control-allow-origin"))
      .toBe("http://localhost:4444")
    // Exact match only — the grant must not widen to every other local port.
    expect((await health("http://localhost:31337")).headers.get("access-control-allow-origin")).toBeNull()
  })

  test("mode reports configured dependencies without leaking secrets", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/api/claxedo/mode"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json).toMatchObject({
      mode: "hosted-control-plane",
      signedAuth: true,
      authority: true,
      relay: true,
      relayResolver: true,
      deviceLogin: false,
    })
    // No secret material in the status body.
    expect(JSON.stringify(json)).not.toContain("resolver-token")
  })

  test("compatibility reports protocol versions without driver internals", async () => {
    const app = createHostedApp({
      ...fakePlane(),
      env: {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
        CLAXEDO_DEPLOYMENT_MODE: "hosted",
        CLAXEDO_CENTRAL_VERSION: "central-1",
        CLAXEDO_EXPECTED_CENTRAL_VERSION: "central-1",
        CLAXEDO_APP_VERSION: "app-1",
        CLAXEDO_EXPECTED_APP_VERSION: "app-1",
        CLAXEDO_CLI_VERSION: "cli-1",
        CLAXEDO_EXPECTED_CLI_VERSION: "cli-1",
        CLAXEDO_RELAY_VERSION: "relay-1",
        CLAXEDO_EXPECTED_RELAY_VERSION: "relay-1",
        CLAXEDO_RUNTIME_VERSION: "runtime-1",
        CLAXEDO_EXPECTED_RUNTIME_VERSION: "runtime-1",
      },
    })
    const res = await app.fetch(new Request("http://cp.test/api/claxedo/compatibility"))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      ok: true,
      tunnelProtocolVersion: 1,
      connectionSchemaVersion: 1,
      components: {
        central: { version: "central-1", expectedVersion: "central-1" },
        app: { version: "app-1", expectedVersion: "app-1" },
        cli: { version: "cli-1", expectedVersion: "cli-1" },
        relay: { version: "relay-1", expectedVersion: "relay-1" },
        runtime: { version: "runtime-1", expectedVersion: "runtime-1" },
      },
    })
    expect(JSON.stringify(json)).not.toContain("driver-internal-id")
  })

  test("JWKS route is mounted (503 when no keys configured)", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/.well-known/jwks.json"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "jwks_no_keys_configured" } })
  })

  test("device-login endpoints fail closed (501) until Phase A", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/api/auth/device/code", { method: "POST" }))
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ error: { code: "device_login_unconfigured" } })
  })

  test("browser CLI exchange issues a refreshable self-host token without configured device login", async () => {
    // CLI session tokens are revocable: mint and verify both consult a `jti`
    // registry and fail closed without one. Nothing is installed here on
    // purpose — `createHostedApp` installs the plane's registry, so this test
    // exercises the production wiring instead of reaching around it, and it
    // fails if that wiring is ever removed. The registry itself is the real
    // adapter stack over the real convex/cliSessionTokens.ts handlers (see
    // test-helpers/cli-session-registry.ts); only the Convex deployment is fake.
    const durable = durableCliSessionTokenRegistry().registry
    const keys = await ed25519Pair()
    const plane = fakePlane({ cliSessionTokenRegistry: durable })
    plane.env = {
      ...plane.env,
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: keys.privatePem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: keys.publicPem,
      CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS: "600",
    }
    const app = createHostedApp(plane)

    const exchanged = await app.fetch(
      new Request("http://cp.test/api/auth/cli/exchange", {
        method: "POST",
        headers: { authorization: "Bearer user_1" },
      }),
    )
    expect(exchanged.status).toBe(200)
    const first = (await exchanged.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    expect(first.access_token).toMatch(/^ey/)
    expect(first.refresh_token).toMatch(/^claxedo_cli_refresh:/)
    expect(first.expires_in).toBe(600)
    expect(plane.services.authority?.usersMe).toHaveBeenCalledTimes(1)

    const refreshed = await app.fetch(
      new Request("http://cp.test/api/auth/device/token", {
        method: "POST",
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
        }),
      }),
    )
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token?: string }
    expect(next).toMatchObject({
      token_type: "Bearer",
      expires_in: 600,
    })

    // Same registry: a second isolate reads the same durable table, so the
    // token minted above must still verify here.
    const fallbackPlane = fakePlane({ cliSessionTokenRegistry: durable })
    fallbackPlane.env = plane.env
    fallbackPlane.services.auth.verifier = vi.fn(async () => {
      throw new Error("not a clerk token")
    })
    const listed = await createHostedApp(fallbackPlane).fetch(
      new Request("http://cp.test/api/workspace?access=user-hosted", {
        headers: { authorization: `Bearer ${next.access_token}` },
      }),
    )
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      workspaces: [{ workspace_id: "ws-yash-staging-1" }],
    })
  })

  test("device-login endpoints broker through the configured issuer", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === "https://login.test/device/code") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_id: "claxedo-cli",
          audience: "convex",
          scope: "openid offline_access",
        })
        return Response.json({
          device_code: "device_1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://login.test/activate",
          interval: 5,
        })
      }
      if (url === "https://login.test/device/token") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_id: "claxedo-cli",
          device_code: "device_1",
        })
        return Response.json({
          access_token: "cli-access-token",
          refresh_token: "cli-refresh-token",
          expires_in: 3600,
        })
      }
      return new Response("not found", { status: 404 })
    })
    const app = createHostedApp(
      fakePlane({
        deviceAuthProvider: {
          issuer: "https://login.test",
          codeUrl: "https://login.test/device/code",
          tokenUrl: "https://login.test/device/token",
          clientId: "claxedo-cli",
          audience: "convex",
          scope: "openid offline_access",
          fetch: request as never,
        },
      }),
    )

    const code = await app.fetch(new Request("http://cp.test/api/auth/device/code", { method: "POST" }))
    expect(code.status).toBe(200)
    expect(await code.json()).toMatchObject({ device_code: "device_1", user_code: "ABCD-EFGH" })

    const token = await app.fetch(
      new Request("http://cp.test/api/auth/device/token", {
        method: "POST",
        body: JSON.stringify({ device_code: "device_1" }),
      }),
    )
    expect(token.status).toBe(200)
    expect(await token.json()).toMatchObject({ access_token: "cli-access-token" })
  })

  test("device-login audience and scope are SERVER-PINNED — body values are ignored", async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      // The client tried to widen the grant; the broker must pin server config.
      expect(payload.audience).toBe("convex")
      expect(payload.scope).toBe("openid offline_access")
      return Response.json({ device_code: "device_1" })
    })
    const app = createHostedApp(
      fakePlane({
        deviceAuthProvider: {
          issuer: "https://login.test",
          codeUrl: "https://login.test/device/code",
          tokenUrl: "https://login.test/device/token",
          clientId: "claxedo-cli",
          audience: "convex",
          scope: "openid offline_access",
          fetch: request as never,
        },
      }),
    )
    const res = await app.fetch(
      new Request("http://cp.test/api/auth/device/code", {
        method: "POST",
        body: JSON.stringify({ audience: "https://evil.example", scope: "admin everything" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(request).toHaveBeenCalledTimes(1)
  })

  test("device-login token endpoint brokers refresh-token grants", async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        client_id: "claxedo-cli",
        grant_type: "refresh_token",
        refresh_token: "refresh_1",
      })
      return Response.json({ access_token: "fresh-access-token" })
    })
    const app = createHostedApp(
      fakePlane({
        deviceAuthProvider: {
          issuer: "https://login.test",
          codeUrl: "https://login.test/device/code",
          tokenUrl: "https://login.test/device/token",
          clientId: "claxedo-cli",
          fetch: request as never,
        },
      }),
    )
    const res = await app.fetch(
      new Request("http://cp.test/api/auth/device/token", {
        method: "POST",
        body: JSON.stringify({ refresh_token: "refresh_1" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ access_token: "fresh-access-token" })
  })

  test("device-login endpoints are rate limited per client", async () => {
    const issuerFetch = vi.fn(async () => Response.json({ device_code: "device_1" }))
    const app = HostedDeviceAuthRoutes({
      provider: {
        issuer: "https://login.test",
        codeUrl: "https://login.test/device/code",
        tokenUrl: "https://login.test/device/token",
        fetch: issuerFetch as never,
      },
      rateLimiter: createFixedWindowConnectionRateLimiter({ limit: 2, windowMs: 60_000 }),
    })
    const code = () => app.fetch(new Request("http://cp.test/api/auth/device/code", { method: "POST" }))

    expect((await code()).status).toBe(200)
    expect((await code()).status).toBe(200)
    const limited = await code()
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "device_login_rate_limited" } })
    // The rejected request never reached the issuer.
    expect(issuerFetch).toHaveBeenCalledTimes(2)

    // The token endpoint shares the guard (separate bucket, same limiter).
    const token = () =>
      app.fetch(
        new Request("http://cp.test/api/auth/device/token", {
          method: "POST",
          body: JSON.stringify({ device_code: "device_1" }),
        }),
      )
    expect((await token()).status).toBe(200)
    expect((await token()).status).toBe(200)
    expect((await token()).status).toBe(429)
  })

  test("relay target schedules the sandbox touch through the Worker ExecutionContext", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.example.test/ws_1",
        hostId: "host_1",
        epoch: 3,
        homeRegion: "us-east",
      })),
      touch: vi.fn(async () => ({ touched: true, status: "ready" })),
    } as unknown as SandboxManager
    const plane = fakePlane({ sandboxManager })
    const app = createHostedApp(plane)
    const waitUntil = vi.fn()
    const res = await app.fetch(
      new Request("http://cp.test/internal/relay/target?workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: "Bearer resolver-token" },
      }),
      {},
      { waitUntil, passThroughOnException: vi.fn() } as never,
    )
    expect(res.status).toBe(200)
    // The touch promise is handed to waitUntil so the Worker keeps it alive.
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await Promise.all(waitUntil.mock.calls.map((call) => call[0]))
    expect(sandboxManager.touch).toHaveBeenCalledWith("ws_1")
  })

  test("control-plane session inventory returns authorized Convex visibility rows", async () => {
    const plane = fakePlane()
    plane.services.authority!.listSessions = vi.fn(async () => [
      {
        session_id: "ses_1",
        title: "Smoke session",
      },
    ])
    const app = createHostedApp(plane)
    const res = await app.fetch(
      new Request("http://cp.test/api/control/sessions?workspaceId=ws_1", {
        headers: { authorization: "Bearer user_1" },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessions: [
        {
          session_id: "ses_1",
          title: "Smoke session",
        },
      ],
    })
    expect(plane.services.authority!.listSessions).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      workspaceId: "ws_1",
    })
  })

  test("hosted Session reads resolve the retained workspace and transcript", async () => {
    const plane = fakePlane()
    plane.services.authority!.readSessionMessages = vi.fn(async () => ({
      allowed: true,
      messages: [{ info: { id: "msg_1", role: "assistant" }, parts: [{ type: "text", text: "done" }] }],
    }))
    const app = createHostedApp(plane)
    const gateway = await app.fetch(
      new Request("http://cp.test/api/control/sessions/ses_1/gateway", {
        headers: { authorization: "Bearer user_1" },
      }),
    )
    expect(gateway.status).toBe(200)
    expect(await gateway.json()).toEqual({
      gatewayUrl: null,
      workspaceId: "ws_1",
      directory: null,
      harnessHost: "central",
    })
    const messages = await app.fetch(
      new Request("http://cp.test/api/control/sessions/ses_1/messages?workspaceId=ws_1", {
        headers: { authorization: "Bearer user_1" },
      }),
    )
    expect(messages.status).toBe(200)
    expect(await messages.json()).toMatchObject({
      allowed: true,
      messages: [{ info: { id: "msg_1" } }],
      maxEventOrdinal: 0,
    })
    expect(plane.services.authority!.resolveSession).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      { sessionId: "ses_1" },
    )
    expect(plane.services.authority!.readSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      { sessionId: "ses_1", workspaceId: "ws_1" },
    )
  })

  test("local execution routes are absent from the hosted app", async () => {
    const app = createHostedApp(fakePlane())
    const response = await app.fetch(new Request("http://cp.test/api/claxedo/pty/abc/connect"))
    expect(response.status).toBe(404)
    expect((await app.fetch(new Request("http://cp.test/documents"))).status).toBe(401)
  })

  test("hosted control does not expose push session sync routes", async () => {
    const plane = fakePlane()
    const app = createHostedApp(plane)
    const routes = [
      ["POST", "/api/control/sessions/sync"],
      ["POST", "/api/control/sessions/sync-many"],
      ["POST", "/api/control/sessions/ses_1/messages"],
      ["DELETE", "/api/control/sessions/ses_1"],
    ] as const

    for (const [method, path] of routes) {
      const res = await app.fetch(
        new Request(`http://cp.test${path}`, {
          method,
          headers: {
            authorization: "Bearer user_1",
            "content-type": "application/json",
          },
          body: method === "DELETE" ? undefined : JSON.stringify({ workspaceId: "ws_1" }),
        }),
      )
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect(plane.services.authority!.upsertSessionVisibility).not.toHaveBeenCalled()
    expect(plane.services.authority!.syncSessionMessages).not.toHaveBeenCalled()
  })

  test("hosted control runtime heartbeat requires signed auth", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(
      new Request("http://cp.test/api/control/runtime/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: "ws_1",
          ok: true,
          status: "ready",
          healthStatus: "ok",
          directory: "/workspace",
          profile: "workspace",
          agentType: "opencode",
          model: null,
          ptyCount: 0,
          processCount: 0,
          activeProcessCount: 0,
        }),
      }),
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "MISSING_BEARER_TOKEN" } })
  })

  test("hosted control runtime heartbeat validates workspace access", async () => {
    const plane = fakePlane()
    const app = createHostedApp(plane)
    const res = await app.fetch(
      new Request("http://cp.test/api/control/runtime/heartbeat", {
        method: "POST",
        headers: {
          authorization: "Bearer user_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: "ws_1",
          ok: true,
          status: "ready",
          healthStatus: "ok",
          directory: "/workspace",
          profile: "workspace",
          agentType: "opencode",
          model: null,
          ptyCount: 0,
          processCount: 0,
          activeProcessCount: 0,
        }),
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(plane.services.authority!.openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      workspaceId: "ws_1",
    })
  })

  test("workspace connection route uses hosted safety limits for Runtime Access Token minting", async () => {
    const plane = {
      ...fakePlane(),
      safetyLimits: {
        connectionRateLimit: 1,
        connectionRateLimitWindowMs: 60_000,
        controlPlaneRateLimit: 120,
        controlPlaneRateLimitWindowMs: 60_000,
        // High so the 429 this test asserts provably comes from the
        // connection limiter under test, not W3.2's default ceiling.
        defaultRequestRateLimit: 10_000,
        defaultRequestRateLimitWindowMs: 60_000,
        sandboxMaxRetryCount: 5,
      },
    }
    const convex = {
      usersMe: vi.fn(async () => ({ subject: "user_1" })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "user-hosted", backing: "local-worktree", home_region: "us-east" },
      })),
      activeLocalHostLink: vi.fn(async () => ({
        active: true,
        host_id: "host_1",
        expires_at: 9_999,
      })),
      recordRuntimeAccessToken: vi.fn(async () => ({})),
      runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
      resolveOrgId: vi.fn(async () => "org_1" as never),
      auditAllow: vi.fn(async () => ({})),
      auditDeny: vi.fn(async () => ({})),
    }
    plane.services.authority = convex as never
    plane.services.relay.runtimeAccessTokenSigner = vi.fn(async () => ({
      runtimeAccessToken: "rat-token",
      tokenExpiresAt: 1_000_000,
      jti: "jti_1",
    }))

    const app = createHostedApp(plane)
    const headers = { authorization: "Bearer user_1" }
    const first = await app.fetch(new Request("http://cp.test/api/workspace/ws_1/connection", { headers }))
    const second = await app.fetch(new Request("http://cp.test/api/workspace/ws_1/connection", { headers }))

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(await second.json()).toMatchObject({
      error: {
        code: "runtime_access_token_rate_limited",
        retryAfterMs: expect.any(Number),
      },
    })
    expect(convex.openWorkspace).toHaveBeenCalledTimes(2)
    expect(convex.auditDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "runtime_access_token.denied",
        reason: "runtime_access_token_rate_limited",
        workspaceId: "ws_1",
      }),
    )
  })

  test("cloud connection route emits traceable structured telemetry without token material", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.example.test/ws_1",
        hostId: "host_cloud_1",
        driverResourceId: "driver_resource_1",
        epoch: 7,
        homeRegion: "eu-west",
      })),
    } as unknown as SandboxManager
    const plane = {
      ...fakePlane({ sandboxManager }),
      services: {
        ...fakePlane({ sandboxManager }).services,
        relay: {
          ...fakePlane({ sandboxManager }).services.relay,
          relayUrls: { "eu-west": "https://relay.eu.test" },
          runtimeAccessTokenSigner: vi.fn(async () => ({
            runtimeAccessToken: "rat-secret",
            tokenExpiresAt: 1_000_000,
            jti: "jti_cloud_1",
          })),
        },
      },
    }
    const convex = {
      usersMe: vi.fn(async () => ({ subject: "user_1" })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "editor",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "eu-west" },
      })),
      recordRuntimeAccessToken: vi.fn(async () => ({})),
      runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
      resolveOrgId: vi.fn(async () => "org_1" as never),
      auditAllow: vi.fn(async () => ({})),
      auditDeny: vi.fn(async () => ({})),
    }
    plane.services.authority = convex as never

    const app = createHostedApp(plane, { entitlementGate: async () => undefined })
    const res = await app.fetch(
      new Request("http://cp.test/api/workspace/ws_1/connection", {
        method: "POST",
        headers: { authorization: "Bearer user_1" },
      }),
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_1",
      runtimeKind: "cloud",
      homeRegion: "eu-west",
      relayUrl: "https://relay.eu.test",
      runtimeAccessToken: "rat-secret",
    })
    expect(plane.services.telemetry.capture).toHaveBeenCalledWith("user_1", "workspace.connection.requested", {
      workspaceId: "ws_1",
      access: "cloud",
      backing: "cloud-vm",
      runtimeKind: "cloud",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
    })
    expect(plane.services.telemetry.capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "ready",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
      hostId: "host_cloud_1",
      leaseEpoch: 7,
      driverResourceId: "driver_resource_1",
    })
    expect(plane.services.telemetry.capture).toHaveBeenCalledWith("user_1", "runtime_access_token.minted", {
      workspaceId: "ws_1",
      access: "cloud",
      backing: "cloud-vm",
      hostId: "host_cloud_1",
      role: "editor",
      jti: "jti_cloud_1",
      expiresAt: 1_000_000,
      homeRegion: "eu-west",
      leaseEpoch: 7,
      driverResourceId: "driver_resource_1",
      relayRoom: "ws_1",
      relayUrl: "https://relay.eu.test",
    })
    expect(JSON.stringify((plane.services.telemetry.capture as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "rat-secret",
    )
  })

  test("hosted session pull uses canonical sandbox lease through relay", async () => {
    const target = vi.fn(async () => ({
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime-direct.example.test",
      hostId: "host_cloud_1",
      epoch: 1,
      homeRegion: "us-east",
    }))
    const sandboxManager = {
      target,
      ensure: vi.fn(),
    } as unknown as SandboxManager
    const plane = fakePlane({ sandboxManager })
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "relay-runtime-token" }))
    const getRelayEndpoint = vi.fn(async () => "https://relay.example.test")
    plane.services.relay.provider = { mintRuntimeAccessToken, getRelayEndpoint } as never
    plane.services.authority!.openWorkspace = vi.fn(async (_auth, args) => ({
      allowed: true,
      role: "owner",
      workspace: {
        workspace_id: args.workspaceId,
        access: "cloud",
        backing: "cloud-vm",
        org_id: "org_1",
        host_id: "legacy-host",
        sandbox_id: "legacy-sandbox",
      },
    })) as never
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://relay.example.test/workspaces/ws_1/api/wr/health") {
        return Response.json({ workspaceId: "ws_1" })
      }
      if (url === "https://relay.example.test/workspaces/ws_1/session/session-1/message?snapshot=1") {
        return Response.json({ messages: [] })
      }
      if (url === "https://relay.example.test/workspaces/ws_1/session/status") {
        return Response.json({})
      }
      return new Response("not found", { status: 404 })
    })
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch

    const app = createHostedApp(plane)
    const res = await app.fetch(
      new Request("http://cp.test/api/control/workspaces/ws_1/sessions/session-1/checkpoint", {
        method: "POST",
        headers: {
          authorization: "Bearer user_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "test" }),
      }),
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, messages: 0 })
    expect(target).toHaveBeenCalledWith("ws_1")
    expect(sandboxManager.ensure).not.toHaveBeenCalled()
    expect(mintRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        hostId: "host_cloud_1",
        orgId: "org_1",
        role: "owner",
      }),
    )
    expect(JSON.stringify(mintRuntimeAccessToken.mock.calls)).not.toContain("legacy-host")
    expect(JSON.stringify(mintRuntimeAccessToken.mock.calls)).not.toContain("legacy-sandbox")
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test("hosted session pull fails closed when the canonical sandbox lease is unavailable", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "unavailable",
        error: "runtime_lease_not_ready",
        homeRegion: "us-east",
      })),
    } as unknown as SandboxManager
    const plane = fakePlane({ sandboxManager })
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "relay-runtime-token" }))
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }))
    plane.services.relay.provider = {
      mintRuntimeAccessToken,
      getRelayEndpoint: vi.fn(async () => "https://relay.example.test"),
    } as never
    plane.services.authority!.openWorkspace = vi.fn(async (_auth, args) => ({
      allowed: true,
      role: "owner",
      workspace: {
        workspace_id: args.workspaceId,
        access: "cloud",
        backing: "cloud-vm",
        org_id: "org_1",
        host_id: "legacy-host",
      },
    })) as never
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch

    const app = createHostedApp(plane)
    const res = await app.fetch(
      new Request("http://cp.test/api/control/workspaces/ws_1/sessions/session-1/checkpoint", {
        method: "POST",
        headers: {
          authorization: "Bearer user_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "test" }),
      }),
    )

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "cloud_runtime_unavailable" },
    })
    expect(mintRuntimeAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("relay target fails closed (409 unavailable) when neither a cloud lease nor a user-hosted link resolves", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(
      new Request("http://cp.test/internal/relay/target?workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: "Bearer resolver-token" },
      }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "relay_resolver_workspace_target_unavailable" } })
  })

  test("relay target resolves a registered user-hosted host link with no baseUrl (host dials out)", async () => {
    const plane = fakePlane()
    plane.relayTargetLookup = sandboxRelayTargetLookup({
      telemetry: plane.services.telemetry,
      userHostedResolver: async (workspaceId) =>
        workspaceId === "ws_uh" ? { active: true, hostId: "host_uh", backing: "local-worktree" } : { active: false },
    })
    const app = createHostedApp(plane)
    const ok = await app.fetch(
      new Request("http://cp.test/internal/relay/target?workspaceId=ws_uh&hostId=host_uh", {
        headers: { authorization: "Bearer resolver-token" },
      }),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ access: "user-hosted", backing: "local-worktree", baseUrl: "" })

    const wrongHost = await app.fetch(
      new Request("http://cp.test/internal/relay/target?workspaceId=ws_uh&hostId=host_other", {
        headers: { authorization: "Bearer resolver-token" },
      }),
    )
    expect(wrongHost.status).toBe(409)
  })

  test("relay target resolves a ready cloud sandbox lease without driver internals", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.example.test/ws_1/",
        hostId: "host_1",
        driverResourceId: "driver-internal-id",
        epoch: 3,
        homeRegion: "us-east",
      })),
      touch: vi.fn(async () => ({ touched: true, status: "ready" })),
    } as unknown as SandboxManager
    const plane = fakePlane({ sandboxManager })
    const app = createHostedApp(plane)
    const res = await app.fetch(
      new Request("http://cp.test/internal/relay/target?workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: "Bearer resolver-token" },
      }),
    )
    expect(res.status).toBe(200)
    expect(sandboxManager.target).toHaveBeenCalledWith("ws_1")
    expect(sandboxManager.touch).toHaveBeenCalledWith("ws_1")
    await Promise.resolve()
    expect(plane.services.telemetry.capture).toHaveBeenCalledWith("system", "sandbox.touch", {
      workspaceId: "ws_1",
      touched: true,
      status: "ready",
    })
    const body = await res.json()
    expect(body).toEqual({
      workspaceId: "ws_1",
      hostId: "host_1",
      baseUrl: "https://runtime.example.test/ws_1",
      access: "cloud",
      backing: "cloud-vm",
    })
    expect(JSON.stringify(body)).not.toContain("driver-internal-id")
  })

  test("relay target keeps routing when runtime touch fails", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.example.test/ws_1/",
        hostId: "host_1",
        epoch: 3,
        homeRegion: "us-east",
      })),
      touch: vi.fn(async () => {
        throw new Error("provider secret detail")
      }),
    } as unknown as SandboxManager
    const plane = fakePlane({ sandboxManager })
    const app = createHostedApp(plane)
    const res = await app.fetch(
      new Request("http://cp.test/internal/relay/target?workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: "Bearer resolver-token" },
      }),
    )
    expect(res.status).toBe(200)
    await Promise.resolve()
    await Promise.resolve()
    expect(plane.services.telemetry.capture).toHaveBeenCalledWith("system", "sandbox.touch", {
      workspaceId: "ws_1",
      touched: false,
      status: "failed",
    })
    expect(JSON.stringify((plane.services.telemetry.capture as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "provider secret detail",
    )
  })

  test("relay target rejects mismatched cloud runtime host ids", async () => {
    const app = createHostedApp(
      fakePlane({
        sandboxManager: {
          target: vi.fn(async () => ({
            status: "ready",
            sandboxId: "sandbox_1",
            url: "https://runtime.example.test/ws_1/",
            hostId: "host_current",
            epoch: 3,
            homeRegion: "us-east",
          })),
        } as unknown as SandboxManager,
      }),
    )
    const res = await app.fetch(
      new Request("http://cp.test/internal/relay/target?workspaceId=ws_1&hostId=host_stale", {
        headers: { authorization: "Bearer resolver-token" },
      }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "relay_resolver_workspace_target_unavailable" } })
  })

  test("sandbox garbage collection requires internal admin auth", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/internal/sandbox-manager/gc", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "sandbox_admin_unauthorized" } })
  })

  test("sandbox garbage collection does not accept the relay resolver token as admin auth", async () => {
    const app = createHostedApp(fakePlane({ sandboxManager: { garbageCollect: vi.fn() } as unknown as SandboxManager }))
    const res = await app.fetch(
      new Request("http://cp.test/internal/sandbox-manager/gc", {
        method: "POST",
        headers: { authorization: "Bearer resolver-token" },
      }),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "sandbox_admin_unauthorized" } })
  })

  test("sandbox garbage collection invokes the sandbox manager and captures counts", async () => {
    const sandboxManagerResult = {
      destroyed: [
        {
          sandboxId: "sandbox_stale",
          url: "https://runtime.test/stale",
          hostId: "host_stale",
          labels: { app: "claxedo", workspaceId: "ws_1", epoch: "1" },
        },
      ],
      kept: [],
      skipped: [],
      failed: [],
    }
    const sandboxManager = {
      garbageCollect: vi.fn(async () => sandboxManagerResult),
    } as unknown as SandboxManager
    const plane = {
      ...fakePlane({ sandboxManager }),
      env: {
        CLAXEDO_DEPLOYMENT_MODE: "hosted",
        CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin-token",
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
    }
    const app = createHostedApp(plane)
    const res = await app.fetch(
      new Request("http://cp.test/internal/sandbox-manager/gc", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
      }),
    )
    expect(res.status).toBe(200)
    expect(sandboxManager.garbageCollect).toHaveBeenCalled()
    expect(await res.json()).toEqual(sandboxManagerResult)
    expect(plane.services.telemetry.capture).toHaveBeenCalledWith("system", "sandbox.garbage_collect", {
      destroyed: 1,
      kept: 0,
      skipped: 0,
      failed: 0,
    })
  })
})

describe("hosted shell boot surface", () => {
  test("/global/health mirrors the local shape", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/global/health"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ healthy: true, version: "1.0.0" })
  })

  test("/path synthesizes the boot path from the directory query", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/path?directory=ws-yash-staging-1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      home: "",
      state: "",
      config: "",
      worktree: "ws-yash-staging-1",
      directory: "ws-yash-staging-1",
    })
  })

  test("/project/current synthesizes a project the app can read .id from", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/project/current?directory=ws-yash-staging-1"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      id: "ws-yash-staging-1",
      worktree: "ws-yash-staging-1",
      name: "ws-yash-staging-1",
      sandboxes: [],
    })
    expect((body.time as Record<string, unknown>).created).toEqual(expect.any(Number))
  })

  test("/provider returns an empty-but-valid catalog (no central runner on hosted)", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(new Request("http://cp.test/provider?runner=opencode"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { all: unknown; connected: unknown; default: unknown }
    // Must pass the app's isProviderListResponse guard so boot does not toast.
    expect(Array.isArray(body.all)).toBe(true)
    expect(Array.isArray(body.connected)).toBe(true)
    expect(body.default).toEqual({})
    expect(body.all).toEqual([])
  })

  test("/global/config and /provider/auth return empty records", async () => {
    const app = createHostedApp(fakePlane())
    const config = await app.fetch(new Request("http://cp.test/global/config"))
    expect(config.status).toBe(200)
    expect(await config.json()).toEqual({})
    const auth = await app.fetch(new Request("http://cp.test/provider/auth"))
    expect(auth.status).toBe(200)
    expect(await auth.json()).toEqual({})
  })

  test("/project lists Convex workspaces for signed callers and [] for anonymous ones", async () => {
    const app = createHostedApp(fakePlane())
    const anonymous = await app.fetch(new Request("http://cp.test/project"))
    expect(anonymous.status).toBe(200)
    expect(await anonymous.json()).toEqual([])

    const signed = await app.fetch(
      new Request("http://cp.test/project", {
        headers: { authorization: "Bearer user_1" },
      }),
    )
    expect(signed.status).toBe(200)
    const projects = (await signed.json()) as Array<Record<string, unknown>>
    expect(projects).toMatchObject([
      {
        id: "ws-yash-staging-1",
        name: "Yash staging",
        worktree: "ws-yash-staging-1",
        sandboxes: ["ws-yash-staging-1"],
        workspaces: {
          "ws-yash-staging-1": {
            id: "ws-yash-staging-1",
            kind: "user-hosted",
            workspace_name: "Yash staging",
            directory: "/workspace",
          },
        },
      },
    ])
    // The home page sorts recent projects by time.updated — a missing `time`
    // crashes the whole app, so every project must carry numeric created/updated.
    const time = projects[0].time as { created: number; updated: number }
    expect(typeof time.created).toBe("number")
    expect(typeof time.updated).toBe("number")
  })

  test("/api/claxedo/bootstrap aggregates a healthy boot payload with signed projects", async () => {
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(
      new Request("http://cp.test/api/claxedo/bootstrap", {
        headers: { authorization: "Bearer user_1" },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      healthy: true,
      version: "1.0.0",
      path: { home: "", state: "", config: "", worktree: "", directory: "" },
      provider: { all: [], default: {}, connected: [] },
      provider_auth: {},
      config: {},
      config_providers: { providers: [], default: {} },
    })
    const project = body.project as Array<Record<string, unknown>>
    expect(project).toHaveLength(1)
    expect(project[0]).toMatchObject({ id: "ws-yash-staging-1" })

    // Anonymous bootstrap is still healthy with an empty project inventory.
    const anonymous = await app.fetch(new Request("http://cp.test/api/claxedo/bootstrap"))
    expect(anonymous.status).toBe(200)
    expect(await anonymous.json()).toMatchObject({ healthy: true, project: [] })
  })

  test("signed bootstrap schedules idempotent WorkGraph owner activation without delaying boot", async () => {
    const plane = fakePlane()
    let finish!: () => void
    const activation = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        status: "pending" as const,
        error: {
          code: "execution_capabilities_unavailable",
          capability: "catalog_workspace",
          reason: "runtime_unavailable",
          message: "Catalog provisioning is still running",
          retryable: true,
        },
      }
    })
    const waitUntil = vi.fn()
    const app = createHostedApp(plane, { workGraphOwnerActivation: activation })
    const response = await app.fetch(
      new Request("http://cp.test/api/claxedo/bootstrap", {
        headers: { authorization: "Bearer owner_a" },
      }),
      {},
      { waitUntil, passThroughOnException: vi.fn() } as never,
    )
    expect(response.status).toBe(200)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(activation).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ subject: "owner_a" }) }),
    )
    finish()
    await Promise.all(waitUntil.mock.calls.map((call) => call[0]))
    expect(plane.services.telemetry.capture).toHaveBeenCalledWith("owner_a", "workgraph.catalog_activation", {
      status: "pending",
      code: "execution_capabilities_unavailable",
      capability: "catalog_workspace",
      reason: "runtime_unavailable",
      retryable: true,
    })

    const anonymous = await app.fetch(new Request("http://cp.test/api/claxedo/bootstrap"), {}, {
      waitUntil,
      passThroughOnException: vi.fn(),
    } as never)
    expect(anonymous.status).toBe(200)
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  test("hosted central event routes require the control-plane bearer", async () => {
    const app = createHostedApp(fakePlane())
    for (const path of ["/api/claxedo/events", "/api/wr/events", "/global/event"]) {
      const res = await app.fetch(new Request(`http://cp.test${path}`))
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    }
  })

  test("hosted central event routes stream an immediate heartbeat in the bus envelope", async () => {
    const app = createHostedApp(fakePlane())
    for (const path of ["/api/claxedo/events", "/api/wr/events", "/global/event"]) {
      const res = await app.fetch(
        new Request(`http://cp.test${path}`, {
          headers: { authorization: "Bearer user_1", accept: "text/event-stream" },
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const reader = res.body!.getReader()
      const first = await reader.read()
      // The bootstrap frame carries an `id:` so the client's SSE cursor is
      // armed from the first byte, matching the three resumable streams. This
      // composition binds no LiveSyncRoom, so it is the heartbeat-only fallback
      // and the cursor is whatever the caller presented (nothing here → "0").
      expect(new TextDecoder().decode(first.value)).toBe(`id: 0\ndata: ${JSON.stringify({ type: "heartbeat" })}\n\n`)
      await reader.cancel()
    }
  })

  test("the fallback event stream echoes the caller's cursor instead of rewinding it", async () => {
    // The fallback buffers nothing (it has no publisher at all), but it must
    // not walk a reconnecting client's cursor backwards to 0 — that would make
    // the client's next resume address a position it has already passed.
    const app = createHostedApp(fakePlane())
    const res = await app.fetch(
      new Request("http://cp.test/api/claxedo/events", {
        headers: { authorization: "Bearer user_1", accept: "text/event-stream", "Last-Event-ID": "42" },
      }),
    )
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(`id: 42\ndata: ${JSON.stringify({ type: "heartbeat" })}\n\n`)
    await reader.cancel()
  })

  // D9 fail-closed hosted boot: the hosted app refuses to compose unless the
  // deployment declares CLAXEDO_DEPLOYMENT_MODE=hosted AND signed auth plus a
  // workspace authority are composed. worker.ts maps the thrown
  // HostedWorkerCompositionError to a 503 for every request (down, not open).
  test("refuses to compose when CLAXEDO_DEPLOYMENT_MODE is absent", () => {
    const plane = fakePlane()
    plane.env = {}
    expect(() => createHostedApp(plane)).toThrowError(/CLAXEDO_DEPLOYMENT_MODE=hosted/)
  })

  test("refuses to compose when CLAXEDO_DEPLOYMENT_MODE is local or invalid", () => {
    const local = fakePlane()
    local.env = { CLAXEDO_DEPLOYMENT_MODE: "local" }
    expect(() => createHostedApp(local)).toThrowError(/CLAXEDO_DEPLOYMENT_MODE=hosted/)

    const typo = fakePlane()
    typo.env = { CLAXEDO_DEPLOYMENT_MODE: "production" }
    expect(() => createHostedApp(typo)).toThrowError(/must be "local" or "hosted"/)
  })

  test("rejects the retired self-host value by name, pointing at local", () => {
    // A stale deploy manifest is the one place "self-host" survives. It must
    // fail loudly with the replacement named, never fall back to an open posture.
    const retired = fakePlane()
    retired.env = { CLAXEDO_DEPLOYMENT_MODE: "self-host" }
    expect(() => createHostedApp(retired)).toThrowError(/was renamed to "local"/)
  })

  test("refuses to compose without signed auth or a workspace authority, naming every missing piece", () => {
    const plane = fakePlane()
    ;(plane.services.auth as { config: unknown }).config = {
      enabled: false,
      mode: "local-only",
      reason: "signed/cloud auth is disabled",
    }
    ;(plane.services as { authority?: unknown }).authority = undefined
    let thrown: Error | undefined
    try {
      createHostedApp(plane)
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown?.message).toMatch(/signed auth is not enabled/)
    expect(thrown?.message).toMatch(/no workspace authority/)
  })

  /**
   * Security review 2026-07-27 §6.14, follow-up.
   *
   * `HostedWorkspaceRouteOptions.sandboxEgressExtraHosts` is the operator
   * escape hatch for widening the hosted sandbox egress allowlist, and it was
   * declared but wired to nothing: an operator had no way to reach it, so a
   * deployment needing a private registry had to either patch the baseline or
   * give up on containment. These tests run the env var down the WHOLE path —
   * plane env → `createHostedApp` → route options → `hostedSandboxNetworkPolicy`
   * → `SandboxManager.ensure` → the driver — because an assertion on the
   * composed options object would pass just as happily while the manager or
   * the policy builder dropped the hosts on the way down.
   */
  describe("hosted sandbox egress allowlist", () => {
    function egressPlane(env: Record<string, string | undefined> = {}) {
      const seen: SandboxDriverEnsureInput[] = []
      const driver: SandboxDriver = {
        // Unique per suite: `createSandboxManager` dedupes its composition-time
        // egress warning on driver id process-wide.
        id: "hosted-app-egress-test",
        ensureHost: vi.fn(async (input: SandboxDriverEnsureInput) => {
          seen.push(input)
          return {
            sandboxId: `sandbox_${input.workspaceId}`,
            url: `https://runtime.test/${input.workspaceId}`,
            hostId: `host_${input.workspaceId}`,
            labels: input.labels,
          }
        }),
        metadata: {
          driverRunsIn: ["worker"],
          hostStopBehavior: "suspends-host",
          hostResumeBehavior: "same-host",
          targetAccess: "relay",
          secretBrokering: "native",
          // Enforcing, so the manager passes `net` down instead of withholding
          // it — this suite is about the allowlist's CONTENTS.
          egressControl: "hosts-and-cidrs",
          persistence: {
            resume: "same-sandbox",
            capture: "none",
            clone: false,
            captureSource: "not-applicable",
            retention: "not-applicable",
            restoreMount: "not-applicable",
          },
        },
      }
      const plane = fakePlane({
        sandboxManager: createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver }),
      })
      plane.env = { ...plane.env, ...env }
      ;(plane.services.authority as unknown as { createCloudWorkspace: unknown }).createCloudWorkspace = vi.fn(
        async () => ({ workspace_id: "ignored" }),
      )
      // Lease-tenant stamping and the Convex lease counter both reach out; both
      // swallow their own failures, but no test may touch the network.
      globalThis.fetch = vi.fn(
        async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      ) as unknown as typeof globalThis.fetch
      return { plane, seen }
    }

    async function createCloudWorkspace(plane: HostedControlPlane) {
      const app = createHostedApp(plane, { entitlementGate: async () => undefined })
      const res = await app.fetch(
        new Request("http://cp.test/api/workspace/create", {
          method: "POST",
          headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
          body: JSON.stringify({ projectId: "proj_1", repoUrl: "https://github.com/acme/widgets.git" }),
        }),
      )
      // `ensure` is fire-and-forget so a cold start never blocks the response;
      // let the kicked-off promise settle before asserting on the driver.
      await new Promise((resolve) => setTimeout(resolve, 0))
      return res
    }

    test("CLAXEDO_SANDBOX_EGRESS_EXTRA_HOSTS reaches the driver's allowlist", async () => {
      const { plane, seen } = egressPlane({
        // Padded and with an empty entry, because operators write env vars by
        // hand: trimming and blank-dropping are part of the contract.
        CLAXEDO_SANDBOX_EGRESS_EXTRA_HOSTS: " npm.acme.internal , models.acme.internal ,, ",
      })
      const res = await createCloudWorkspace(plane)

      expect(res.status).toBe(200)
      expect(seen).toHaveLength(1)
      const hosts = seen[0]!.net!.hosts ?? []
      expect(hosts).toContain("npm.acme.internal")
      expect(hosts).toContain("models.acme.internal")
      expect(hosts).not.toContain("")
      // Widening is ADDITIVE — the reviewed baseline is still there.
      expect(hosts).toContain("api.anthropic.com")
      expect(hosts).toContain("github.com")
      expect(seen[0]!.net!.mode).toBe("restricted")
    })

    test("unset leaves the reviewed baseline exactly as it is", async () => {
      // The assertion that fails if the wiring ever defaults to something:
      // absent config must not widen the allowlist by a single host.
      const { plane, seen } = egressPlane()
      const withNothing = egressPlane({ CLAXEDO_SANDBOX_EGRESS_EXTRA_HOSTS: "  , ," })

      expect((await createCloudWorkspace(plane)).status).toBe(200)
      expect((await createCloudWorkspace(withNothing.plane)).status).toBe(200)

      expect(withNothing.seen[0]!.net!.hosts).toEqual(seen[0]!.net!.hosts)
      expect(seen[0]!.net!.mode).toBe("restricted")
      // Still not a rubber stamp: the exclusions the policy exists for hold.
      for (const denied of ["storage.googleapis.com", "r2.cloudflarestorage.com", "*.workers.dev"]) {
        expect(seen[0]!.net!.hosts ?? []).not.toContain(denied)
      }
    })
  })

  test("unsigned requests never fall through as unsigned-local even if a disabled config reached serving", async () => {
    // Defense-in-depth for the global guard: bypass the boot assertion by
    // constructing the app first, then flipping the config object the routes
    // captured — the guard must still answer 503, not serve unsigned-local.
    const plane = fakePlane()
    const config = plane.services.auth.config as { enabled: boolean; mode?: string; reason?: string }
    const app = createHostedApp(plane)
    config.enabled = false
    config.mode = "local-only"
    config.reason = "signed/cloud auth is disabled"
    for (const url of ["http://cp.test/api/claxedo/health", "http://127.0.0.1/api/claxedo/health"]) {
      const res = await app.fetch(new Request(url))
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: "hosted_unsigned_rejected" } })
    }
  })
})

// ─── Live-sync org identity — end-to-end delivery ───────────────────────────
//
// The event plane's canonical org identity is the AUTHORITY-INTERNAL org id:
// events are stamped with it (documents routes via `authority.resolveOrgId`,
// runtime-token claims via the launch tenant) and the hosted events route
// resolves the SAME id at connect to key the subscriber's room and visibility.
// These tests pin the two deliveries the earlier Clerk-claims room keying made
// impossible: an org-stamped document.changed reaching a signed subscriber,
// and an agent run-operation nudge reaching a subscriber whose bearer
// carries an active-org Clerk claim.

// In-memory DO namespace holding REAL LiveSyncRoom instances, one per name —
// the same single-instance-per-name contract the Workers runtime provides.
function liveRoomNamespace() {
  const instances = new Map<string, InstanceType<typeof LiveSyncRoom>>()
  return {
    instances,
    idFromName: (name: string) => name,
    get(id: unknown) {
      const name = id as string
      let room = instances.get(name)
      if (!room) {
        room = new LiveSyncRoom({}, {})
        instances.set(name, room)
      }
      const instance = room
      return { fetch: (request: Request) => instance.fetch(request) }
    },
  } satisfies LiveSyncRoomNamespace & { instances: Map<string, InstanceType<typeof LiveSyncRoom>> }
}

// One SSE frame per read (the room writes one enqueue per frame).
async function readLiveSyncFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const { value, done } = await reader.read()
  if (done || !value) throw new Error("live-sync stream ended before a frame arrived")
  const data = new TextDecoder()
    .decode(value)
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
  return JSON.parse(data)
}

/**
 * A plane whose bearer carries an ACTIVE-ORG Clerk claim (`org_2clerkacme`,
 * the CLAIMS namespace) which the authority resolves to the INTERNAL org id
 * (`org_internal_acme`, the namespace events are stamped with and rooms are
 * keyed by). The two values are deliberately distinct so a regression back to
 * keying anything off the Clerk claim cannot pass by coincidence.
 */
function activeOrgPlane() {
  const plane = fakePlane()
  const services = plane.services as unknown as {
    auth: { verifier: (token: string) => Promise<unknown> }
    authority: {
      resolveOrgId: (auth: { user: { subject: string; orgId?: string } }) => Promise<string>
      authorizeProject: (auth: unknown, args: { orgId?: string }) => Promise<unknown>
    }
  }
  services.auth.verifier = async (token: string) => ({
    mode: "signed",
    user: {
      subject: token,
      tokenIdentifier: `https://clerk.test|${token}`,
      issuer: "https://clerk.test",
      orgId: "org_2clerkacme",
    },
  })
  services.authority.resolveOrgId = async (auth) =>
    auth.user.orgId === "org_2clerkacme" ? "org_internal_acme" : `org_${auth.user.subject}`
  services.authority.authorizeProject = async (_auth, args) =>
    args.orgId === "org_internal_acme" ? { ok: true, role: "editor", orgId: args.orgId } : { ok: false }
  return plane
}

describe("hosted live-sync delivery — internal org identity end-to-end", () => {
  afterEach(() => {
    configureCliSessionTokenRegistry(undefined)
  })

  test("delivers document.changed through the LiveSyncRoom to a signed active-org subscriber", async () => {
    const namespace = liveRoomNamespace()
    const entry = {
      id: "document_1",
      org_id: "org_internal_acme",
      project_id: "proj_1",
      display_name: "Launch checklist",
      origin_kind: "managed",
      placement_kind: "hosted",
      placement_id: "hosted",
      status: "draft",
      archived_at: null,
    }
    const documentsBackend = {
      index: {
        find: async (orgId: string, documentId: string) =>
          orgId === "org_internal_acme" && documentId === "document_1" ? entry : undefined,
        transitionStatus: async (_scope: unknown, _documentId: string, status: string) => ({ ...entry, status }),
      },
    } as unknown as DocumentsRouteBackend
    const app = createHostedApp(activeOrgPlane(), { liveSyncRoom: namespace, documentsBackend })

    const stream = await app.fetch(
      new Request("http://cp.test/api/claxedo/events", {
        headers: { authorization: "Bearer member", accept: "text/event-stream" },
      }),
    )
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    expect(await readLiveSyncFrame(reader)).toEqual({ type: "heartbeat" })
    // The subscriber's room is keyed by the RESOLVED internal org id, not the
    // bearer's Clerk claim.
    expect([...namespace.instances.keys()]).toEqual(["org:org_internal_acme"])

    const mutation = await app.fetch(
      new Request("http://cp.test/documents/document_1/status", {
        method: "POST",
        headers: { authorization: "Bearer member", "content-type": "application/json" },
        body: JSON.stringify({ status: "review" }),
      }),
    )
    expect(mutation.status).toBe(200)

    // The documents route stamped the event with the internal org id; the
    // room's per-connection filter compares it against the id the subscriber
    // resolved at connect — the frame arrives.
    expect(await readLiveSyncFrame(reader)).toMatchObject({
      type: "document.changed",
      documentId: "document_1",
      orgId: "org_internal_acme",
      projectId: "proj_1",
    })
    await reader.cancel()
  })

  test("an agent run-operation nudge reaches a subscriber connected with an active-org token", async () => {
    const keyPair = await generateKeyPair("EdDSA", { extractable: true })
    const namespace = liveRoomNamespace()
    const plane = activeOrgPlane()
    plane.env = { ...plane.env, CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(keyPair.publicKey) }
    const app = createHostedApp(plane, {
      liveSyncRoom: namespace,
      workGraphExecutor: {
        query: async () => ({}),
        mutation: async () => ({ ok: true, operationId: "op_checkpoint_1", cursor: "1", value: {} }),
      },
    })

    const stream = await app.fetch(
      new Request("http://cp.test/api/claxedo/events", {
        headers: { authorization: "Bearer member", accept: "text/event-stream" },
      }),
    )
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    expect(await readLiveSyncFrame(reader)).toEqual({ type: "heartbeat" })
    expect([...namespace.instances.keys()]).toEqual(["org:org_internal_acme"])

    // The runtime access token carries exactly what hosted launches mint: the
    // owner's Clerk subject and the WorkGraph tenant's INTERNAL org id.
    const token = await mintRuntimeAccessToken(
      { subject: "member", orgId: "org_internal_acme", workspaceId: "ws_wg_stream_1", hostId: "host_1", role: "owner" },
      keyPair.privateKey,
      "EdDSA",
    )
    const operation = await app.fetch(
      new Request("http://cp.test/internal/workgraph/run-operation", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          identity: { runId: "run_1", sessionId: "ses_1", workspaceId: "ws_wg_stream_1", generation: 1 },
          operation: {
            type: "record_checkpoint",
            operationId: "op_checkpoint_1",
            level: "progress",
            summary: "Landed the fix",
            evidenceIds: [],
          },
        }),
      }),
    )
    expect(operation.status).toBe(200)
    await expect(operation.json()).resolves.toMatchObject({ ok: true })

    // The nudge names the tenant's org room from the token's internal org id —
    // the SAME room the active-org subscriber is held in — and the room's
    // subject filter narrows the doorbell to the owner's own connections.
    expect(await readLiveSyncFrame(reader)).toMatchObject({ type: "workgraph.changed", ownerUserId: "member" })
    await reader.cancel()
  })
})
