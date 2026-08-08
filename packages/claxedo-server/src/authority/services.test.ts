import fs from "node:fs"
import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import type { SessionWriteMode } from "@claxedo/server-core/platform/runtime/profile"
import { createDurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import { createProjectionStore } from "./projection-store"
import { ControlPlaneAuthError, controlPlaneAuthContext, customVerifierAuthAdapter, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import {
  ControlPlaneCompositionError,
  createControlPlaneServices,
  createHostedControlPlaneServices,
  type HostedControlPlaneServicesOptions,
  type WorkspaceAuthority,
} from "./services"

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
    subscribe_message_replay: vi.fn(() => () => {}),
  }
}

function hostedOptions(
  overrides: Partial<HostedControlPlaneServicesOptions> = {},
): HostedControlPlaneServicesOptions {
  return {
    auth: {
      config: {
        enabled: true,
        issuer: "https://clerk.example.test",
        jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
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
      })),
      deleteCredential: vi.fn(async () => true),
      deleteCredentialsByProvider: vi.fn(async () => 0),
      updateCredentialStatus: vi.fn(async () => {}),
      syncLocalCredentials: vi.fn(async () => ({ synced: [], existing: [], missing: [], failed: [] })),
    },
    extensionPolicy: { agentExtensionPolicyOverrides: vi.fn(() => []) },
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
  return {
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
    createLocalHostLinkChallenge: fn(),
    registerLocalHostLink: fn(),
    heartbeatLocalHostLink: fn(),
    pauseLocalHostLink: fn(),
    activeLocalHostLink: fn(),
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
    listWorkspaceAgentExtensions: fn(),
    listWorkspaceAgentExtensionsForRuntime: fn(),
    authorizeWorkspaceAgentExtensionsAdmin: fn(),
    upsertWorkspaceAgentExtension: fn(),
    setWorkspaceAgentExtensionEnabled: fn(),
    deleteWorkspaceAgentExtension: fn(),
    listAgentExtensionPolicyOverrides: fn(),
    listAgentExtensionPolicyOverridesForRuntime: fn(),
    setAgentExtensionPolicyOverride: fn(),
    deleteAgentExtensionPolicyOverride: fn(),
    auditAllow: fn(),
    auditDeny: fn(),
  } as unknown as WorkspaceAuthority
}

