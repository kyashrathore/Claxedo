/**
 * Retained Clerk + Convex hosted composition.
 *
 * Provider-neutral construction lives in `provider-neutral-hosted-services`.
 * This wrapper is the only production composition edge that selects the
 * retained adapters, so importing a Better Auth + D1 entrypoint never pulls
 * Clerk or Convex into that artifact.
 */

import { clerkAuthAdapter } from "@claxedo/server-core/platform/auth/clerk-adapter"
import { createClerkNativeSessionAuthPort } from "@claxedo/server-core/platform/auth/cli-session-token"

import { createConvexLeaseStore } from "../sandbox/stores/convex"
import {
  composeWorkerAuthority,
  composeWorkerCliSessionTokenRegistry,
  composeWorkerUserHostedResolver,
} from "./adapters/worker/hosted-compose"
import { lifecycleMinutes, sandboxDriver } from "./adapters/worker/retained-sandbox-driver"
import {
  composeProviderNeutralHostedControlPlane,
  hostedDeviceAuthProvider,
  required,
  type HostedControlPlane,
  type HostedWorkerEnv,
} from "./provider-neutral-hosted-services"
import { convexAuthorityUrlFromEnv } from "./adapters/convex/workspace-authority"
import { HostedWorkerCompositionError } from "./composition-error"

export { HostedWorkerCompositionError, type HostedWorkerEnv } from "./adapters/worker/hosted-compose"

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
    // 600/min: the app shell's boot burst (bootstrap + workspaces + workgraph
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
 * Convert one of the `*_MS` sandbox lifecycle knobs into the whole minutes the
 * Daytona API takes, with a one-minute floor.
 *
 * The floor is a data-safety guard, not rounding taste. Daytona reads BOTH
 * intervals as "0 means immediately": an auto-stop of 0 disables auto-stop
 * entirely (a sandbox that never idles out — the opposite of the intent), and
 * an auto-delete of 0 marks the sandbox EPHEMERAL, deleting it with its
 * filesystem the moment it stops. A sub-minute env value is always a
 * misconfiguration; silently turning one into "delete this user's workspace on
 * first idle" is not a failure mode worth preserving.
 */
