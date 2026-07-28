import { afterEach, describe, expect, test, vi } from "vitest"
import {
  composeHostedControlPlane,
  HostedWorkerCompositionError,
  sandboxEgressUnenforcedSink,
  sandboxRelayTargetLookup,
} from "./hosted-services"
import { composeWorkerSandboxManager } from "./adapters/worker/hosted-compose"
import { localOnlyAuthAdapter } from "./auth"
import { pullHostedControlSession, pullHostedControlSessionMessages } from "./hosted-session-pull"
import type { ControlPlaneServices } from "./services"
import type {
  SandboxDriver,
  SandboxEgressUnenforcedEvent,
  SandboxManager,
} from "@claxedo/sandbox-manager"

function pullServices(): ControlPlaneServices {
  return {
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
    auth: localOnlyAuthAdapter("test"),
    credentials: {} as never,
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  }
}

const signedAuth = {
  mode: "signed" as const,
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

describe("hosted session pull missing-authority behavior", () => {
  test("pullHostedControlSession fails 503 workspace_authority_unavailable when authority is missing", async () => {
    // Pins the wire contract of the canonical `requireAuthority` guard on the
    // signed hosted pull path: no configured authority → 503 + this exact code.
    const svc = pullServices()
    expect(svc.authority).toBeUndefined()
    await expect(
      pullHostedControlSession(svc, undefined, signedAuth, { workspaceId: "ws_1", sessionId: "session-1" }),
    ).rejects.toMatchObject({ status: 503, code: "workspace_authority_unavailable" })
  })

  test("pullHostedControlSessionMessages fails 503 workspace_authority_unavailable when authority is missing", async () => {
    const svc = pullServices()
    expect(svc.authority).toBeUndefined()
    await expect(
      pullHostedControlSessionMessages(svc, undefined, signedAuth, { workspaceId: "ws_1", sessionId: "session-1" }),
    ).rejects.toMatchObject({ status: 503, code: "workspace_authority_unavailable" })
  })
})

const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIO9Cnka2wu8+h1a1Rd+bDejAsq2oUxO6BnDKjrHrpw54",
  "-----END PRIVATE KEY-----",
].join("\n")

function env(overrides: Record<string, string> = {}) {
  return {
    CLAXEDO_SIGNED_CLOUD_AUTH: "true",
    CLERK_JWT_ISSUER: "https://clerk.test",
    CLERK_JWKS_URL: "https://clerk.test/jwks",
    CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
    CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.default.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privateKey,
    ...overrides,
  }
}

