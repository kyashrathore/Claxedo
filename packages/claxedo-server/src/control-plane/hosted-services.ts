/**
 * Worker-safe composition of the hosted control-plane services.
 *
 * This deliberately does NOT import `control-plane/services.ts` values
 * (`createHostedControlPlaneServices` / `defaultControlPlaneCredentials`),
 * because `defaultControlPlaneCredentials` lazily imports the local credential
 * registry (which pulls `fs`) — even an unused lazy chunk would land in the
 * Worker bundle. Instead it assembles a `ControlPlaneServices` object from only
 * Worker-safe pieces and re-implements the fail-closed validation.
 *
 * The Worker fails closed if any required hosted dependency is missing: signed
 * auth, workspace authority, relay URL, resolver token, and a token signing key.
 *
 * Storage-backend composition (authority + lease store + user-hosted resolver)
 * is delegated to the Worker adapter in `adapters/worker/hosted-compose.ts`, so
 * this module names no storage backend.
 */

import { clerkAuthAdapter } from "./auth"
import { hostTunnelTokenSigner, runtimeAccessTokenSigner } from "./runtime-access-token"
import { workerTelemetry } from "./worker-telemetry"
import { workerCredentials } from "./worker-credentials"
import type { ControlPlaneServices } from "./services"
import type { ProjectionStore } from "./projection-store"
import type { DurableSessionLog } from "./durable-session-log"
import { createFetchBridgeSandboxDriver } from "@claxedo/sandbox-manager/drivers/fetch-bridge"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import { createDaytonaSandboxDriver } from "@claxedo/sandbox-manager/drivers/daytona"
import { createExeSandboxDriver } from "@claxedo/sandbox-manager/drivers/exe"
import { defaultHomeRegion, relayEndpointsFromEnv } from "../region"
import type { HostedDeviceAuthProvider } from "../routes/hosted-device-auth"
import { createControlPlaneRelayProvider } from "../relay-provider"
import { sandboxRelayTargetLookup } from "./sandbox-relay-target"
import type { RelayTargetLookup } from "../routes/internal-relay"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import {
  HostedWorkerCompositionError,
  clean,
  composeWorkerAuthority,
  composeWorkerSandboxManager,
  composeWorkerUserHostedResolver,
  positiveInteger,
  required,
  workspaceRuntimePort,
  type HostedWorkerEnv,
} from "./adapters/worker/hosted-compose"

export { HostedWorkerCompositionError, type HostedWorkerEnv } from "./adapters/worker/hosted-compose"

export { sandboxRelayTargetLookup } from "./sandbox-relay-target"

export type HostedSafetyLimits = {
  connectionRateLimit: number
  connectionRateLimitWindowMs: number
  controlPlaneRateLimit: number
  controlPlaneRateLimitWindowMs: number
  sandboxMaxRetryCount: number
}

function safetyLimits(env: HostedWorkerEnv): HostedSafetyLimits {
  return {
    connectionRateLimit: positiveInteger(env, "CLAXEDO_CONNECTION_RATE_LIMIT", 6),
    connectionRateLimitWindowMs: positiveInteger(env, "CLAXEDO_CONNECTION_RATE_LIMIT_WINDOW_MS", 60_000),
    controlPlaneRateLimit: positiveInteger(env, "CLAXEDO_CONTROL_PLANE_RATE_LIMIT", 120),
    controlPlaneRateLimitWindowMs: positiveInteger(env, "CLAXEDO_CONTROL_PLANE_RATE_LIMIT_WINDOW_MS", 60_000),
    sandboxMaxRetryCount: positiveInteger(env, "CLAXEDO_SANDBOX_MAX_RETRY_COUNT", 5),
  }
}