export function lifecycleMinutes(env: HostedWorkerEnv, key: string, fallbackMs: number) {
  return Math.max(1, Math.round(positiveInteger(env, key, fallbackMs) / 60_000))
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
    // GC visibility has a DEPLOYMENT prerequisite on this driver, and it is the
    // auto-selected default: the sandbox Worker enumerates via its own registry
    // (`GET /sandboxes`, backed by the `BACKUP_BUCKET` R2 binding) because a
    // Durable Object namespace cannot be listed. A Worker deployed before that
    // route, or without the bucket bound, answers 501 — `garbageCollect()` then
    // reports `listingUnsupported` and the GC route 501s rather than claiming a
    // clean sweep. Loud and safe, but blind to orphans until the Worker is
    // redeployed. Note the deploy workflow does not create the bucket;
    // `wrangler r2 bucket create claxedo-sandbox-backups` is a manual step.
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
        ...(runtimeSessionAuthorityUrl(env) ? { sessionAuthorityUrl: runtimeSessionAuthorityUrl(env) } : {}),
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
      // Passed EXPLICITLY rather than left to Daytona's defaults. Daytona does
      // auto-stop idle sandboxes after 15 minutes on its own, so compute was
      // never the unbounded cost — but auto-delete is DISABLED by default, and
      // a stopped sandbox auto-archives after ~7 days and then keeps its
      // filesystem in object storage indefinitely. Since snapshot disk size is
      // the standing cost floor, that is a slow storage leak with nothing in
      // the system that would ever notice it.
      //
      // These are a backstop, not the reaper: the driver's `list()` lets
      // `garbageCollect()` enumerate real Daytona state and destroy a sandbox
      // with no matching lease.
      autoStopMinutes: lifecycleMinutes(env, "CLAXEDO_SANDBOX_AUTO_STOP_MS", 30 * 60_000),
      autoDeleteMinutes: lifecycleMinutes(env, "CLAXEDO_SANDBOX_AUTO_DELETE_MS", 24 * 60 * 60_000),
      ...(clean(env.DAYTONA_API_URL) ? { apiUrl: clean(env.DAYTONA_API_URL) } : {}),
      ...(clean(env.DAYTONA_ORGANIZATION_ID) ? { organizationId: clean(env.DAYTONA_ORGANIZATION_ID) } : {}),
      ...(clean(env.DAYTONA_TARGET) ? { target: clean(env.DAYTONA_TARGET) } : {}),
      runtimePort: workspaceRuntimePort(env),
      ...(clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) ? { workspaceDir: clean(env.CLAXEDO_RUNTIME_WORKSPACE_DIR) } : {}),
      ...(clean(env.CLAXEDO_RUNTIME_RUNNER) ? { runner: clean(env.CLAXEDO_RUNTIME_RUNNER) } : {}),
      controlEnv: {
        ...(runtimeSessionAuthorityUrl(env) ? { sessionAuthorityUrl: runtimeSessionAuthorityUrl(env) } : {}),
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
      ...(runtimeSessionAuthorityUrl(env)
        ? { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: runtimeSessionAuthorityUrl(env)! }
        : {}),
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

function runtimeSessionAuthorityUrl(env: HostedWorkerEnv) {
  const controlPlane = clean(env.CLAXEDO_PUBLIC_URL)
  return controlPlane
    ? `${controlPlane.replace(/\/+$/g, "")}/api/runtime-authority/session-authorize`
    : undefined
}

/**
 * Route the sandbox manager's egress-unenforced warning into ops telemetry,
 * without giving up the console line.
 *
 * The gap this closes is a DEPLOYMENT one, and it is silent by construction:
 * `defaultSandboxDriverName` prefers cloudflare, cloudflare declares
 * `egressControl: "none"`, and since the 2026-07-28 directive ("enforce where
 * we can and document where we can't") such a deployment boots fine and creates
 * fine — every hosted sandbox just comes up able to reach any host on the
 * internet. The manager already warns at composition, but `console.warn` inside
 * a Worker isolate reaches only whoever is tailing logs at that moment, which
 * is nobody on the day the driver is switched.
 *
 * So the event also becomes a queryable ops fact. Deliberately NOT a hard
 * `HostedWorkerCompositionError`: refusing composition would take the entire
 * control plane down — auth, relay, WorkGraph, every workspace already running
 * — over a provisioning-time capability. The failure this reports is real but
 * partial, and the response to it is an operator changing a driver, not an
 * outage.
 *
 * Ops plane, so `distinct_id: "system"` and no org/user identifiers — same
 * contract as `sandbox.touch` and the WorkGraph monitors. `egressControl` rides
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

function sandboxManager(env: HostedWorkerEnv, telemetry: ControlPlaneTelemetry) {
  const driver = sandboxDriver(env)
  if (!driver) return
  const limits = safetyLimits(env)
  // The check is the DRIVER's own `metadata.egressControl`, read inside
  // `createSandboxManager`, rather than a `sandboxDriverCatalog[id]` lookup
  // here: a driver may narrow its declaration against the catalog entry
  // (`drivers/docker.ts` does), and two independent readings of the same
  // capability are two things that can disagree. One check, one warning.
  return composeWorkerSandboxManager({
    env,
    driver,
    maxRetryCount: limits.sandboxMaxRetryCount,
    onEgressUnenforced: sandboxEgressUnenforcedSink(telemetry),
  })
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
  /**
   * Durable revocation registry for `claxedo login` credentials.
   *
   * REQUIRED, not optional: the CLI token path fails closed without a registry,
   * so an optional field would let a composition typecheck its way into a plane
   * that 503s every login and rejects every CLI bearer at runtime. Making it
   * part of the plane's shape means no hosted composition — production or test
   * — can exist without answering "where do revocations live?".
   */
  cliSessionTokenRegistry: CliSessionTokenRegistry
  /** Device-login provider; undefined until a trusted CLI issuer is configured. */
  deviceAuthProvider?: HostedDeviceAuthProvider
  env: HostedWorkerEnv
}

/** Preserve the existing public factory as the retained Clerk + Convex adapter wrapper. */
export function composeHostedControlPlane(env: HostedWorkerEnv): HostedControlPlane {
  const selected = clerkAuthAdapter({ env })
  if (!selected.config.enabled) {
    throw new HostedWorkerCompositionError(
      "hosted_auth_disabled",
      `Hosted Worker control plane requires enabled signed auth: ${selected.config.reason}`,
    )
  }

  const authority = composeWorkerAuthority(env)
  const cliSessionTokenRegistry = composeWorkerCliSessionTokenRegistry(env)
  const auth = clerkAuthAdapter({
    env,
    native: createClerkNativeSessionAuthPort({ env, registry: cliSessionTokenRegistry }),
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
      actorId: input.actorId,
      actorKind: input.actorKind,
      principalKind: input.principalKind,
      role: input.role,
      expiresAt: input.expiresAt,
    }),
    telemetry,
  })
  const services: ControlPlaneServices = {
    projectionStore: unusedStore<ProjectionStore>("Session projection store"),
    durableSessionLog: unusedStore<DurableSessionLog>("Durable session log"),
    auth,
    authority,
    privateSessionAuthority: authority,
    runtimeSessionAuthority: authority,
    cliSessionTokenRegistry,
    userHostedResolver: composeWorkerUserHostedResolver(env),
    ...(driver
      ? { sandbox: { driver, leaseStore: createConvexLeaseStore({ url: storageUrl, token: serviceToken }) } }
      : {}),
    ...(deviceAuthProvider ? { deviceAuthProvider } : {}),
  })
}