describe("control-plane services", () => {
  test("uses injected central-store ports when provided", () => {
    const sync = fakeSync()
    const services = createControlPlaneServices(fakePorts(sync))

    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
    expect(services.projectionStore.read_session_messages).toBe(sync.read_session_messages)
    expect(services.durableSessionLog.subscribe_message_replay).toBe(sync.subscribe_message_replay)
  })

  test("central-store ports are accepted as the composition input and delegate to the backend", () => {
    // The seam is ports-IN: callers pass the ports, and the composition holds
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
    expect(services.durableSessionLog.subscribe_message_replay).toBe(sync.subscribe_message_replay)

    // Behavioral delegation: invoking a port method actually calls the stub.
    void services.projectionStore.sync_session_meta(undefined, { id: "s1" })
    expect(sync.sync_session_meta).toHaveBeenCalledWith(undefined, { id: "s1" })
    services.durableSessionLog.persist_message_event("s1", { type: "x" })
    expect(sync.persist_message_event).toHaveBeenCalledWith("s1", { type: "x" })
  })

  test("an injected authority is returned unchanged by service composition", () => {
    // Plain composition passthrough: whatever authority bag is injected comes
    // back on `services.authority` by identity, regardless of env.
    const authority = { listWorkspaceAgentExtensions: vi.fn() } as never
    const services = createControlPlaneServices(fakePorts(), {
      authority: authority,
    })
    expect(services.authority).toBe(authority)

    // The hosted `requiredHostedDependency` path also returns it unchanged
    // (the authority passes the "workspace authority" required-dependency
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

  test("accepts explicit store, credentials, policy, relay, sandbox, and telemetry inputs", () => {
    const base = createControlPlaneServices(fakePorts(), { authority: null })
    const capture = vi.fn()
    const agentExtensionPolicyOverrides = vi.fn(() => [])
    const credentials = {} as never
    const runtimeAccessTokenSigner = vi.fn() as never
    const hostTunnelTokenSigner = vi.fn() as never
    const services = createControlPlaneServices(
      { projectionStore: base.projectionStore, durableSessionLog: base.durableSessionLog },
      {
      credentials,
      extensionPolicy: { agentExtensionPolicyOverrides },
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
    expect(services.extensionPolicy.agentExtensionPolicyOverrides).toBe(agentExtensionPolicyOverrides)
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
      const fakeAuthority = { listWorkspaceAgentExtensions: vi.fn() } as never
      const services = createControlPlaneServices(fakePorts(), {
        authority: fakeAuthority,
      })
      expect(services.authority).toBe(fakeAuthority)
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
    }
  })

  test("creates a hosted stack from explicit auth, store, credentials, relay, runtime host, policy, and telemetry", () => {
    const sync = fakeSync()
    const options = hostedOptions()
    const services = createHostedControlPlaneServices(fakePorts(sync), options)

    expect(services.auth).toBe(options.auth)
    expect(services.credentials).toBe(options.credentials)
    expect(services.extensionPolicy).toBe(options.extensionPolicy)
    expect(services.relay).toBe(options.relay)
    expect(services.sandbox).toBe(options.sandbox)
    expect(services.telemetry).toBe(options.telemetry)
    expect(services.localExecution).toEqual({ enabled: false })
    expect(services.authority).toBe(options.authority)
    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
    expect(services.durableSessionLog.subscribe_message_replay).toBe(sync.subscribe_message_replay)
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
        options: () => ({ ...hostedOptions(), extensionPolicy: null as never }),
        message: "Hosted Control Plane requires Agent Extension policy",
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
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "https://example.convex.cloud"
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
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "https://ambient.convex.cloud"
    try {
      // Ambient env no longer materializes an authority.
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

  test("server composition uses createApp with explicit services", () => {
    const file = path.resolve(import.meta.dirname, "../deployments/local/server.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("export function createApp(")
    expect(text).toContain("services: ControlPlaneServices")
    expect(text).toContain("export function createDefaultLocalControlPlaneServices()")
    expect(text).toContain("const authorityUrl = convexAuthorityUrlFromEnv(process.env)")
    // Embedded Better Auth (CLAXEDO_EMBEDDED_AUTH=1) selects the betterAuthAdapter
    // branch; the Clerk env adapter remains the default.
    expect(text).toContain("? betterAuthAdapter({ issuer: EMBEDDED_AUTH_ISSUER, verifier: getEmbeddedAuth().verifier })")
    expect(text).toContain(": clerkAuthAdapter({ env: process.env, authorityConfigured: !!authorityUrl })")
    expect(text).toContain("const centralStore = createSqliteCentralStore({ mode: getSessionWriteMode })")
    expect(text).toContain("projectionStore: centralStore.projectionStore,")
    expect(text).toContain("const sandboxManager = createWorkspaceSupervisorSandboxManager()")
    expect(text).toContain("sandboxManager,")
    expect(text).toContain("const workspaceRuntimeProxy = createWorkspaceRuntimeProxy(runtimeProxyOptions)")
    expect(text).toContain("const localWorkspaceRelayProxy = createLocalWorkspaceRelayProxy(runtimeProxyOptions)")
    expect(text).toContain("if (services.localExecution.enabled)")
    expect(text).toContain("app.use(workspaceRuntimeProxy)")
    expect(text).toContain("Runtime-owned local routes are dispatched through the embedded")
    expect(text).not.toContain("AgentSessionRoutes(")
    expect(text).toContain("services.durableSessionLog.subscribe_message_replay(globalBus)")
    expect(text).toContain("services.telemetry.capture(parsed.data.distinctId")
    expect(text).toContain("authConfig: services.auth.config")
    expect(text).toContain("agentExtensionPolicyOverrides: services.extensionPolicy.agentExtensionPolicyOverrides")
    // Prefix match: the credential routes gained an options argument
    // (bearer gate) in the parallel creds work; the composition contract
    // here is only that the routes are constructed from services.credentials.
    expect(text).toContain("CredentialRoutes(services.credentials")
    expect(text).toContain("credentials: services.credentials")
    // Prefix match: workspaceRouteOptions gained a connections argument in the
    // parallel connections work; the composition contract here is only that the
    // workspace routes are constructed from services + workspaceRouteOptions.
    expect(text).toContain("WorkspaceRoutes(services, workspaceRouteOptions(services")
    expect(text).toContain("app.route(\"/\", JwksRoutes(process.env))")
    expect(text).toContain("InternalRelayResolverRoutes({")
    expect(text).toContain("BootstrapRoutes({")
    expect(text).toContain("env: process.env")
    expect(text).toContain("app.route(\"/api/control\", ControlPlaneHttpRoutes(services, authRouteOptions(services)))")
    expect(text).toContain("const centralControl = createCentralControlApp(services, {")
    expect(text).toContain("...authRouteOptions(services),")
    expect(text).toContain("createEnv: createClaxedoSessionEnvFactory({ fetchOptions: runtimeProxyOptions, turnCredentials }),")
    expect(text).toContain("app.route(\"/\", centralControl.app)")
  })

  test("local composition fails closed at boot when signed auth has no workspace authority", async () => {
    // Deployer trap: signed auth enabled + no authority previously answered 503
    // on every request; the default local composition must refuse to boot with
    // an actionable message instead.
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/local/server")
    const previous = {
      signed: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
      authority: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
      embedded: process.env.CLAXEDO_EMBEDDED_AUTH,
    }
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "true"
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    // The embedded Better Auth issuer is the ONE exception to this trap
    // (SQLite authority + embedded issuer = valid signed config); make sure
    // it is off so the fail-closed path is exercised.
    delete process.env.CLAXEDO_EMBEDDED_AUTH
    try {
      expect(() => createDefaultLocalControlPlaneServices()).toThrow(
        new ControlPlaneCompositionError(
          "hosted_dependency_missing",
          "Signed/cloud auth requires a workspace authority; set CLAXEDO_WORKSPACE_AUTHORITY_URL or enable CLAXEDO_EMBEDDED_AUTH=1",
        ),
      )
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
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/local/server")
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
    const server = fs.readFileSync(path.resolve(import.meta.dirname, "../deployments/local/server.ts"), "utf8")

    expect(fs.existsSync(route)).toBe(false)
    expect(server).not.toContain("AgentSessionRoutes(")
    expect(server).toContain("workspaceRuntimeProxy")
  })

  test("runtime-facing server files do not reach around control-plane ports", () => {
    const files = [
      path.resolve(import.meta.dirname, "../deployments/local/server.ts"),
      path.resolve(import.meta.dirname, "../deployments/local/embedded-workspace-runtime.ts"),
    ]

    for (const file of files) {
      const text = fs.readFileSync(file, "utf8")
      expect(text).not.toContain("services.sync")
      expect(text).not.toContain("import type { SyncDB }")
    }
  })

  test("sandbox launch injects neutral workspace-runtime auth env", () => {
    const file = path.resolve(import.meta.dirname, "../workspace/supervisor/sandbox.ts")
    const text = fs.readFileSync(file, "utf8")
    const runtimeEnv = fs.readFileSync(path.resolve(import.meta.dirname, "../workspace/supervisor/runtime-env.ts"), "utf8")

    expect(text).toContain("const controlPlaneUrl = sandboxControlPlaneUrl")
    expect(text).toContain("...controlPlaneVerificationEnv(driverId, controlPlaneUrl, { options })")
    expect(text).toContain("...runtimeDirectAuthEnv(configToken(state))")
    expect(runtimeEnv).toContain("workspaceRuntimeDirectAuthEnv({ token })")
    expect(text).not.toContain("CLAXEDO_CONTROL_PLANE_URL: controlPlaneUrl")
  })

  test("runtime control-plane HTTP protocol exposes pull session and runtime handlers", () => {
    const file = path.resolve(import.meta.dirname, "./http/index.ts")
    const text = fs.readFileSync(file, "utf8")
    const sessionPull = fs.readFileSync(path.resolve(import.meta.dirname, "./http/session-pull.ts"), "utf8")

    expect(text).not.toContain("app.post(\"/sessions/sync\"")
    expect(text).not.toContain("app.post(\"/sessions/sync-many\"")
    expect(text).not.toContain("app.post(\"/sessions/:sessionId/messages\"")
    expect(text).not.toContain("app.delete(\"/sessions/:sessionId\"")
    expect(text).toContain("app.post(\"/workspaces/:workspaceId/sessions/:sessionId/register\"")
    expect(text).toContain("app.post(\"/workspaces/:workspaceId/sessions/:sessionId/checkpoint\"")
    expect(text).toContain("app.post(\"/workspaces/:workspaceId/sessions/:sessionId/repair\"")
    expect(text).toContain("app.post(\"/runtime/register\"")
    expect(text).toContain("app.post(\"/runtime/heartbeat\"")
    expect(sessionPull).toContain("export async function resolveSessionGateway")
  })

  test("createApp accepts an injected ControlPlaneServices and returns app + websocket", async () => {
    const { createApp } = await import("../deployments/local/server")
    const sync = fakeSync()
    const services = createControlPlaneServices(fakePorts(sync), {
      authority: null,
      relay: { resolverToken: "expected-relay-token" },
    })
    const built = createApp(services)
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

      // The global unsigned-local guard is now the PRIMARY gate for
      // non-loopback unsigned requests; the per-route local-only projection
      // (previously `local_only_projection_route` here) is demoted to
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

  test("createApp gates remote central runtime routes with signed auth", async () => {
    const { createApp } = await import("../deployments/local/server")
    const sync = fakeSync()
    const authorizeSessionRead = vi.fn(async () => {})
    const services = createControlPlaneServices(fakePorts(sync), {
      authority: {
        authorizeSessionRead,
      } as never,
      auth: customVerifierAuthAdapter({
        issuer: "https://auth.example.test",
        verifier: async (token) => ({
          mode: "signed",
          user: {
            subject: token,
            tokenIdentifier: `test:${token}`,
            issuer: "https://auth.example.test",
          },
        }),
      }),
    })
    const built = createApp(services)

    const missing = await built.app.request("https://control.example.test/api/control/session/session-1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf nope" }],
        messageID: "unsigned-user",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })
    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "missing_bearer_token" },
    })

    for (const item of [
      { method: "GET", path: "/api/control/session" },
      { method: "POST", path: "/api/control/session" },
      { method: "GET", path: "/api/control/experimental/session" },
      { method: "GET", path: "/api/wr/runtime-events" },
    ]) {
      const res = await built.app.request(`https://control.example.test${item.path}`, {
        method: item.method,
        headers: { Authorization: "Bearer user_1" },
      })
      expect(res.status, item.path).toBe(403)
      await expect(res.json(), item.path).resolves.toMatchObject({
        error: { code: "central_session_required" },
      })
    }

    const malformed = await built.app.request("https://control.example.test/api/control/session/%E0%A4%A/message", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "invalid_session_id" },
    })

    sync.session_meta.mockImplementation(async (sessionID) =>
      sessionID === "workspace-session"
        ? {
            sessionID,
            host: "workspace",
            workspaceID: "ws_central",
            directory: "/workspace",
            createdAt: 1,
            updatedAt: 1,
            tags: [],
            attachments: [],
          }
        : undefined)
    const wrongHost = await built.app.request("https://control.example.test/api/control/session/workspace-session/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_1",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf nope" }],
        messageID: "wrong-host-user",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })
    expect(wrongHost.status).toBe(403)
    await expect(wrongHost.json()).resolves.toMatchObject({
      error: { code: "central_session_required" },
    })
    expect(authorizeSessionRead).not.toHaveBeenCalled()

    sync.session_meta.mockImplementation(async (sessionID) =>
      sessionID === "central-without-workspace"
        ? {
            sessionID,
            host: "central",
            createdAt: 1,
            updatedAt: 1,
            tags: [],
            attachments: [],
          }
        : undefined)
    const noWorkspace = await built.app.request("https://control.example.test/api/control/session/central-without-workspace/abort", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })
    expect(noWorkspace.status).toBe(403)
    await expect(noWorkspace.json()).resolves.toMatchObject({
      error: { code: "central_session_workspace_required" },
    })
    expect(authorizeSessionRead).not.toHaveBeenCalled()

    const sessionId = "signed-central-session"
    sync.session_meta.mockImplementation(async (sessionID) =>
      sessionID === sessionId
        ? {
            sessionID,
            host: "central",
            workspaceID: "ws_central",
            createdAt: 1,
            updatedAt: 1,
            tags: [],
            attachments: [],
          }
        : undefined)

    const loopback = await built.app.request(`http://127.0.0.1/api/control/session/${sessionId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4444",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf loopback" }],
        messageID: "loopback-user",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })
    expect(loopback.status).toBe(200)
    await expect(loopback.json()).resolves.toMatchObject({
      info: { id: "loopback-user_r", role: "assistant" },
      parts: [{ text: "loopback" }],
    })
    expect(authorizeSessionRead).not.toHaveBeenCalled()

    authorizeSessionRead.mockImplementationOnce(async () => {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Convex denied session access")
    })
    const denied = await built.app.request(`https://control.example.test/api/control/session/${sessionId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_denied",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf denied" }],
        messageID: "denied-user",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "workspace_authorization_denied" },
    })

    const signed = await built.app.request(`https://control.example.test/api/control/session/${sessionId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_1",
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "exec: printf signed" }],
        messageID: "signed-user",
        agent: "pi",
        model: { providerID: "pi", modelID: "virtual" },
      }),
    })

    expect(signed.status).toBe(200)
    await expect(signed.json()).resolves.toMatchObject({
      info: { id: "signed-user_r", role: "assistant" },
      parts: [{ text: "signed" }],
    })
    expect(authorizeSessionRead).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ subject: "user_1" }),
    }), {
      sessionId,
      workspaceId: "ws_central",
    })
  })

  test("createApp gates remote central runtime events with signed auth", async () => {
    const { createApp } = await import("../deployments/local/server")
    const built = createApp(createControlPlaneServices(fakePorts(), { authority: null }))

    // In an unsigned-local deployment a REMOTE caller is now denied by
    // the global unsigned-local guard before the per-route bearer gate
    // (previously 401 missing_bearer_token from the route) — the per-route
    // gate remains as defense-in-depth behind it.
    const missing = await built.app.request("https://control.example.test/api/wr/runtime-events")

    expect(missing.status).toBe(403)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "unsigned_local_loopback_required" },
    })
  })

  test("createApp rejects hosted services so hosted security hooks cannot be bypassed", async () => {
    const { createApp } = await import("../deployments/local/server")
    expect(() =>
      createApp(createHostedControlPlaneServices(fakePorts(), hostedOptions()))
    ).toThrow(new ControlPlaneCompositionError(
      "self_host_app_required",
      "createApp is the self-host composition; use createHostedApp for hosted services",
    ))
  })

  test("startup telemetry captures non-secret control-plane composition facts", async () => {
    const { captureControlPlaneStartupTelemetry } = await import("../deployments/local/server")
    const capture = vi.fn()
    const services = createHostedControlPlaneServices(fakePorts(), hostedOptions({
      telemetry: { capture },
    }))

    captureControlPlaneStartupTelemetry(services, {
      port: 4987,
      engineMode: "embedded",
    })

    expect(capture).toHaveBeenCalledWith("control-plane", "control_plane.started", {
      port: 4987,
      opencodeConfigured: true,
      opencodeEngineMode: "embedded",
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
    const { captureControlPlaneStartupTelemetry } = await import("../deployments/local/server")
    const services = createControlPlaneServices(fakePorts(), {
      authority: null,
      telemetry: {
        capture: () => {
          throw new Error("telemetry down")
        },
      },
    })

    expect(() =>
      captureControlPlaneStartupTelemetry(services, {
        port: 4987,
        engineMode: "embedded",
      })
    ).not.toThrow()
  })

  test("startServer is a thin wrapper that composes the default local stack", () => {
    const file = path.resolve(import.meta.dirname, "../deployments/local/server.ts")
    const text = fs.readFileSync(file, "utf8")

    // startServer configures local service defaults, then delegates to
    // the lower-level injected-service startup path.
    expect(text).toContain("export function startServer(")
    expect(text).toContain("return startControlPlaneStack({")
    expect(text).toContain("services: createDefaultLocalControlPlaneServices()")
    expect(text).toContain("createSqliteCentralStore({ mode: getSessionWriteMode })")
  })

  test("lower-level stack startup accepts injected services and centralizes shutdown cleanup", () => {
    const file = path.resolve(import.meta.dirname, "../deployments/local/server.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("export function startControlPlaneStack(options: ControlPlaneStackOptions)")
    expect(text).toContain("const services = options.services")
    expect(text).toContain("const built = createApp(services, {")
    expect(text).toContain("configureWorkspaceSupervisor({")
    expect(text).toContain("relay_url: services.relay.relayUrl")
    expect(text).toContain("default_sandbox_driver: services.sandbox.defaultDriver")
    expect(text).toContain("migrateCredentials()")
    expect(text).toContain("captureControlPlaneStartupTelemetry(services, { port, engineMode: opencodeEngineMode() })")
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

  test("hosted session bootstrap exposes a real frontend gateway resolution seam", () => {
    const routeFile = path.resolve(import.meta.dirname, "../session/routes/control-plane-session.ts")
    const routeText = fs.readFileSync(routeFile, "utf8")
    const extensionFile = path.resolve(import.meta.dirname, "../../../claxedo-app/src/features/extensions/data/server.tsx")
    const extensionText = fs.readFileSync(extensionFile, "utf8")
    const sessionUrlFile = path.resolve(import.meta.dirname, "../../../claxedo-app/src/platform/runtime/session-url.ts")
    const sessionUrlText = fs.readFileSync(sessionUrlFile, "utf8")
    const layoutFile = path.resolve(import.meta.dirname, "../../../claxedo-app/src/app/routes/directory-layout.tsx")
    const layoutText = fs.readFileSync(layoutFile, "utf8")

    expect(routeText).toContain(".get(\"/sessions/:sessionId/gateway\"")
    expect(routeText).toContain("resolveSessionGateway(services, c.req.param(\"sessionId\"), auth)")
    expect(extensionText).toContain("resolveSessionUrl: (sessionId: string): Promise<string | null> => resolveSessionUrl(sessionId, config)")
    expect(sessionUrlText).toContain("suffix: \"/gateway\"")
    expect(sessionUrlText).toContain("if (body.harnessHost === \"central\") return base")
    expect(layoutText).toContain("void resolveSessionUrl(sessionId, config).then((gatewayUrl) => {")
    expect(layoutText).not.toContain("^https?:\\\\/\\\\/(localhost|127\\\\.0\\\\.0\\\\.1)")
  })

  test("cloud workspace creation uses normalized provider, branch, and credential inputs", () => {
    const file = path.resolve(import.meta.dirname, "../workspace/routes/index.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("gitBranch: z.string().optional()")
    expect(text).toContain("services?.sandbox.defaultDriver")
    expect(text).toContain("sandboxDriverCredentials(options, services)")
    // Kind-scoped since 6fee6b3ae. `provider_id` is shared with model providers
    // and is not unique -- `vercel` is both a sandbox driver and a model
    // provider -- so the unscoped lookup this used to pin let a model API key
    // satisfy the sandbox-credential gate, passing creation and failing later at
    // launch. Assert the scope, not just the call.
    expect(text).toContain(".getCredentialByProvider(id, \"sandbox_driver\")")
    expect(text).toContain("const hasCredentials = credential?.status === \"available\" || !!sandboxDriverAuth(driverConfig, id)")
    expect(text).toContain("const gitBranch = body.gitBranch?.trim() || (rawWorkspaceName ? name : undefined)")
    expect(text).toContain("git_branch: gitBranch")
    // `gitBranch` has to reach all three consumers as a shorthand property: the
    // authority's createCloudWorkspace, the telemetry properties, and
    // startCloudWorkspaceProvisioning. A bare toContain("gitBranch,") does not
    // guard that -- it is already satisfied by the `git_branch: gitBranch,` line
    // pinned above -- so count the shorthand sites instead.
    expect(text.match(/^\s+gitBranch,$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