describe("hosted service composition", () => {
  test("keeps Claxedo home regions and relay endpoint mapping in hosted services", async () => {
    const plane = composeHostedControlPlane(env({
      CLAXEDO_HOME_REGION: "apac-south",
      CLAXEDO_WORKSPACE_RELAY_URL_APAC_SOUTH: "https://relay.apac-south.test",
      CLAXEDO_WORKSPACE_RELAY_URL_EU_WEST: "https://relay.eu.test",
    }))

    expect(plane.services.defaultHomeRegion).toBe("apac-south")
    expect(plane.services.relay.relayUrl).toBe("https://relay.default.test")
    expect(plane.services.relay.relayUrls).toMatchObject({
      "apac-south": "https://relay.apac-south.test",
      "eu-west": "https://relay.eu.test",
      "us-east": "https://relay.default.test",
    })
    expect(plane.services.relay.provider?.getRelayEndpoint("ws_1", "eu-west")).toBe("https://relay.eu.test")
    await expect(plane.services.relay.provider?.resolveTarget("ws_1", "host_1")).resolves.toBeUndefined()
  })

  test("maps hosted device-login env to a provider-neutral broker config", () => {
    const plane = composeHostedControlPlane(env({
      CLAXEDO_DEVICE_LOGIN_ISSUER: "https://login.test/",
      CLAXEDO_DEVICE_LOGIN_CLIENT_ID: "claxedo-cli",
      CLAXEDO_DEVICE_LOGIN_AUDIENCE: "convex",
      CLAXEDO_DEVICE_LOGIN_SCOPE: "openid offline_access",
    }))

    expect(plane.deviceAuthProvider).toMatchObject({
      issuer: "https://login.test/",
      codeUrl: "https://login.test/device/code",
      tokenUrl: "https://login.test/device/token",
      clientId: "claxedo-cli",
      audience: "convex",
      scope: "openid offline_access",
    })
  })

  test("parses finite hosted safety limits for rate limits and sandbox retries", () => {
    const plane = composeHostedControlPlane(env({
      CLAXEDO_CONNECTION_RATE_LIMIT: "3",
      CLAXEDO_CONNECTION_RATE_LIMIT_WINDOW_MS: "15000",
      CLAXEDO_CONTROL_PLANE_RATE_LIMIT: "17",
      CLAXEDO_CONTROL_PLANE_RATE_LIMIT_WINDOW_MS: "45000",
      CLAXEDO_SANDBOX_MAX_RETRY_COUNT: "4",
    }))

    expect(plane.safetyLimits).toEqual({
      connectionRateLimit: 3,
      connectionRateLimitWindowMs: 15_000,
      controlPlaneRateLimit: 17,
      controlPlaneRateLimitWindowMs: 45_000,
      sandboxMaxRetryCount: 4,
    })
  })

  test("fails closed when no workspace authority URL is configured, and accepts the neutral env name", () => {
    // Deployer trap fix: the advertised CLAXEDO_WORKSPACE_AUTHORITY_URL must
    // actually compose the authority; missing it fails the Worker composition
    // closed with an actionable message. The legacy Convex aliases are retired
    // and no longer compose an authority.
    expect(() => composeHostedControlPlane({ ...env(), CLAXEDO_WORKSPACE_AUTHORITY_URL: undefined })).toThrow(
      "CLAXEDO_WORKSPACE_AUTHORITY_URL",
    )
    expect(() => composeHostedControlPlane({
      ...env(),
      CLAXEDO_WORKSPACE_AUTHORITY_URL: undefined,
      CONVEX_URL: "https://legacy.convex.test",
    })).toThrow("CLAXEDO_WORKSPACE_AUTHORITY_URL")
    const plane = composeHostedControlPlane(env())
    expect(plane.services.authority).toBeDefined()
  })

  test("fails closed when a hosted safety limit is invalid", () => {
    expect(() => composeHostedControlPlane(env({
      CLAXEDO_CONTROL_PLANE_RATE_LIMIT: "0",
    }))).toThrow(HostedWorkerCompositionError)
    expect(() => composeHostedControlPlane(env({
      CLAXEDO_CONTROL_PLANE_RATE_LIMIT: "0",
    }))).toThrow("CLAXEDO_CONTROL_PLANE_RATE_LIMIT must be a positive integer")
  })

  test("fails closed when a sandbox driver is configured without the Convex Control Plane service token", () => {
    // Without the service token every Convex lease call would be rejected at
    // request time (500s on every connection): composition must fail instead.
    expect(() => composeHostedControlPlane(env({
      CLAXEDO_SANDBOX_DRIVER: "fetch",
      CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
    }))).toThrow(HostedWorkerCompositionError)
    expect(() => composeHostedControlPlane(env({
      CLAXEDO_SANDBOX_DRIVER: "fetch",
      CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "   ",
    }))).toThrow("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN")
    // With the token the sandbox manager composes; without a bridge driver URL the token
    // is not required at all.
    expect(composeHostedControlPlane(env({
      CLAXEDO_SANDBOX_DRIVER: "fetch",
      CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "svc_secret",
    })).services.sandbox.sandboxManager).toBeDefined()
    expect(composeHostedControlPlane(env()).services.sandbox.sandboxManager).toBeUndefined()
  })

  test("throws on present-but-invalid sandbox lease durations and defaults when unset", () => {
    const lifecycleEnv = {
      CLAXEDO_SANDBOX_DRIVER: "fetch",
      CLAXEDO_SANDBOX_DRIVER_URL: "https://driver.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "svc_secret",
    }
    for (const key of [
      "CLAXEDO_SANDBOX_AUTO_STOP_MS",
      "CLAXEDO_SANDBOX_AUTO_DELETE_MS",
      "CLAXEDO_SANDBOX_ACQUIRE_STALE_MS",
      "CLAXEDO_SANDBOX_PROVISIONING_RETRY_MS",
    ]) {
      expect(
        () => composeHostedControlPlane(env({ ...lifecycleEnv, [key]: "soon" })),
        `${key}=soon must fail closed`,
      ).toThrow(`${key} must be a positive integer`)
      expect(
        () => composeHostedControlPlane(env({ ...lifecycleEnv, [key]: "0" })),
        `${key}=0 must fail closed`,
      ).toThrow(HostedWorkerCompositionError)
    }
    // Unset values fall back to defaults: composition succeeds.
    expect(composeHostedControlPlane(env(lifecycleEnv)).services.sandbox.sandboxManager).toBeDefined()
  })

  test("fails composition when the runtime admin token reuses the relay resolver token", () => {
    expect(() => composeHostedControlPlane(env({
      CLAXEDO_RUNTIME_ADMIN_TOKEN: "resolver-token",
    }))).toThrow("CLAXEDO_RUNTIME_ADMIN_TOKEN must not reuse CLAXEDO_RELAY_RESOLVER_TOKEN")
    // Distinct tokens compose fine.
    expect(composeHostedControlPlane(env({
      CLAXEDO_RUNTIME_ADMIN_TOKEN: "admin-token",
    })).resolverToken).toBe("resolver-token")
  })
})