// Resolve the sandbox driver the hosted control plane composes.
// `CLAXEDO_SANDBOX_DRIVER` is optional: when omitted, the Worker auto-selects a
// native Worker-safe driver from present credentials (Cloudflare first, then
// Daytona). The fetch bridge is deliberately explicit-only so a leftover
// CLAXEDO_SANDBOX_DRIVER_URL cannot become the hidden hosted model.
export function sandboxDriver(env: HostedWorkerEnv): SandboxDriver | undefined {
  const name = clean(env.CLAXEDO_SANDBOX_DRIVER)?.toLowerCase() ?? defaultSandboxDriverName(env)
  if (!name) return

  if (name === "cloudflare") {
    const workerUrl = clean(env.CLOUDFLARE_SANDBOX_WORKER_URL)
    const apiToken = clean(env.CLOUDFLARE_SANDBOX_API_TOKEN) ?? clean(env.CLOUDFLARE_API_TOKEN)
    if (!workerUrl || !apiToken) return
    return createCloudflareSandboxDriver({
      workerUrl,
      apiToken,
      runtimePort: workspaceRuntimePort(env),
      ...(clean(env.CLAXEDO_RUNTIME_COMMAND) ? { runtimeCommand: clean(env.CLAXEDO_RUNTIME_COMMAND) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(env.CLAXEDO_RUNTIME_RUNNER) } : {}),
      controlEnv: {
        ...(clean(env.CLAXEDO_RELAY_JWKS_URL) ? { relayJwksUrl: clean(env.CLAXEDO_RELAY_JWKS_URL) } : {}),
        ...(clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM)
          ? { relayVerifyPem: clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM) }
          : {}),
        ...(clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
          ? { managementJwksUrl: clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL) }
          : {}),
      },
    })
  }

  if (name === "daytona") {
    const apiKey = clean(env.DAYTONA_API_KEY)
    const baseSnapshot = clean(env.CLAXEDO_DAYTONA_SNAPSHOT)
    if (!apiKey || !baseSnapshot) return
    return createDaytonaSandboxDriver({
      apiKey,
      baseSnapshot,
      ...(clean(env.DAYTONA_API_URL) ? { apiUrl: clean(env.DAYTONA_API_URL) } : {}),
      ...(clean(env.DAYTONA_ORGANIZATION_ID) ? { organizationId: clean(env.DAYTONA_ORGANIZATION_ID) } : {}),
      ...(clean(env.DAYTONA_TARGET) ? { target: clean(env.DAYTONA_TARGET) } : {}),
      runtimePort: workspaceRuntimePort(env),
      ...(clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(env.CLAXEDO_RUNTIME_RUNNER) } : {}),
      controlEnv: {
        ...(clean(env.CLAXEDO_RELAY_JWKS_URL) ? { relayJwksUrl: clean(env.CLAXEDO_RELAY_JWKS_URL) } : {}),
        ...(clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM)
          ? { relayVerifyPem: clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM) }
          : {}),
        ...(clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
          ? { managementJwksUrl: clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL) }
          : {}),
      },
    })
  }

  if (name === "exe") {
    const apiToken = clean(env.EXE_DEV_API_TOKEN)
    if (!apiToken) return
    const runtimeEnv = {
      ...(clean(env.CLAXEDO_RELAY_JWKS_URL)
        ? { WORKSPACE_RUNTIME_RELAY_JWKS_URL: clean(env.CLAXEDO_RELAY_JWKS_URL)! }
        : {}),
      ...(clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM)
        ? { WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: clean(env.CLAXEDO_RELAY_HOST_VERIFY_PEM)! }
        : {}),
      ...(clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
        ? { WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)! }
        : {}),
    }
    return createExeSandboxDriver({
      apiToken,
      ...(clean(env.EXE_DEV_API_URL) ? { endpoint: clean(env.EXE_DEV_API_URL) } : {}),
      ...(clean(env.CLAXEDO_SANDBOX_IMAGE) ? { image: clean(env.CLAXEDO_SANDBOX_IMAGE) } : {}),
      runtimePort: workspaceRuntimePort(env),
      ...(clean(env.CLAXEDO_RUNTIME_COMMAND) ? { runtimeCommand: clean(env.CLAXEDO_RUNTIME_COMMAND) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(env.CLAXEDO_RUNTIME_RUNNER) } : {}),
      ...(Object.keys(runtimeEnv).length ? { env: () => runtimeEnv } : {}),
    })
  }

  if (name !== "fetch") {
    throw new HostedWorkerCompositionError(
      "hosted_sandbox_driver_unsupported",
      `Hosted Worker sandbox driver must be one of exe, cloudflare, daytona, or fetch; got ${name}`,
    )
  }

  const driverUrl = clean(env.CLAXEDO_SANDBOX_DRIVER_URL)
  if (!driverUrl) return
  return createFetchBridgeSandboxDriver({
    id: "fetch",
    baseUrl: driverUrl,
    token: clean(env.CLAXEDO_SANDBOX_DRIVER_TOKEN),
    autoStopMs: positiveInteger(env, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000),
    autoDeleteMs: positiveInteger(env, "CLAXEDO_SANDBOX_AUTO_DELETE_MS", 24 * 60 * 60_000),
  })
}

