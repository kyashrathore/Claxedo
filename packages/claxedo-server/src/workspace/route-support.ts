import { z } from "zod"
import type { RelayRole } from "@claxedo/workspace-relay"
import type { CodeHostRepository } from "@claxedo/connections"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import type { HostTunnelTokenSigner, RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import { regionValue, type ClaxedoRegion, type ClaxedoRegionMap } from "@claxedo/server-core/platform/runtime/region/index"
import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import type { SandboxStart } from "./sandbox-start"

export type WorkspaceRuntimeContext = {
  workspaceId: string
}

export type WorkspaceRuntimePreparation = {
  /** Existing sandbox-manager channel; values never enter runtime config or files. */
  secrets?: SandboxBrokeredSecret[]
  /** The readable half: what the runtime itself reads at boot and what the agent presents knowingly. */
  env?: Record<string, string>
  /** Feature-private immutable plan, passed back only to the matching provision hook. */
  state?: unknown
}

/**
 * Whether the deployment admits cloud workspaces, asked of the tenant a cloud
 * workspace would belong to rather than of a request shape. `auth` is present when the caller
 * holds a signed request; `orgId` is the authority-resolved organization when
 * it does not. A gate given neither has no tenant to answer for and must
 * refuse rather than guess one.
 */
export type CloudWorkspaceEntitlementGate = (tenant: {
  orgId?: string
  auth?: SignedControlPlaneAuth
}) => Promise<
  { status: 400 | 401 | 402 | 403 | 503; body: { error: { code: string; message: string } } } | undefined
>

export type WorkspaceRouteOptions = {
  authentication?: RequestAuthenticationAdapter
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  cliTokenEnv?: Record<string, string | undefined>
  credentials?: ControlPlaneCredentials
  connections?: {
    repositoryForAuth(
      auth: SignedControlPlaneAuth | undefined,
      id: string,
      fullName: string,
    ): Promise<
      | { ok: true; repository: CodeHostRepository }
      | { ok: false; status: 401 | 402 | 403 | 404 | 409 | 501 | 502 | 503; code: string }
    >
  }
  relayUrl?: string
  relayUrls?: ClaxedoRegionMap<string>
  /**
   * Where a host verifies the Relay Host Tokens the relay mints — the relay's
   * own published key set. Absent, the heartbeat derives `<relay url>/.well-known/jwks.json`.
   */
  relayHostJwksUrl?: string
  /** The session-authorize endpoint a machine-enrolled host's runtime consults for private sessions. */
  sessionAuthorityUrl?: string
  /** Where a machine-enrolled host publishes its sessions' list rows. */
  sessionRowsUrl?: string
  defaultHomeRegion?: ClaxedoRegion
  sandboxEgressExtraHosts?: string[]
  /** The origin a hosted sandbox is told to reach this control plane at, which its egress allows. */
  sandboxControlPlaneOrigin?: string
  runtimeAccessTokenSigner?: RuntimeAccessTokenSigner
  hostTunnelTokenSigner?: HostTunnelTokenSigner
  connectionRateLimiter?: ConnectionRateLimiter
  controlPlaneRateLimiter?: ConnectionRateLimiter
  /** The start of a cloud workspace's sandbox, which the hosted connect begins and polls but never drives itself. */
  sandboxStart?: SandboxStart
  /** Resolve feature state before ensure, including brokered secrets needed by the driver. */
  prepareRuntime?: (context: WorkspaceRuntimeContext) => Promise<WorkspaceRuntimePreparation>
  /** Build-composed feature provisioning that must settle before a signed runtime is handed to the caller. */
  provisionRuntime?: (context: WorkspaceRuntimeContext, preparation?: WorkspaceRuntimePreparation) => Promise<void>
  runtimeProvisioned?: (context: WorkspaceRuntimeContext) => Promise<boolean>
  /** Build-composed withdrawal of what `prepareRuntime` issued a cloud root, once its workspace is deleted. */
  releaseRuntime?: (context: WorkspaceRuntimeContext) => Promise<void>
  /**
   * Cloud-workspace admission, asked at BOTH create AND wake/resume, so a
   * deployment that stops admitting cloud workspaces cannot keep an existing
   * one wake-able. It returns a ready-to-serve denial or undefined when
   * admitted. Absent hook = no gate (route tests); the hosted app always
   * supplies it. Only
   * ever consulted for HOSTED cloud workspaces (the wake choke point guards on
   * backing=cloud-vm).
   *
   * The tenant is what is admitted: `auth` is the signed request when the
   * caller holds one, `orgId` the authority-resolved organization when the
   * create was initiated by a minted credential with no bearer of its own (a
   * Tasks cloud root started by a session's agent). An implementation that
   * needs neither is not an entitlement gate.
   */
  requireCloudWorkspaceEntitlement?: CloudWorkspaceEntitlementGate
}

export function relayRole(input?: string): RelayRole {
  if (input === "owner" || input === "admin" || input === "editor" || input === "viewer") return input
  return "viewer"
}

export function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

export function apiError(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    code,
    message,
    ...extra,
  }
}

