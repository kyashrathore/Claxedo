import { z } from "zod"
import type { RelayRole } from "@claxedo/workspace-relay"
import type { RepositoryAccessResult } from "../../hosts/connections"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../../authority/auth"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../../authority/services"
import type { HostTunnelTokenSigner, RuntimeAccessTokenSigner } from "../../authority/runtime-access-token"
import type { ConnectionRateLimiter } from "../../authority/rate-limit"
import { regionValue, type ClaxedoRegion, type ClaxedoRegionMap } from "../../region"

export type WorkspaceRouteOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  cliTokenEnv?: Record<string, string | undefined>
  credentials?: ControlPlaneCredentials
  /** Transport for provider-facing probes (sandbox key verification). Tests stub it. */
  fetch?: typeof fetch
  connections?: {
    repositoryForAuth(
      auth: SignedControlPlaneAuth | undefined,
      id: string,
      fullName: string,
    ): Promise<RepositoryAccessResult>
  }
  relayUrl?: string
  relayUrls?: ClaxedoRegionMap<string>
  defaultHomeRegion?: ClaxedoRegion
  runtimeAccessTokenSigner?: RuntimeAccessTokenSigner
  hostTunnelTokenSigner?: HostTunnelTokenSigner
  connectionRateLimiter?: ConnectionRateLimiter
  controlPlaneRateLimiter?: ConnectionRateLimiter
  /**
   * D6/B4 entitlement choke point (ADR 014 §5;
   * adversarial-review F3): hosted cloud-workspace capability is paid at BOTH
   * create AND wake/resume — a canceled subscription must not keep an existing
   * cloud workspace wake-able forever. The hosted app composes this from
   * src/billing/entitlement.ts (`createEntitlementGate` + authority org
   * resolution); it returns a ready-to-serve denial (402 free tier / 503 mirror
   * unreadable — both fail-closed) or undefined when entitled. Absent hook = no
   * billing gate (route tests, self-host / local compositions never supply it);
   * the hosted app always supplies it. Only ever consulted for HOSTED cloud
   * workspaces (the wake choke point guards on backing=cloud-vm/access=cloud).
   */
  requireCloudWorkspaceEntitlement?: (
    auth: SignedControlPlaneAuth,
  ) => Promise<{ status: 400 | 401 | 402 | 403 | 503; body: unknown } | undefined>
}

export function relayRole(input?: string): RelayRole {
  if (input === "owner" || input === "admin" || input === "editor" || input === "viewer") return input
  return "viewer"
}

export function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

export function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

export function apiError(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    code,
    message,
    ...(extra ?? {}),
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
    input.services?.telemetry.capture(
      input.auth?.user.subject ?? "local",
      input.event,
      {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.properties ?? {}),
      },
    )
  } catch {
    // Telemetry is operational evidence, not part of the workspace transaction.
  }
}

export async function routeAuth(
  request: Request,
  options: {
    authConfig?: ControlPlaneAuthConfig
    verifier?: ClerkVerifier
    cliTokenEnv?: Record<string, string | undefined>
    requireSigned?: boolean
  },
) {
  if (!options.requireSigned && !bearerToken(request.headers.get("authorization"))) return
  const context = await controlPlaneAuthContext(request, {
    config: options.authConfig,
    verifier: options.verifier,
    cliTokenEnv: options.cliTokenEnv,
  })
  return context.mode === "signed" ? context : undefined
}

export async function signedOrError(
  request: Request,
  options: {
    authConfig?: ControlPlaneAuthConfig
    verifier?: ClerkVerifier
    requireSigned?: boolean
  },
  services?: ControlPlaneServices,
) {
  try {
    const auth = await routeAuth(request, options)
    if (auth) {
      captureWorkspaceTelemetry({
        services,
        auth,
        event: "control_plane.auth.signed",
        properties: {
          issuer: auth.user.issuer,
          ...(auth.user.orgId ? { orgId: auth.user.orgId } : {}),
        },
      })
    }
    return {
      auth,
    }
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

export function configuredRelayUrl(options: WorkspaceRouteOptions, homeRegion?: ClaxedoRegion) {
  const region = homeRegion ?? options.defaultHomeRegion ?? "us-east"
  return regionValue(options.relayUrls, region)?.trim() ?? options.relayUrl?.trim()
}

export function configuredRuntimeAccessTokenSigner(options: WorkspaceRouteOptions) {
  if (options.runtimeAccessTokenSigner) return options.runtimeAccessTokenSigner
  throw new ControlPlaneAuthError(
    503,
    "runtime_access_token_signer_unavailable",
    "Runtime Access Token signer is not configured",
  )
}

export async function hostTunnelCredential(
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  input: {
    hostId: string
    workspaceId: string
  },
) {
  const signer = configuredHostTunnelTokenSigner(options)
  if (!signer) return
  return await signer({
    subject: auth.user.subject,
    hostId: input.hostId,
    workspaceIds: [input.workspaceId],
  })
}