function sandboxManager(env: HostedWorkerEnv) {
  const driver = sandboxDriver(env)
  if (!driver) return
  const limits = safetyLimits(env)
  return composeWorkerSandboxManager({ env, driver, maxRetryCount: limits.sandboxMaxRetryCount })
}

function deviceAuthProvider(env: HostedWorkerEnv): HostedDeviceAuthProvider | undefined {
  const issuer = clean(env.CLAXEDO_DEVICE_LOGIN_ISSUER)
  if (!issuer) return
  const base = issuer.replace(/\/+$/, "")
  return {
    issuer,
    codeUrl: clean(env.CLAXEDO_DEVICE_LOGIN_CODE_URL) ?? `${base}/device/code`,
    tokenUrl: clean(env.CLAXEDO_DEVICE_LOGIN_TOKEN_URL) ?? `${base}/device/token`,
    ...(clean(env.CLAXEDO_DEVICE_LOGIN_CLIENT_ID) ? { clientId: clean(env.CLAXEDO_DEVICE_LOGIN_CLIENT_ID) } : {}),
    ...(clean(env.CLAXEDO_DEVICE_LOGIN_AUDIENCE) ? { audience: clean(env.CLAXEDO_DEVICE_LOGIN_AUDIENCE) } : {}),
    ...(clean(env.CLAXEDO_DEVICE_LOGIN_SCOPE) ? { scope: clean(env.CLAXEDO_DEVICE_LOGIN_SCOPE) } : {}),
    ...(clean(env.CLAXEDO_DEVICE_LOGIN_ISSUER_TOKEN)
      ? { issuerToken: clean(env.CLAXEDO_DEVICE_LOGIN_ISSUER_TOKEN) }
      : {}),
  }
}

function defaultSandboxDriverName(env: HostedWorkerEnv) {
  if (
    clean(env.CLOUDFLARE_SANDBOX_WORKER_URL) &&
    (clean(env.CLOUDFLARE_SANDBOX_API_TOKEN) || clean(env.CLOUDFLARE_API_TOKEN))
  ) return "cloudflare"
  if (clean(env.EXE_DEV_API_TOKEN)) return "exe"
  if (clean(env.DAYTONA_API_KEY) && clean(env.CLAXEDO_DAYTONA_SNAPSHOT)) {
    return "daytona"
  }
  return undefined
}

// Session projection / durable log are not part of the hosted Worker surface.
// Provide fail-closed stubs so a stray call is loud rather than silently wrong.
function unusedStore<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get() {
      return () => {
        throw new Error(`${label} is not available in the hosted Worker control plane`)
      }
    },
  })
}