describe("sandbox relay target lookup (single shared implementation)", () => {
  const readySandboxManager = () => ({
    target: vi.fn(async () => ({
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_1",
      epoch: 1,
      homeRegion: "us-east",
    })),
    touch: vi.fn(async () => ({ touched: true, status: "ready" })),
  }) as unknown as SandboxManager & { target: ReturnType<typeof vi.fn>; touch: ReturnType<typeof vi.fn> }

  test("fails closed without a sandbox manager", async () => {
    const lookup = sandboxRelayTargetLookup({})
    await expect(lookup({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual({
      found: false,
      code: "relay_resolver_workspace_target_unavailable",
    })
  })

  test("resolving a ready target touches the lease and reports telemetry", async () => {
    const sandboxManager = readySandboxManager()
    const capture = vi.fn()
    const lookup = sandboxRelayTargetLookup({ sandboxManager, telemetry: { capture } })
    await expect(lookup({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual({
      found: true,
      baseUrl: "https://runtime.test/ws_1",
      access: "cloud",
      backing: "cloud-vm",
    })
    expect(sandboxManager.touch).toHaveBeenCalledWith("ws_1")
    await Promise.resolve()
    expect(capture).toHaveBeenCalledWith("system", "sandbox.touch", {
      workspaceId: "ws_1",
      touched: true,
      status: "ready",
    })
  })

  test("fails closed when the requested host id does not match the canonical lease target", async () => {
    const sandboxManager = readySandboxManager()
    const lookup = sandboxRelayTargetLookup({ sandboxManager })

    await expect(lookup({ workspaceId: "ws_1", hostId: "stale-host" })).resolves.toEqual({
      found: false,
      code: "relay_resolver_workspace_target_unavailable",
    })
    expect(sandboxManager.touch).not.toHaveBeenCalled()
  })

  test("passes provider routing headers from the canonical target only", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
        labels: { "daytona.previewToken": "preview-token" },
        epoch: 1,
        homeRegion: "us-east",
      })),
      touch: vi.fn(async () => ({ touched: true, status: "ready" })),
    } as unknown as SandboxManager & { target: ReturnType<typeof vi.fn>; touch: ReturnType<typeof vi.fn> }
    const lookup = sandboxRelayTargetLookup({ sandboxManager })

    await expect(lookup({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual({
      found: true,
      baseUrl: "https://runtime.test/ws_1",
      access: "cloud",
      backing: "cloud-vm",
      upstreamHeaders: { "x-daytona-preview-token": "preview-token" },
    })
  })

  test("schedules the touch through waitUntil when the Worker provides one", async () => {
    const sandboxManager = readySandboxManager()
    const scheduled: Promise<unknown>[] = []
    const lookup = sandboxRelayTargetLookup({ sandboxManager })
    await lookup({ workspaceId: "ws_1", hostId: "host_1", waitUntil: (promise) => scheduled.push(promise) })
    expect(scheduled).toHaveLength(1)
    await Promise.all(scheduled)
    expect(sandboxManager.touch).toHaveBeenCalledWith("ws_1")
  })
})
