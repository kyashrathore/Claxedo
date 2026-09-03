export type EnabledConfig = {
  enabled: true
  /** Static composition identity. */
  adapter?: AuthAdapterId
  issuer: string
  jwksUrl: string
  audience?: string
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
  tokenKind?: "cli"
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
 * Default auth config for a route mounted WITHOUT an explicit one. Signed
 * deployments pass a config from their Better Auth composition; the fallback
 * has to be posture-aware, because "no config" means opposite things in the
 * two postures:
 *
 * - `local` (the default, variable unset): every request stays unsigned-local
 *   — the desktop loopback posture. No hosted-provider fallback exists.
 * - `hosted`: a route that reaches serving with no auth config is a
 *   COMPOSITION BUG, not a desktop. Answering `local-only` there would admit
 *   remote callers as the trusted unsigned-local owner, so fail CLOSED with
 *   `misconfigured` — which `controlPlaneAuthContext` below already turns into
 *   503 `signed_cloud_auth_disabled`, as does `unsignedLocalRequestGuard`.
 *
 * `authority/deployment-mode.ts` OWNS parsing this variable, including
 * rejecting typos at boot; importing it here would invert the dependency
 * direction (authority -> platform/auth), so this reads the env name directly
 * and mirrors ONLY the fail-closed case. Values that module rejects never
 * reach serving, so anything other than exactly `hosted` keeps the local-only
 * default rather than duplicating that validation.
 */
export function controlPlaneAuthConfig(
  env: Record<string, string | undefined> = process.env,
): ControlPlaneAuthConfig {
  if (env.CLAXEDO_DEPLOYMENT_MODE?.trim().toLowerCase() === "hosted") {
    return {
      enabled: false,
      mode: "misconfigured",
      reason: "hosted route mounted without an explicit auth config",
    }
  }
  return localOnlyAuthAdapter().config
}

export function bearerToken(header: string | null) {
  if (!header) return
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
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
    return {
      ...verified,
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
