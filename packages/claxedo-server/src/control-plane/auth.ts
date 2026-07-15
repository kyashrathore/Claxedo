import { createClerkTokenVerifier } from "@claxedo/workspace-relay-protocol"
import { verifyCliAccessBearer } from "./cli-session-token"

const ALGORITHMS = ["ES256", "EdDSA", "RS256"] as const

export type EnabledConfig = {
  enabled: true
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
  token: string
  tokenKind?: "cli"
  user: {
    subject: string
    tokenIdentifier: string
    issuer: string
    audience?: string | string[]
    orgId?: string
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
      | "invalid_session_id"
      | "workspace_authority_unavailable"
      | "workspace_authorization_denied"
      | "workspace_id_required"
      | "central_session_required"
      | "central_session_workspace_required"
      | "hybrid_loopback_only"
      | "hybrid_mode_required"
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

export type VerifiedClerkAuth = Omit<SignedControlPlaneAuth, "token">

export type ClerkVerifier = (token: string, config: EnabledConfig) => Promise<VerifiedClerkAuth>

export type ControlPlaneAuthAdapter = {
  config: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
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
 * P-shared.2: adapt a unified `TokenVerifier` to the existing
 * `ClerkVerifier` shape so the control-plane auth path can be backed
 * by any implementation of `@claxedo/workspace-relay-protocol`'s
 * `TokenVerifier` (HTTP introspection, static-table tests, custom
 * hosted IdP).
 *
 * The adapter trusts the verifier to enforce issuer/audience/expiry
 * itself; the resulting `VerifiedClerkAuth` carries through the
 * standard claim fields the rest of the server reads.
 *
 * Usage:
 *   ```ts
 *   import { createStaticTokenVerifier } from "@claxedo/workspace-relay-protocol"
 *   const verifier = createStaticTokenVerifier({ tokens: { ... } })
 *   const ctx = await controlPlaneAuthContext(req, {
 *     verifier: tokenVerifierAsClerk(verifier),
 *   })
 *   ```
 */
export function tokenVerifierAsClerk(
  verifier: import("@claxedo/workspace-relay-protocol").TokenVerifier,
): ClerkVerifier {
  // `VerifiedClerkAuth` = `Omit<SignedControlPlaneAuth, "token">`
  // — it carries `mode: "signed"` and a `user: { subject, tokenIdentifier,
  // issuer, audience?, orgId? }` block, NOT `mode: "signed-cloud"` with a
  // free-form `claims` map. Earlier shape drifted; fix the adapter to emit
  // the live contract.
  return async (token, _config) => {
    const verified = await verifier.verify(token)
    const claims = verified.claims as Record<string, unknown>
    const aud = claims.aud
    const iss = claims.iss
    const orgClaim = orgId(claims)
    const issuer = typeof iss === "string" ? iss : ""
    const tokenIdentifier =
      typeof claims.jti === "string"
        ? claims.jti
        : typeof claims.sid === "string"
          ? claims.sid
          : `${issuer}:${verified.subject}`
    return {
      mode: "signed" as const,
      user: {
        subject: verified.subject,
        tokenIdentifier,
        issuer,
        ...(typeof aud === "string" || Array.isArray(aud)
          ? { audience: aud as string | string[] }
          : {}),
        ...(typeof orgClaim === "string" && orgClaim ? { orgId: orgClaim } : {}),
      },
    }
  }
}

function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

function enabled(input?: string) {
  return ["1", "true", "yes"].includes((input ?? "").trim().toLowerCase())
}

function orgId(payload: { org_id?: unknown; orgId?: unknown; o?: unknown }) {
  const organization = payload.o && typeof payload.o === "object" && !Array.isArray(payload.o)
    ? (payload.o as Record<string, unknown>).id
    : undefined
  const value = payload.org_id ?? payload.orgId ?? organization
  return typeof value === "string" && value.trim() ? value : undefined
}

function adapterConfig(input: { issuer: string; jwksUrl?: string; audience?: string }): EnabledConfig {
  return {
    enabled: true,
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

export function clerkAuthAdapter(input: {
  env?: NodeJS.ProcessEnv
  verifier?: ClerkVerifier
  /** Whether the composition resolved a workspace-authority backend. See `controlPlaneAuthConfig`. */
  authorityConfigured?: boolean
} = {}): ControlPlaneAuthAdapter {
  return {
    config: controlPlaneAuthConfig(input.env, { authorityConfigured: input.authorityConfigured }),
    ...(input.verifier ? { verifier: input.verifier } : {}),
  }
}

export function customVerifierAuthAdapter(input: {
  issuer: string
  audience?: string
  jwksUrl?: string
  verifier: ClerkVerifier
}): ControlPlaneAuthAdapter {
  return {
    config: adapterConfig(input),
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
    issuer: input.issuer,
    audience: input.audience,
    jwksUrl: input.jwksUrl ?? `better-auth:${encodeURIComponent(input.issuer)}`,
    verifier: async (token, config) => {
      const session = await input.verifier(token)
      const subject = session ? betterAuthSubject(session) : undefined
      if (!session || !subject) {
        // Plain Error (NOT ControlPlaneAuthError): `controlPlaneAuthContext`
        // rethrows ControlPlaneAuthError immediately, which would skip the
        // CLI-access-token fallback. A bearer the Better Auth issuer doesn't
        // recognize may still be a valid CLI session token.
        throw new Error("Bearer token is not a known Better Auth session")
      }
      const audience = session.audience ?? config.audience
      const org = session.orgId ?? session.org_id ?? session.organizationId
      return {
        mode: "signed",
        user: {
          subject,
          tokenIdentifier: session.tokenIdentifier ?? session.session?.id ?? `${config.issuer}|${subject}`,
          issuer: session.issuer ?? config.issuer,
          ...(audience ? { audience } : {}),
          ...(org ? { orgId: org } : {}),
        },
      }
    },
  })
}

/** True when the deployment asked for signed/cloud auth (CLAXEDO_SIGNED_CLOUD_AUTH). */
export function signedCloudAuthRequested(env: NodeJS.ProcessEnv = process.env) {
  return enabled(env.CLAXEDO_SIGNED_CLOUD_AUTH)
}

export function controlPlaneAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  input: {
    /**
     * Whether the composition root resolved a workspace-authority backend.
     * Signed/cloud auth is useless without one, so an explicit `false` fails
     * the config closed. This module deliberately knows NO backend URL env
     * names — the storage adapter owns those; the composition passes the
     * resolved presence in.
     */
    authorityConfigured?: boolean
  } = {},
): ControlPlaneAuthConfig {
  if (!enabled(env.CLAXEDO_SIGNED_CLOUD_AUTH)) {
    return {
      enabled: false,
      mode: "local-only",
      reason: "signed/cloud auth is disabled",
    }
  }

  const issuer = clean(env.CLERK_JWT_ISSUER) ?? clean(env.CLERK_ISSUER_URL)
  const jwksUrl = clean(env.CLERK_JWKS_URL)
  if (!issuer || !jwksUrl || input.authorityConfigured === false) {
    return {
      enabled: false,
      mode: "misconfigured",
      reason: "CLERK_JWT_ISSUER, CLERK_JWKS_URL, and CLAXEDO_WORKSPACE_AUTHORITY_URL are required for signed/cloud auth",
    }
  }

  return {
    enabled: true,
    issuer,
    jwksUrl,
    ...(clean(env.CLERK_JWT_AUDIENCE) ? { audience: clean(env.CLERK_JWT_AUDIENCE) } : {}),
  }
}

export function bearerToken(header: string | null) {
  if (!header) return
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

export async function verifyClerkBearer(token: string, config: EnabledConfig): Promise<VerifiedClerkAuth> {
  const verified = await createClerkTokenVerifier({
    issuer: config.issuer,
    algorithms: [...ALGORITHMS],
    jwksUrl: config.jwksUrl,
    ...(config.audience ? { audience: config.audience } : {}),
  }).verify(token)

  return {
    mode: "signed",
    user: {
      subject: verified.subject,
      tokenIdentifier: `${verified.claims.iss ?? config.issuer}|${verified.subject}`,
      issuer: verified.claims.iss ?? config.issuer,
      ...(verified.claims.aud ? { audience: verified.claims.aud } : {}),
      ...(orgId(verified.claims) ? { orgId: orgId(verified.claims) } : {}),
    },
  }
}

export async function controlPlaneAuthContext(
  request: Request,
  options: {
    config?: ControlPlaneAuthConfig
    verifier?: ClerkVerifier
    cliTokenEnv?: Record<string, string | undefined>
  } = {},
): Promise<ControlPlaneAuthContext> {
  const config = options.config ?? controlPlaneAuthConfig()
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
    return {
      ...await (options.verifier ?? verifyClerkBearer)(token, config),
      token,
    }
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) throw err
    try {
      return {
        ...await verifyCliAccessBearer(token, options.cliTokenEnv),
        token,
      }
    } catch {}
    throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
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
