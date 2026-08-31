import { decodeJwt } from "jose"

export type EnabledConfig = {
  enabled: true
  /** Static composition identity. */
  adapter?: AuthAdapterId
  issuer: string
  jwksUrl: string
  audience?: string
  /** Native OAuth access tokens carry `client_id`, not `aud`. */
  oauthClientId?: string
}

type DisabledConfig = {
  enabled: false
  mode: "local-only" | "misconfigured"
  reason: string
}

export type ControlPlaneAuthConfig = EnabledConfig | DisabledConfig

export type SignedControlPlaneAuth = {
  mode: "signed"
  /** Present only for Authorization transport. Browser cookies are never copied into this field. */
  token?: string
  tokenKind?: "cli" | "clerk-oauth"
  principal?: ControlPlanePrincipal
  user: {
    subject: string
    tokenIdentifier: string
    issuer: string
    audience?: string | string[]
    orgId?: string
  }
}

/** Canonical identity used by the explicit unsigned-local composition. */
export function localControlPlaneAuth(): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: "",
    user: {
      subject: "local",
      tokenIdentifier: "local:default",
      issuer: "claxedo-local",
    },
  }
}

export type ControlPlaneAuthContext =
  | SignedControlPlaneAuth
  | {
      mode: "unsigned-local"
      reason: string
    }

export class ControlPlaneAuthError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 503,
    public readonly code:
      | "signed_cloud_auth_disabled"
      | "missing_bearer_token"
      | "invalid_bearer_token"
      | "auth_verifier_unavailable"
      | "ambiguous_credentials"
      | "insufficient_assurance"
      | "identity_provisioning"
      | "account_suspended"
      | "account_deleted"
      | "invalid_session_id"
      | "workspace_authority_unavailable"
      | "workspace_authorization_denied"
      | "workspace_id_required"
      | "central_session_required"
      | "central_session_workspace_required"
      | "hybrid_loopback_only"
      | "hybrid_mode_required"
      | "invalid_hybrid_model"
      | "unsupported_hybrid_harness"
      | "invalid_tool_sandbox"
      | "central_hybrid_virtual_tools_only"
      | "runtime_access_token_signer_unavailable"
      | "host_tunnel_token_signer_unavailable"
      | "supervisor_backplane_token_signer_unavailable",
    message: string,
  ) {
    super(message)
  }
}

export type VerifiedControlPlaneAuth = Omit<SignedControlPlaneAuth, "token">

export type ControlPlaneTokenVerifier = (token: string, config: EnabledConfig) => Promise<VerifiedControlPlaneAuth>

export type AdapterNativeSessionTokenSet = {
  access_token: string
  refresh_token: string
  token_type: "Bearer"
  expires_in: number
  refresh_expires_in: number
  session_expires_in: number
  identity: string
}

/**
 * Adapter-owned native sessions (Claxedo-issued CLI token sets). Better Auth
 * does not implement this port: its OAuth server owns device authorization,
 * refresh, introspection, and RFC 7009 revocation directly.
 */
export type AdapterNativeSessionAuthPort = {
  adapter: "custom"
  acceptsAccessToken(token: string): boolean
  acceptsRefreshToken(token: string): boolean
  issue(auth: SignedControlPlaneAuth): Promise<AdapterNativeSessionTokenSet>
  refresh(refreshToken: string): Promise<AdapterNativeSessionTokenSet>
  authenticate(accessToken: string): Promise<VerifiedControlPlaneAuth>
  revoke(token: string): Promise<{ revokedAt: number }>
}

export type ControlPlaneAuthAdapter = {
  config: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  native?: AdapterNativeSessionAuthPort
}

export type BetterAuthSession = {
  subject?: string
  userId?: string
  user?: {
    id?: string
  }
  session?: {
    id?: string
  }
  tokenIdentifier?: string
  issuer?: string
  audience?: string | string[]
  orgId?: string
  org_id?: string
  organizationId?: string
}

export type BetterAuthVerifier = (token: string) => Promise<BetterAuthSession | null | undefined>

/**
 * Classify an already-verified bearer's OAuth `client_id` claim.
 *
 * Native OAuth access tokens carry `client_id` instead of an OIDC `aud`, so a
 * token issued to any other client is not this deployment's and is rejected.
 * Exported so the retained Clerk adapter classifies with the same rule.
 */
export function clerkOAuthTokenKind(payload: Record<string, unknown>, config: EnabledConfig) {
  const clientId = typeof payload.client_id === "string" ? payload.client_id.trim() : ""
  if (!clientId) return
  if (!config.oauthClientId || clientId !== config.oauthClientId) {
    throw new ControlPlaneAuthError(
      401,
      "invalid_bearer_token",
      "Clerk OAuth access token was issued to an unrecognized client",
    )
  }
  return "clerk-oauth" as const
}

function verifiedBearerTokenKind(token: string, verified: VerifiedClerkAuth, config: EnabledConfig) {
  if (verified.tokenKind) return verified.tokenKind
  let payload: Record<string, unknown>
  try {
    payload = decodeJwt(token)
  } catch {
    // A custom verifier may authenticate an opaque bearer. It has no JWT
    // classification to add, and the verifier's result remains authoritative.
    return
  }
  return clerkOAuthTokenKind(payload, config)
}

function adapterConfig(input: {
  adapter: AuthAdapterId
  issuer: string
  jwksUrl?: string
  audience?: string
}): EnabledConfig {
  return {
    enabled: true,
    adapter: input.adapter,
    issuer: input.issuer,
    jwksUrl: input.jwksUrl ?? `custom-verifier:${encodeURIComponent(input.issuer)}`,
    ...(input.audience ? { audience: input.audience } : {}),
  }
}