export function parsedBody<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
):
  | { ok: true; body: z.infer<Schema> }
  | { ok: false; error: ReturnType<typeof apiError>; status: 400 } {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, body: result.data }
  return {
    ok: false,
    error: apiError("invalid_request_body", "Request body failed validation", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    }),
    status: 400,
  }
}

export function captureWorkspaceTelemetry(input: {
  services?: ControlPlaneServices
  auth?: SignedControlPlaneAuth
  event: string
  workspaceId?: string
  properties?: Record<string, unknown>
}) {
  try {
    const orgId = input.auth?.user.orgId
    input.services?.telemetry.capture(
      input.auth?.user.subject ?? "local",
      input.event,
      {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...input.properties,
        ...(orgId ? { $groups: { org: orgId } } : {}),
      },
    )
  } catch {
    // Telemetry is operational evidence, not part of the workspace transaction.
  }
}

export async function routeAuth(
  request: Request,
  options: {
    authentication?: RequestAuthenticationAdapter
    authConfig?: ControlPlaneAuthConfig
    verifier?: ControlPlaneTokenVerifier
    cliTokenEnv?: Record<string, string | undefined>
    requireSigned?: boolean
  },
) {
  if (!options.requireSigned && !bearerToken(request.headers.get("authorization"))) return undefined
  const context = await controlPlaneAuthContext(request, {
    authentication: options.authentication,
    config: options.authConfig,
    verifier: options.verifier,
    cliTokenEnv: options.cliTokenEnv,
  })
  return context.mode === "signed" ? context : undefined
}

export async function signedOrError(
  request: Request,
  options: {
    authentication?: RequestAuthenticationAdapter
    authConfig?: ControlPlaneAuthConfig
    verifier?: ControlPlaneTokenVerifier
    requireSigned?: boolean
  },
  services?: ControlPlaneServices,
) {
  try {
    return { auth: await routeAuth(request, options) }
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      captureWorkspaceTelemetry({
        services,
        event: "control_plane.auth.denied",
        properties: {
          code: err.code,
          status: err.status,
        },
      })
      return { error: controlPlaneAuthErrorBody(err), status: err.status }
    }
    throw err
  }
}

export function configuredHostTunnelTokenSigner(options: WorkspaceRouteOptions) {
  return options.hostTunnelTokenSigner
}

export function configuredRelayUrl(options: Pick<WorkspaceRouteOptions, "relayUrl" | "relayUrls" | "defaultHomeRegion">, homeRegion?: ClaxedoRegion) {
  const region = homeRegion ?? options.defaultHomeRegion ?? "us-east"
  return regionValue(options.relayUrls, region)?.trim() ?? options.relayUrl?.trim()
}

/**
 * The endpoints a machine-enrolled host is told on redeem and every beat,
 * from the deployment's environment. The session authority defaults to this
 * plane's own `/api/runtime-authority/session-authorize` under its public
 * origin, the same address a hosted sandbox is given.
 */
export function hostConnectEndpointOptions(env: Record<string, string | undefined>) {
  const jwksUrl = env.CLAXEDO_RELAY_HOST_JWKS_URL?.trim()
  const origin = (env.CLAXEDO_SESSION_AUTHORITY_ORIGIN ?? env.BETTER_AUTH_URL ?? env.CLAXEDO_PUBLIC_URL)?.trim()
  const base = origin?.replace(/\/+$/, "")
  const sessionAuthorityUrl =
    env.CLAXEDO_SESSION_AUTHORITY_URL?.trim() || (base ? `${base}/api/runtime-authority/session-authorize` : undefined)
  const sessionRowsUrl = base ? `${base}/api/claxedo/host/session-rows` : undefined
  return {
    ...(jwksUrl ? { relayHostJwksUrl: jwksUrl } : {}),
    ...(sessionAuthorityUrl ? { sessionAuthorityUrl } : {}),
    ...(sessionRowsUrl ? { sessionRowsUrl } : {}),
  }
}

/** The relay endpoints a machine-enrolled host serves against, or nothing when no relay is configured. */
export function configuredHostRelay(options: WorkspaceRouteOptions) {
  const url = configuredRelayUrl(options)
  if (!url) return undefined
  const jwksUrl = options.relayHostJwksUrl?.trim() || `${url.replace(/\/+$/, "")}/.well-known/jwks.json`
  return { url, jwks_url: jwksUrl }
}

export function configuredRuntimeAccessTokenSigner(options: WorkspaceRouteOptions) {
  if (options.runtimeAccessTokenSigner) return options.runtimeAccessTokenSigner
  throw new ControlPlaneAuthError(
    503,
    "runtime_access_token_signer_unavailable",
    "Runtime Access Token signer is not configured",
  )
}

/** The 401 body a signed-only route answers when `signedOrError` admitted no bearer. */
export function missingBearerBody() {
  return controlPlaneAuthErrorBody(
    new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
  )
}
