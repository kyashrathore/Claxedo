import fs from "node:fs"
import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import type { SessionWriteMode } from "@claxedo/server-core/platform/runtime/profile"
import { createDurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import { createProjectionStore } from "./projection-store"
import { controlPlaneAuthContext, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import {
  ControlPlaneCompositionError,
  createControlPlaneServices,
  createHostedControlPlaneServices,
  type HostedControlPlaneServicesOptions,
  type WorkspaceAuthority,
} from "./services"
import { testManagedSessionAuthority } from "../test-support/managed-session-authority"

function fakePorts(sync = fakeSync()) {
  return {
    projectionStore: createProjectionStore(sync),
    durableSessionLog: createDurableSessionLog(sync),
    sessionWriteMode: sync.mode as () => SessionWriteMode,
  }
}

function fakeSync() {
  return {
    mode: () => "central_canonical",
    sync_session_meta: vi.fn(async () => {}),
    sync_session_metas: vi.fn(async () => {}),
    sync_session_messages: vi.fn(async () => {}),
    put_session_meta: vi.fn(async () => {}),
    delete_session_meta: vi.fn(async () => {}),
    session_meta: vi.fn(async (_sessionID: string): Promise<SessionMeta | undefined> => undefined),
    session_metas: vi.fn(async () => new Map()),
    list_session_metas: vi.fn(async () => []),
    tagged_session_metas: vi.fn(async () => []),
    persist_message_event: vi.fn(),
    read_session_messages: vi.fn(() => []),
    // The central-store backend requires `read_session_max_event_ordinal` for
    // message-replay sequencing; mocks were missing it.
    read_session_max_event_ordinal: vi.fn(() => 0),
  }
}

function hostedOptions(
  overrides: Partial<HostedControlPlaneServicesOptions> = {},
): HostedControlPlaneServicesOptions {
  return {
    auth: {
      config: {
        enabled: true,
        issuer: "https://issuer.example.test",
        jwksUrl: "https://issuer.example.test/.well-known/jwks.json",
      },
      verifier: vi.fn(),
    },
    credentials: {
      listCredentials: vi.fn(async () => []),
      getCredentialByProvider: vi.fn(async () => undefined),
      putCredential: vi.fn(async (input) => ({
        id: `cred_${input.provider_id}`,
        provider_id: input.provider_id,
        kind: input.kind,
        source: input.source,
        secure_ref: "hosted:secret",
        status: "available" as const,
        created_at: 1,
        updated_at: 1,
        revision: 1,
      })),
      deleteCredential: vi.fn(async () => true),
      deleteCredentialsByProvider: vi.fn(async () => 0),
      updateCredentialStatus: vi.fn(async () => {}),
      syncLocalCredentials: vi.fn(async () => ({ synced: [], existing: [], missing: [], failed: [] })),
    },
    relay: {
      relayUrl: "https://relay.example.test",
      resolverToken: "resolver-secret",
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
    },
    sandbox: { defaultDriver: "daytona" },
    telemetry: { capture: vi.fn() },
    authority: fakeAuthority(),
    ...overrides,
  }
}

function fakeAuthority(): WorkspaceAuthority {
  const fn = () => vi.fn()
  return testManagedSessionAuthority({
    usersMe: fn(),
    listOrgs: fn(),
    resolveOrgId: fn(),
    projectRole: fn(),
    authorizeProject: fn(),
    authorizeChannelProject: fn(),
    authorizeChannelWorkspace: fn(),
    authorizeWorkspaceOpen: fn(),
    openWorkspace: fn(),
    listWorkspaces: fn(),
    registerLocalForSharing: fn(),
    deleteWorkspace: fn(),
    createCloudWorkspace: fn(),
    grantWorkspaceShare: fn(),
    revokeWorkspaceShare: fn(),
    authorizeSessionRead: fn(),
    listSessions: fn(),
    readSessionMessages: fn(),
    syncSessionMessages: fn(),
    upsertSessionVisibility: fn(),
    replaceSessionVisibility: fn(),
    deleteSessionVisibility: fn(),
    recordRuntimeAccessToken: fn(),
    runtimeAccessTokenActive: fn(),
    revokeRuntimeAccessToken: fn(),
    revokeRuntimeAccessTokensForWorkspaceUser: fn(),
    auditAllow: fn(),
    auditDeny: fn(),
  })
}

describe("control-plane services", () => {
  test("uses injected central-store ports when provided", () => {
    const sync = fakeSync()
    const services = createControlPlaneServices(fakePorts(sync))

    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
    expect(services.projectionStore.read_session_messages).toBe(sync.read_session_messages)
  })

  test("central-store ports are accepted as the composition input and delegate to the backend", () => {
    // The seam is ports-in: callers pass the ports, and the composition holds
    // no injected bag of its own.
    const sync = fakeSync()
    const services = createControlPlaneServices(fakePorts(sync))

    // Every projection-store port method is the raw backend method (identity),
    // so a call on the port is literally a call on the injected bag.
    expect(services.projectionStore.sync_session_meta).toBe(sync.sync_session_meta)
    expect(services.projectionStore.sync_session_metas).toBe(sync.sync_session_metas)
    expect(services.projectionStore.sync_session_messages).toBe(sync.sync_session_messages)
    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
    expect(services.projectionStore.delete_session_meta).toBe(sync.delete_session_meta)
    expect(services.projectionStore.session_meta).toBe(sync.session_meta)
    expect(services.projectionStore.session_metas).toBe(sync.session_metas)
    expect(services.projectionStore.list_session_metas).toBe(sync.list_session_metas)
    expect(services.projectionStore.tagged_session_metas).toBe(sync.tagged_session_metas)
    expect(services.projectionStore.read_session_messages).toBe(sync.read_session_messages)
    expect(services.projectionStore.read_session_max_event_ordinal).toBe(
      sync.read_session_max_event_ordinal,
    )

    // Durable-session-log ports delegate to the backend replay methods.
    expect(services.durableSessionLog.persist_message_event).toBe(sync.persist_message_event)

    // Behavioral delegation: invoking a port method actually calls the stub.
    void services.projectionStore.sync_session_meta(undefined, { id: "s1" })
    expect(sync.sync_session_meta).toHaveBeenCalledWith(undefined, { id: "s1" })
    services.durableSessionLog.persist_message_event("s1", { type: "x" })
    expect(sync.persist_message_event).toHaveBeenCalledWith("s1", { type: "x" })
  })

  test("an injected authority is returned unchanged by service composition", () => {
    // Plain composition passthrough: whatever authority bag is injected comes
    // back on `services.authority` by identity, regardless of env.
    const authority = { getWorkspace: vi.fn() } as never
    const services = createControlPlaneServices(fakePorts(), {
      authority: authority,
    })
    expect(services.authority).toBe(authority)

    // The hosted `requiredHostedDependency` path also returns it unchanged
    // (it passes the "workspace authority" required-dependency
    // check and lands on the composed services by identity).
    const hostedAuthority = hostedOptions().authority
    const hosted = createHostedControlPlaneServices(fakePorts(), hostedOptions({
      authority: hostedAuthority,
    }))
    expect(hosted.authority).toBe(hostedAuthority)
  })

  test("composes auth explicitly and accepts an adapter override", async () => {
    const services = createControlPlaneServices(fakePorts(), {
      auth: localOnlyAuthAdapter("test composition"),
    })

    await expect(controlPlaneAuthContext(new Request("http://localhost"), services.auth)).resolves.toEqual({
      mode: "unsigned-local",
      reason: "test composition",
    })
  })

  test("accepts explicit store, credentials, relay, sandbox, and telemetry inputs", () => {
    const base = createControlPlaneServices(fakePorts(), { authority: null })
    const capture = vi.fn()
    const credentials = {} as never
    const runtimeAccessTokenSigner = vi.fn() as never
    const hostTunnelTokenSigner = vi.fn() as never
    const services = createControlPlaneServices(
      { projectionStore: base.projectionStore, durableSessionLog: base.durableSessionLog },
      {
      credentials,
      relay: {
        relayUrl: "https://relay.example.test",
        resolverToken: "resolver-secret",
        runtimeAccessTokenSigner,
        hostTunnelTokenSigner,
      },
      sandbox: { defaultDriver: "daytona" },
      telemetry: { capture },
    })

    expect(services.projectionStore).toBe(base.projectionStore)
    expect(services.durableSessionLog).toBe(base.durableSessionLog)
    expect(services.credentials).toBe(credentials)
    expect(services.relay).toMatchObject({
      relayUrl: "https://relay.example.test",
      resolverToken: "resolver-secret",
    })
    expect(services.relay.runtimeAccessTokenSigner).toBe(runtimeAccessTokenSigner)
    expect(services.relay.hostTunnelTokenSigner).toBe(hostTunnelTokenSigner)
    expect(services.sandbox).toEqual({ defaultDriver: "daytona" })
    services.telemetry.capture("user_1", "event")
    expect(capture).toHaveBeenCalledWith("user_1", "event")
  })

  test("accepts an explicit authority override regardless of env", () => {
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const fakeAuthority = { getWorkspace: vi.fn() } as never
      const services = createControlPlaneServices(fakePorts(), {
        authority: fakeAuthority,
      })
      expect(services.authority).toBe(fakeAuthority)
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
    }
  })

  test("creates a hosted stack from explicit auth, store, credentials, relay, runtime host, and telemetry", () => {
    const sync = fakeSync()
    const options = hostedOptions()
    const services = createHostedControlPlaneServices(fakePorts(sync), options)

    expect(services.auth).toBe(options.auth)
    expect(services.credentials).toBe(options.credentials)
    expect(services.relay).toBe(options.relay)
    expect(services.sandbox).toBe(options.sandbox)
    expect(services.telemetry).toBe(options.telemetry)
    expect(services.localExecution).toEqual({ enabled: false })
    expect(services.authority).toBe(options.authority)
    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
  })

  test("hosted stack rejects missing required hosted dependencies with clear errors", () => {
    for (const item of [
      {
        options: () => ({ ...hostedOptions(), auth: null as never }),
        message: "Hosted Control Plane requires signed auth",
      },
      {
        options: () => ({ ...hostedOptions(), authority: null as never }),
        message: "Hosted Control Plane requires workspace authority",
      },
      {
        options: () => ({ ...hostedOptions(), credentials: null as never }),
        message: "Hosted Control Plane requires shared credentials",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, relayUrl: undefined } }),
        message: "Hosted Control Plane requires hosted relay URL",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, resolverToken: undefined } }),
        message: "Hosted Control Plane requires Relay resolver token",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, runtimeAccessTokenSigner: undefined } }),
        message: "Hosted Control Plane requires Runtime Access Token signer",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, hostTunnelTokenSigner: undefined } }),
        message: "Hosted Control Plane requires Host Tunnel Token signer",
      },
      {
        options: () => ({ ...hostedOptions(), sandbox: { defaultDriver: undefined } }),
        message: "Hosted Control Plane requires sandbox driver",
      },
      {
        options: () => ({ ...hostedOptions(), telemetry: { capture: undefined as never } }),
        message: "Hosted Control Plane requires audit/telemetry capture",
      },
    ]) {
      expect(() => createHostedControlPlaneServices(fakePorts(), item.options())).toThrow(
        new ControlPlaneCompositionError("hosted_dependency_missing", item.message),
      )
    }
  })

  test("hosted stack rejects disabled auth and workspace-replicated session storage", () => {
    expect(() =>
      createHostedControlPlaneServices(fakePorts(), {
        ...hostedOptions(),
        auth: localOnlyAuthAdapter("signed auth disabled in test"),
      }),
    ).toThrow(new ControlPlaneCompositionError(
      "hosted_auth_disabled",
      "Hosted Control Plane requires enabled signed auth: signed auth disabled in test",
    ))

    expect(() =>
      createHostedControlPlaneServices({
        ...fakePorts(),
        sessionWriteMode: () => "workspace_replicated",
      }, hostedOptions()),
    ).toThrow(new ControlPlaneCompositionError(
      "hosted_sync_mode_invalid",
      "Hosted Control Plane requires central_canonical session storage",
    ))
  })

  test("explicit null override leaves authority unset regardless of env", () => {
    // The generic services never construct an authority; the composition site
    // injects it. `null` explicitly leaves it unset even when env is present.
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "https://example.authority.test"
    try {
      const services = createControlPlaneServices(fakePorts(), {
        authority: null,
      })
      expect(services.authority).toBeUndefined()
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
      else delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    }
  })

  test("authority is only present when injected, never derived from env", () => {
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "https://ambient.authority.test"
    try {
      // Ambient env does not materialize an authority.
      expect(createControlPlaneServices(fakePorts()).authority).toBeUndefined()
      // Only an explicitly injected authority lands on the composed services.
      const injected = fakeAuthority()
      expect(createControlPlaneServices(fakePorts(), {
        authority: injected,
      }).authority).toBe(injected)
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
      else delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    }
  })

  test("default behavior is preserved when no options are supplied", () => {
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const services = createControlPlaneServices(fakePorts())
      expect(services.authority).toBeUndefined()
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
    }
  })

  test("the composition records local session metadata, and does it before the runtime proxy", () => {
    // The control plane is the source of truth for the local session list, and
    // the tap is what fills it. It adds no route, so dropping it changes
    // nothing about the route table and no other test in this repository
    // notices — verified by mutation: deleting the call fails nothing else.
    //
    // Order is load-bearing too: the workspace runtime proxy answers
    // `/session` itself, so a tap registered after it never sees the call and
    // the session list silently stops filling.
    const text = fs.readFileSync(
      path.resolve(import.meta.dirname, "../deployments/self-hosted-node/app.ts"),
      "utf8",
    )
    const tap = text.indexOf("app.use(sessionMetaProjectionTap(")
    const proxy = text.indexOf("app.use(workspaceRuntimeProxy)")

    expect(tap, "createSelfHostedApp must record local session metadata").toBeGreaterThan(-1)
    expect(proxy, "createSelfHostedApp must mount the workspace runtime proxy").toBeGreaterThan(-1)
    expect(tap, "the session-meta tap must be registered BEFORE the runtime proxy").toBeLessThan(proxy)
  })

  test("local composition ignores ambient signed-auth env without embedded auth", async () => {
    // Ambient signed env without CLAXEDO_EMBEDDED_AUTH does not fail closed:
    // the default local composition boots local-only on SQLite. Only
    // embedded Better Auth selects signed mode.
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/self-hosted-node/app")
    const previous = {
      signed: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
      authority: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
      embedded: process.env.CLAXEDO_EMBEDDED_AUTH,
    }
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "true"
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    delete process.env.CLAXEDO_EMBEDDED_AUTH
    try {
      const services = createDefaultLocalControlPlaneServices()
      expect(services.auth.config).toEqual({
        enabled: false,
        mode: "local-only",
        reason: "no auth adapter configured",
      })
      services.close()
    } finally {
      for (const [key, value] of [
        ["CLAXEDO_SIGNED_CLOUD_AUTH", previous.signed],
        ["CLAXEDO_WORKSPACE_AUTHORITY_URL", previous.authority],
        ["CLAXEDO_EMBEDDED_AUTH", previous.embedded],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test("local composition does not expose signers from a private key without its public pair", async () => {
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/self-hosted-node/app")
    const previous = {
      privateKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
      publicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
    }
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = "private-only"
    delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    try {
      const services = createDefaultLocalControlPlaneServices()
      expect(services.relay.runtimeAccessTokenSigner).toBeUndefined()
      expect(services.relay.hostTunnelTokenSigner).toBeUndefined()
    } finally {
      if (previous.privateKey) process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = previous.privateKey
      else delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM
      if (previous.publicKey) process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = previous.publicKey
      else delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    }
  })

  test("agent session routes are no longer owned by the control plane", () => {
    const route = path.resolve(import.meta.dirname, "../routes/agent-session.ts")
    const server = fs.readFileSync(path.resolve(import.meta.dirname, "../deployments/self-hosted-node/app.ts"), "utf8")

    expect(fs.existsSync(route)).toBe(false)
    expect(server).not.toContain("AgentSessionRoutes(")
    expect(server).toContain("workspaceRuntimeProxy")
  })

  test("runtime-facing server files do not reach around control-plane ports", () => {
    const files = [
      path.resolve(import.meta.dirname, "../deployments/self-hosted-node/app.ts"),
      path.resolve(import.meta.dirname, "../../../claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts"),
    ]

    for (const file of files) {
      const text = fs.readFileSync(file, "utf8")
      expect(text).not.toContain("services.sync")
      expect(text).not.toContain("import type { SyncDB }")
    }
  })

  test("createSelfHostedApp accepts an injected ControlPlaneServices and returns app + websocket", async () => {
    const { createSelfHostedApp } = await import("../deployments/self-hosted-node/app")
    const sync = fakeSync()
    const services = createControlPlaneServices(fakePorts(sync), {
      authority: testManagedSessionAuthority(),
      relay: { resolverToken: "expected-relay-token" },
    })
    const built = createSelfHostedApp(services)
    expect(typeof built.app.fetch).toBe("function")
    expect(typeof built.injectWebSocket).toBe("function")

    const previous = {
      publicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
      nextPublicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM,
    }
    delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM
    try {
      const jwks = await built.app.request("/.well-known/jwks.json")
      expect(jwks.status).toBe(503)
      await expect(jwks.json()).resolves.toMatchObject({
        error: { code: "jwks_no_keys_configured" },
      })

      const resolver = await built.app.request("/internal/relay/revocation?jti=jti_1&workspaceId=ws_1&hostId=host_1")
      expect(resolver.status).toBe(401)
      await expect(resolver.json()).resolves.toMatchObject({
        error: { code: "relay_resolver_unauthorized" },
      })

      // The global unsigned-local guard is the primary gate for non-loopback
      // unsigned requests; the per-route local-only projection is
      // defense-in-depth behind it.
      const bootstrap = await built.app.request("https://control.example.test/api/claxedo/bootstrap", {
        headers: { authorization: "Bearer unsigned-local-test" },
      })
      expect(bootstrap.status).toBe(403)
      await expect(bootstrap.json()).resolves.toMatchObject({
        error: { code: "unsigned_local_loopback_required" },
      })

      const track = await built.app.request("/api/claxedo/track", {
        method: "POST",
        body: JSON.stringify({ event: "missing distinct id" }),
      })
      expect(track.status).toBe(400)
      await expect(track.json()).resolves.toMatchObject({
        error: { code: "telemetry_invalid_body" },
      })
    } finally {
      if (previous.publicKey) process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = previous.publicKey
      else delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
      if (previous.nextPublicKey) process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM = previous.nextPublicKey
      else delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM
    }
  })


  test("createSelfHostedApp gates remote central runtime events with signed auth", async () => {
    const { createSelfHostedApp } = await import("../deployments/self-hosted-node/app")
    const built = createSelfHostedApp(createControlPlaneServices(fakePorts(), {
      authority: testManagedSessionAuthority(),
    }))

    // In an unsigned-local deployment a remote caller is denied by the
    // global unsigned-local guard before the per-route bearer gate; the
    // per-route gate remains as defense-in-depth behind it.
    const missing = await built.app.request("https://control.example.test/api/wr/events")

    expect(missing.status).toBe(403)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "unsigned_local_loopback_required" },
    })
  })

  test("createSelfHostedApp rejects hosted services so hosted security hooks cannot be bypassed", async () => {
    const { createSelfHostedApp } = await import("../deployments/self-hosted-node/app")
    expect(() =>
      createSelfHostedApp(createHostedControlPlaneServices(fakePorts(), hostedOptions()))
    ).toThrow(new ControlPlaneCompositionError(
      "self_host_app_required",
      "createSelfHostedApp is the self-host composition; use createHostedApp for hosted services",
    ))
  })

  test("startup telemetry captures non-secret control-plane composition facts", async () => {
    const { captureControlPlaneStartupTelemetry } = await import("../deployments/self-hosted-node/app")
    const capture = vi.fn()
    const services = createHostedControlPlaneServices(fakePorts(), hostedOptions({
      telemetry: { capture },
    }))

    captureControlPlaneStartupTelemetry(services, { port: 4987 })

    expect(capture).toHaveBeenCalledWith("control-plane", "control_plane.started", {
      port: 4987,
      authMode: "signed",
      signedAuth: true,
      sessionWriteMode: "central_canonical",
      hasWorkspaceAuthority: true,
      hasRelayUrl: true,
      hasRelayResolverToken: true,
      hasRuntimeAccessTokenSigner: true,
      hasHostTunnelTokenSigner: true,
      sandboxDriverId: "daytona",
    })
  })

  test("startup telemetry failures do not fail server startup", async () => {
    const { captureControlPlaneStartupTelemetry } = await import("../deployments/self-hosted-node/app")
    const services = createControlPlaneServices(fakePorts(), {
      authority: null,
      telemetry: {
        capture: () => {
          throw new Error("telemetry down")
        },
      },
    })

    expect(() =>
      captureControlPlaneStartupTelemetry(services, { port: 4987 })
    ).not.toThrow()
  })

  test("startServer is a thin wrapper that composes the default local stack", () => {
    const file = path.resolve(import.meta.dirname, "../deployments/self-hosted-node/app.ts")
    const text = fs.readFileSync(file, "utf8")

    // startServer configures local service defaults, then delegates to
    // the lower-level injected-service startup path.
    expect(text).toContain("export function startServer(")
    expect(text).toContain("return startControlPlaneStack({")
    expect(text).toContain("services: createDefaultLocalControlPlaneServices()")
    expect(text).toContain("createSqliteCentralStore({ mode: getSessionWriteMode })")
  })

  test("lower-level stack startup accepts injected services and centralizes shutdown cleanup", () => {
    const file = path.resolve(import.meta.dirname, "../deployments/self-hosted-node/app.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("export function startControlPlaneStack(options: ControlPlaneStackOptions)")
    expect(text).toContain("const services = options.services")
    expect(text).toContain("const built = createSelfHostedApp(services, {")
    expect(text).toContain("configureWorkspaceSupervisor({")
    expect(text).toContain("relay_url: services.relay.relayUrl")
    expect(text).toContain("default_sandbox_driver: services.sandbox.defaultDriver")
    expect(text).toContain("migrateCredentials()")
    expect(text).toContain("captureControlPlaneStartupTelemetry(services, { port })")
    expect(text).toContain("export async function shutdownControlPlaneRuntime()")
    expect(text).toContain("shutdownEmbeddedWorkspaceRuntimes()")
    expect(text).toContain("await shutdownWorkspaceSupervisor()")
    expect(text).toContain("await shutdownPostHog()")
    expect(text).toContain("await shutdownControlPlaneRuntime()")
  })

  test("workspace supervisor accepts an explicit default sandbox driver override", async () => {
    const supervisor = await import("../workspace/supervisor")
    const supervisorOptions = await import("../workspace/supervisor/options")
    supervisor.configureWorkspaceSupervisor({
      server_url: "http://127.0.0.1:0",
      default_sandbox_driver: "daytona",
    })
    expect(supervisorOptions.needWorkspaceSupervisorOptions().default_sandbox_driver).toBe("daytona")
  })

})