function betterAuthSubject(session: BetterAuthSession) {
  return session.subject ?? session.userId ?? session.user?.id
}

export function localOnlyAuthAdapter(reason = "signed/cloud auth is disabled"): ControlPlaneAuthAdapter {
  return {
    config: {
      enabled: false,
      mode: "local-only",
      reason,
    },
  }
}

export function devAuthAdapter(reason = "signed/cloud auth is disabled"): ControlPlaneAuthAdapter {
  return localOnlyAuthAdapter(reason)
}

export function customVerifierAuthAdapter(input: {
  adapter?: AuthAdapterId
  issuer: string
  audience?: string
  jwksUrl?: string
  verifier: ControlPlaneTokenVerifier
}): ControlPlaneAuthAdapter {
  return {
    config: adapterConfig({ ...input, adapter: input.adapter ?? "custom" }),
    verifier: input.verifier,
  }
}

export function betterAuthAdapter(input: {
  issuer: string
  audience?: string
  jwksUrl?: string
  verifier: BetterAuthVerifier
}): ControlPlaneAuthAdapter {
  return customVerifierAuthAdapter({
    adapter: "better-auth",
    issuer: input.issuer,
    audience: input.audience,
    jwksUrl: input.jwksUrl ?? `better-auth:${encodeURIComponent(input.issuer)}`,
    verifier: async (token, config) => {
      const session = await input.verifier(token)
      const subject = session ? betterAuthSubject(session) : undefined
      if (!session || !subject) {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      }
      const audience = session.audience ?? config.audience
      const org = session.orgId ?? session.org_id ?? session.organizationId
      const issuer = session.issuer ?? config.issuer
      return {
        mode: "signed",
        user: {
          subject,
          tokenIdentifier: `${issuer}|${subject}`,
          issuer,
          ...(audience ? { audience } : {}),
          ...(org ? { orgId: org } : {}),
        },
      }
    },
  }) satisfies ControlPlaneAuthAdapter
}

/**
 * Neutral default auth config. Signed deployments pass an explicit config
 * from their Better Auth composition; without one every request stays
 * unsigned-local (desktop loopback). No hosted-provider fallback exists.
 */
export function controlPlaneAuthConfig(): ControlPlaneAuthConfig {
  return localOnlyAuthAdapter().config
}

export function bearerToken(header: string | null) {
  if (!header) return
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

/**
 * Tokens the control plane has verified but Convex cannot verify directly.
 *
 * CLI tokens are signed by Claxedo. Clerk OAuth access tokens use the OAuth
 * `client_id` claim and deliberately have no OIDC `aud`, so neither belongs in
 * Convex's OIDC provider list. Both cross the authority boundary through the
 * service-token facade with this already-verified canonical identity.
 */
export function usesServiceAuthority(auth: SignedControlPlaneAuth) {
  return auth.tokenKind === "cli" || auth.tokenKind === "clerk-oauth"
}

export function serviceAuthorityUser(auth: SignedControlPlaneAuth) {
  return {
    token_identifier: auth.user.tokenIdentifier,
    subject: auth.user.subject,
    issuer: auth.user.issuer,
  }
}

export async function controlPlaneAuthContext(
  request: Request,
  options: {
    config?: ControlPlaneAuthConfig
    verifier?: ControlPlaneTokenVerifier
    cliTokenEnv?: Record<string, string | undefined>
    authentication?: RequestAuthenticationAdapter
  } = {},
): Promise<ControlPlaneAuthContext> {
  if (options.authentication) {
    try {
      const principal = await options.authentication.authenticate(request)
      const token = bearerToken(request.headers.get("authorization"))
      return {
        mode: "signed",
        ...(token ? { token } : {}),
        principal,
        user: {
          subject: principal.userId,
          tokenIdentifier: `${principal.identity.issuer}|${principal.identity.subject}`,
          issuer: principal.identity.issuer,
        },
      }
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error
      const code = error.code === "invalid_credentials"
        ? "invalid_bearer_token"
        : error.code === "auth_unavailable" || error.code === "auth_configuration_invalid"
          ? "auth_verifier_unavailable"
          : error.code
      throw new ControlPlaneAuthError(error.status, code, error.message)
    }
  }
  const config = options.config ?? localOnlyAuthAdapter().config
  if (!config.enabled) {
    if (config.mode === "misconfigured") {
      throw new ControlPlaneAuthError(503, "signed_cloud_auth_disabled", config.reason)
    }
    return {
      mode: "unsigned-local",
      reason: config.reason,
    }
  }

  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
  }

  try {
    if (!options.verifier) {
      throw new ControlPlaneAuthError(503, "auth_verifier_unavailable", "Authentication verifier is unavailable")
    }
    const verified = await options.verifier(token, config)
    const tokenKind = verifiedBearerTokenKind(token, verified, config)
    return {
      ...verified,
      ...(tokenKind ? { tokenKind } : {}),
      token,
    }
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) throw err
    const status = typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : undefined
    if (status === 401 || status === 403) {
      throw new ControlPlaneAuthError(status, "invalid_bearer_token", "Bearer token is invalid")
    }
    throw new ControlPlaneAuthError(503, "auth_verifier_unavailable", "Authentication verifier is unavailable")
  }
}

export function controlPlaneAuthErrorBody(err: ControlPlaneAuthError) {
  return {
    error: {
      code: err.code,
      message: err.message,
    },
  }
}
import {
  AuthenticationError,
  type AuthAdapterId,
  type ControlPlanePrincipal,
  type RequestAuthenticationAdapter,
} from "./authentication"
