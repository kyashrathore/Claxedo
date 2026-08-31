/**
 * Worker-safe composition of the hosted control-plane services.
 *
 * This deliberately does NOT import `authority/services.ts` values
 * (`createHostedControlPlaneServices` / `defaultControlPlaneCredentials`),
 * because `defaultControlPlaneCredentials` lazily imports the local credential
 * registry (which pulls `fs`) — even an unused lazy chunk would land in the
 * Worker bundle. Instead it assembles a `ControlPlaneServices` object from only
 * Worker-safe pieces and re-implements the fail-closed validation.
 *
 * The Worker fails closed if any required hosted dependency is missing: signed
 * auth, workspace authority, relay URL, resolver token, and a token signing key.
 *
 * Adapter entrypoints inject authority, native-auth state, user-hosted target,
 * and optional sandbox driver/lease boundaries. This module names no provider
 * implementation and therefore stays in every selected Worker closure.
 */

import type { ControlPlaneAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  hostTunnelTokenSigner,
  RuntimeAccessTokenConfigurationError,
  runtimeAccessTokenAlgorithm,
  runtimeAccessTokenSigner,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
import { workerTelemetry } from "../platform/auth/worker-telemetry"
import { workerCredentials } from "../credentials/worker/index"
import type { ControlPlaneServices, ControlPlaneTelemetry } from "./services"
import type { ProjectionStore } from "./projection-store"
import type { DurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import { defaultHomeRegion, relayEndpointsFromEnv } from "@claxedo/server-core/platform/runtime/region/index"
import type { HostedDeviceAuthProvider } from "../routes/hosted/device-auth"
import type { RuntimeSessionAuthorityOptions } from "../routes/runtime-session-authority"
import { createControlPlaneRelayProvider } from "@claxedo/server-core/adapters/relay/index"
import { sandboxRelayTargetLookup, type UserHostedTargetResolver } from "./sandbox-relay-target"
import type { RelayTargetLookup } from "../deployments/shared-routes/internal-relay"
import type { SandboxDriver, SandboxEgressUnenforcedEvent } from "@claxedo/sandbox-manager"
import type { CliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SessionTurnAuthority } from "@claxedo/server-core/platform/auth/session-turn-authority"
import { DEFAULT_WORKSPACE_RUNTIME_PORT, createSandboxManager, type SandboxLeaseStore } from "@claxedo/sandbox-manager"
import { HostedWorkerCompositionError } from "./composition-error"
import { recordRelayRuntimeToken } from "./relay-token-record"

export { HostedWorkerCompositionError } from "./composition-error"

export type HostedWorkerEnv = Record<string, string | undefined>

export function clean(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function required(value: string | undefined, code: string, name: string): string {
  const normalized = clean(value)
  if (!normalized) throw new HostedWorkerCompositionError(code, `Hosted Worker control plane requires ${name}`)
  return normalized
}

export function positiveInteger(env: HostedWorkerEnv, key: string, fallback: number) {
  const raw = clean(env[key])
  if (!raw) return fallback
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  throw new HostedWorkerCompositionError("hosted_safety_limit_invalid", `${key} must be a positive integer`)
}

export function workspaceRuntimePort(env: HostedWorkerEnv) {
  return positiveInteger(env, "WORKSPACE_RUNTIME_PORT", DEFAULT_WORKSPACE_RUNTIME_PORT)
}

export { sandboxRelayTargetLookup } from "./sandbox-relay-target"

export type HostedSafetyLimits = {
  connectionRateLimit: number
  connectionRateLimitWindowMs: number
  controlPlaneRateLimit: number
  controlPlaneRateLimitWindowMs: number
  /**
   * Default per-client ceiling applied to EVERY hosted route by
   * `defaultRequestGuard`. Coarse on purpose: it sits above the four tuned
   * per-surface budgets above, so it must not be tighter than the sum a
   * legitimate app session drives across them.
   */
  defaultRequestRateLimit: number
  defaultRequestRateLimitWindowMs: number
  sandboxMaxRetryCount: number
}

function safetyLimits(env: HostedWorkerEnv): HostedSafetyLimits {
  return {
    connectionRateLimit: positiveInteger(env, "CLAXEDO_CONNECTION_RATE_LIMIT", 6),
    connectionRateLimitWindowMs: positiveInteger(env, "CLAXEDO_CONNECTION_RATE_LIMIT_WINDOW_MS", 60_000),
    controlPlaneRateLimit: positiveInteger(env, "CLAXEDO_CONTROL_PLANE_RATE_LIMIT", 120),
    controlPlaneRateLimitWindowMs: positiveInteger(env, "CLAXEDO_CONTROL_PLANE_RATE_LIMIT_WINDOW_MS", 60_000),
    // 600/min: the app shell's boot burst (bootstrap + workspaces
    // reads + documents index) is tens of requests, so this leaves an order of
    // magnitude of headroom for a normal session while still bounding a flood.
    // The window MUST stay 60s to match the CF binding's period (`simple.period`
    // accepts only 10 or 60), so the two layers agree on what "per minute" means.
    defaultRequestRateLimit: positiveInteger(env, "CLAXEDO_DEFAULT_REQUEST_RATE_LIMIT", 600),
    defaultRequestRateLimitWindowMs: positiveInteger(env, "CLAXEDO_DEFAULT_REQUEST_RATE_LIMIT_WINDOW_MS", 60_000),
    sandboxMaxRetryCount: positiveInteger(env, "CLAXEDO_SANDBOX_MAX_RETRY_COUNT", 5),
  }
}

/**
 * Route the sandbox manager's egress-unenforced warning into ops telemetry,
 * without giving up the console line.
 *
 * The gap this closes is a DEPLOYMENT one, and it is silent by construction:
 * a selected cloudflare driver declares `egressControl: "none"`, and since
 * the 2026-07-28 directive ("enforce where
 * we can and document where we can't") such a deployment boots fine and creates
 * fine — every hosted sandbox just comes up able to reach any host on the
 * internet. The manager already warns at composition, but `console.warn` inside
 * a Worker isolate reaches only whoever is tailing logs at that moment, which
 * is nobody on the day the driver is switched.
 *
 * So the event also becomes a queryable ops fact. Deliberately NOT a hard
 * `HostedWorkerCompositionError`: refusing composition would take the entire
 * control plane down — auth, relay, every workspace already running
 * — over a provisioning-time capability. The failure this reports is real but
 * partial, and the response to it is an operator changing a driver, not an
 * outage.
 *
 * Ops plane, so `distinct_id: "system"` and no org/user identifiers — same
 * contract as `sandbox.touch` and the product monitors. `egressControl` rides
 * along even though it is always `"none"` today, so a query can group on the
 * capability rather than re-deriving it from a driver-id allowlist that would
 * go stale the moment the catalog changes.
 */
export function sandboxEgressUnenforcedSink(telemetry: ControlPlaneTelemetry) {
  return (event: SandboxEgressUnenforcedEvent) => {
    // Kept: `public-docs/sandbox-egress.md` tells operators to verify
    // enforcement by looking for this line at boot, and overriding the sink
    // replaces the manager's own console default.
    console.warn(event.message)
    telemetry.capture("system", "sandbox.egress_unenforced", {
      phase: event.phase,
      reason: event.reason,
      driver: event.driver,
      egress_control: event.egressControl,
      ...(event.workspaceId ? { workspace_id: event.workspaceId } : {}),
      // Counts only — an allowlist is deployment topology, not ops-plane data.
      ...(event.requested
        ? {
            withheld_host_count: event.requested.hosts?.length ?? 0,
            withheld_cidr_count: event.requested.cidrs?.length ?? 0,
          }
        : {}),
    })
  }
}

function sandboxManager(
  env: HostedWorkerEnv,
  telemetry: ControlPlaneTelemetry,
  sandbox: { driver: SandboxDriver; leaseStore: SandboxLeaseStore } | undefined,
) {
  const selectedDriver = clean(env.CLAXEDO_SANDBOX_DRIVER)
  if (!sandbox) {
    if (!selectedDriver) return
    throw new HostedWorkerCompositionError(
      "hosted_capability_unavailable",
      "The selected hosted adapter does not provide the sandbox driver and durable lease store required by CLAXEDO_SANDBOX_DRIVER",
    )
  }
  if (!selectedDriver || sandbox.driver.id !== selectedDriver) {
    throw new HostedWorkerCompositionError(
      "hosted_sandbox_driver_mismatch",
      "The injected sandbox driver must exactly match the statically selected CLAXEDO_SANDBOX_DRIVER",
    )
  }
  const limits = safetyLimits(env)
  // The check is the DRIVER's own `metadata.egressControl`, read inside
  // `createSandboxManager`, rather than a `sandboxDriverCatalog[id]` lookup
  // here: a driver may narrow its declaration against the catalog entry
  // (`drivers/docker.ts` does), and two independent readings of the same
  // capability are two things that can disagree. One check, one warning.
  return createSandboxManager({
    leaseStore: sandbox.leaseStore,
    driver: sandbox.driver,
    staleAfterMs: positiveInteger(env, "CLAXEDO_SANDBOX_ACQUIRE_STALE_MS", 60_000),
    retryAfterMs: positiveInteger(env, "CLAXEDO_SANDBOX_PROVISIONING_RETRY_MS", 2_000),
    maxRetryCount: limits.sandboxMaxRetryCount,
    onEgressUnenforced: sandboxEgressUnenforcedSink(telemetry),
  })
}

export function hostedDeviceAuthProvider(env: HostedWorkerEnv): HostedDeviceAuthProvider | undefined {
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
  /** Present only for adapters whose native sessions use the retained registry. */
  cliSessionTokenRegistry?: CliSessionTokenRegistry
  /** Device-login provider; undefined until a trusted CLI issuer is configured. */
  deviceAuthProvider?: HostedDeviceAuthProvider
  /** Explicit private-session oracle. Never inferred from the broader workspace authority. */
  runtimeSessionAuthority?: RuntimeSessionAuthorityOptions["authority"]
  /** Full authenticated private-session lifecycle, selected explicitly by the adapter. */
  privateSessionAuthority?: PrivateSessionAuthority
  /** Durable exactly-one prompt admission; never synthesized in process. */
  turnAuthority?: SessionTurnAuthority
  env: HostedWorkerEnv
}

export type HostedControlPlaneAdapterBindings = {
  auth: ControlPlaneAuthAdapter
  authority: WorkspaceAuthority
  userHostedResolver: UserHostedTargetResolver
  /** Adapter-owned native sessions own this registry; Better Auth owns OAuth state in AUTH_DB. */
  cliSessionTokenRegistry?: CliSessionTokenRegistry
  /** Required only when the static sandbox posture selects a driver. */
  sandbox?: { driver: SandboxDriver; leaseStore: SandboxLeaseStore }
  deviceAuthProvider?: HostedDeviceAuthProvider
  /** Required by deployments that admit isolated runtime session operations. */
  runtimeSessionAuthority?: RuntimeSessionAuthorityOptions["authority"]
  /** Never synthesized from WorkspaceAuthority, even when the object happens to overlap. */
  privateSessionAuthority?: PrivateSessionAuthority
  /** Required by adapters that certify managed multiplayer prompt admission. */
  turnAuthority?: SessionTurnAuthority
}

/**
 * Provider-neutral hosted composition. Authentication and persistence adapters
 * are selected by the static entrypoint and injected as ports; this graph has
 * no identity-provider or persistence implementation imports.
 */
export function composeProviderNeutralHostedControlPlane(
  env: HostedWorkerEnv,
  bindings: HostedControlPlaneAdapterBindings,
): HostedControlPlane {
  if (!bindings.auth.config.enabled) {
    throw new HostedWorkerCompositionError(
      "hosted_auth_disabled",
      `Hosted Worker control plane requires enabled signed auth: ${bindings.auth.config.reason}`,
    )
  }
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
    "a token signing private key (CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)",
  )
  required(
    env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
    "hosted_dependency_missing",
    "the current token verification key (CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)",
  )
  try {
    runtimeAccessTokenAlgorithm(env)
  } catch (error) {
    if (!(error instanceof RuntimeAccessTokenConfigurationError)) throw error
    throw new HostedWorkerCompositionError(error.code, error.message)
  }

  // Telemetry is composed BEFORE the sandbox manager: composing the manager is
  // what emits the boot-time "this driver cannot contain egress" event, and a
  // sink that does not exist yet cannot receive it.
  const telemetry = workerTelemetry(env)
  const manager = sandboxManager(env, telemetry, bindings.sandbox)
  const homeRegion = defaultHomeRegion(env)
  const relayUrls = relayEndpointsFromEnv(env, relayUrl)
  const runtimeAccessSigner = runtimeAccessTokenSigner(env)
  const hostTunnelSigner = hostTunnelTokenSigner(env)
  const relayTargetLookup = sandboxRelayTargetLookup({
    ...(manager ? { sandboxManager: manager } : {}),
    userHostedResolver: bindings.userHostedResolver,
    telemetry,
    env,
  })
  const relayProvider = createControlPlaneRelayProvider({
    relay: {
      relayUrl,
      relayUrls,
    },
    runtimeAccessTokenSigner: runtimeAccessSigner,
    hostTunnelTokenSigner: hostTunnelSigner,
    targetLookup: relayTargetLookup,
    recordRuntimeAccessToken: (input) => recordRelayRuntimeToken(bindings.authority, input),
    telemetry,
  })
  const services: ControlPlaneServices = {
    projectionStore: unusedStore<ProjectionStore>("Session projection store"),
    durableSessionLog: unusedStore<DurableSessionLog>("Durable session log"),
    auth: bindings.auth,
    credentials: workerCredentials(env),
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
    authority: bindings.authority,
  }

  return {
    services,
    relayUrl,
    resolverToken,
    safetyLimits: limits,
    relayTargetLookup,
    ...(bindings.cliSessionTokenRegistry ? { cliSessionTokenRegistry: bindings.cliSessionTokenRegistry } : {}),
    ...(bindings.deviceAuthProvider ? { deviceAuthProvider: bindings.deviceAuthProvider } : {}),
    ...(bindings.runtimeSessionAuthority ? { runtimeSessionAuthority: bindings.runtimeSessionAuthority } : {}),
    ...(bindings.privateSessionAuthority ? { privateSessionAuthority: bindings.privateSessionAuthority } : {}),
    ...(bindings.turnAuthority ? { turnAuthority: bindings.turnAuthority } : {}),
    env,
  }
}