export type HostedControlPlane = {
  services: ControlPlaneServices
  relayUrl: string
  resolverToken: string
  safetyLimits: HostedSafetyLimits
  /**
   * The ONE composed relay target lookup (cloud lease + user-hosted host link),
   * consumed by both the relay provider and the internal relay resolver route.
   */
  relayTargetLookup: RelayTargetLookup
  /** Device-login provider; undefined until a trusted CLI issuer is configured. */
  deviceAuthProvider?: HostedDeviceAuthProvider
  env: HostedWorkerEnv
}

export function composeHostedControlPlane(env: HostedWorkerEnv): HostedControlPlane {
  const auth = clerkAuthAdapter({ env })
  if (!auth.config.enabled) {
    throw new HostedWorkerCompositionError(
      "hosted_auth_disabled",
      `Hosted Worker control plane requires enabled signed auth: ${auth.config.reason}`,
    )
  }

  // Fails closed when the hosted storage endpoint is missing.
  const authority = composeWorkerAuthority(env)
  const limits = safetyLimits(env)
  const relayUrl = required(
    env.CLAXEDO_WORKSPACE_RELAY_URL,
    "hosted_dependency_missing",
    "a workspace relay URL (CLAXEDO_WORKSPACE_RELAY_URL)",
  )
  const resolverToken = required(
    env.CLAXEDO_RELAY_RESOLVER_TOKEN,
    "hosted_dependency_missing",
    "a relay resolver token (CLAXEDO_RELAY_RESOLVER_TOKEN)",
  )
  if (clean(env.CLAXEDO_RUNTIME_ADMIN_TOKEN) === resolverToken) {
    throw new HostedWorkerCompositionError(
      "hosted_token_reuse",
      "CLAXEDO_RUNTIME_ADMIN_TOKEN must not reuse CLAXEDO_RELAY_RESOLVER_TOKEN — admin and resolver are distinct trust domains",
    )
  }
  required(
    env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
    "hosted_dependency_missing",
    "a token signing key (CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)",
  )

  const manager = sandboxManager(env)
  const homeRegion = defaultHomeRegion(env)
  const relayUrls = relayEndpointsFromEnv(env, relayUrl)
  const telemetry = workerTelemetry(env)
  const runtimeAccessSigner = runtimeAccessTokenSigner(env)
  const hostTunnelSigner = hostTunnelTokenSigner(env)
  const userHostedResolver = composeWorkerUserHostedResolver(env)
  const relayTargetLookup = sandboxRelayTargetLookup({
    ...(manager ? { sandboxManager: manager } : {}),
    ...(userHostedResolver ? { userHostedResolver } : {}),
    telemetry,
  })
  const relayProvider = createControlPlaneRelayProvider({
    relay: {
      relayUrl,
      relayUrls,
    },
    runtimeAccessTokenSigner: runtimeAccessSigner,
    hostTunnelTokenSigner: hostTunnelSigner,
    targetLookup: relayTargetLookup,
    recordRuntimeAccessToken: (input) => authority.recordRuntimeAccessTokenForService({
      jti: input.jti,
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      subject: input.subject,
      expiresAt: input.expiresAt,
    }),
    telemetry,
  })
  const services: ControlPlaneServices = {
    projectionStore: unusedStore<ProjectionStore>("Session projection store"),
    durableSessionLog: unusedStore<DurableSessionLog>("Durable session log"),
    auth,
    credentials: workerCredentials(),
    extensionPolicy: {},
    relay: {
      relayUrl,
      relayUrls,
      provider: relayProvider,
      resolverToken,
      runtimeAccessTokenSigner: runtimeAccessSigner,
      hostTunnelTokenSigner: hostTunnelSigner,
    },
    sandbox: {
      ...(manager ? { sandboxManager: manager } : {}),
    },
    telemetry,
    localExecution: { enabled: false },
    defaultHomeRegion: homeRegion,
    authority,
  }

  const deviceAuth = deviceAuthProvider(env)
  return {
    services,
    relayUrl,
    resolverToken,
    safetyLimits: limits,
    relayTargetLookup,
    ...(deviceAuth ? { deviceAuthProvider: deviceAuth } : {}),
    env,
  }
}
