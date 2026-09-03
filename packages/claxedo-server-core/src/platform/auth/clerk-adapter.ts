import { createClerkTokenVerifier, type TokenVerifier } from "@claxedo/workspace-relay-protocol"

import {
  type ClerkVerifier,
  type ControlPlaneAuthAdapter,
  type EnabledConfig,
  type VerifiedClerkAuth,
} from "./auth"
import { createClerkNativeSessionAuthPort } from "./cli-session-token"
import type { AdapterNativeSessionAuthPort } from "./auth"

const CLERK_ALGORITHMS = ["ES256", "EdDSA", "RS256"] as const

function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

function enabled(input?: string) {
  return ["1", "true", "yes"].includes((input ?? "").trim().toLowerCase())
}

/** True only for the retained Clerk/Convex deployment adapter. */
export function signedCloudAuthRequested(env: NodeJS.ProcessEnv = process.env) {
  return enabled(env.CLAXEDO_SIGNED_CLOUD_AUTH)
}

export function controlPlaneAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  input: { authorityConfigured?: boolean } = {},
): import("./auth").ControlPlaneAuthConfig {
  if (!signedCloudAuthRequested(env)) {
    return { enabled: false, mode: "local-only", reason: "signed/cloud auth is disabled" }
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
    adapter: "clerk",
    issuer,
    jwksUrl,
    ...(clean(env.CLERK_JWT_AUDIENCE) ? { audience: clean(env.CLERK_JWT_AUDIENCE) } : {}),
  }
}

function orgId(payload: { org_id?: unknown; orgId?: unknown; o?: unknown }) {
  const organization = payload.o && typeof payload.o === "object" && !Array.isArray(payload.o)
    ? (payload.o as Record<string, unknown>).id
    : undefined
  const value = payload.org_id ?? payload.orgId ?? organization
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Adapter-private normalization of the retained Clerk verifier. */
export function tokenVerifierAsClerk(verifier: TokenVerifier): ClerkVerifier {
  return async (token, config) => {
    const verified = await verifier.verify(token)
    if (!verified.subject) throw new Error("Clerk verifier did not return a subject")
    const claims = verified.claims as Record<string, unknown>
    const aud = claims.aud
    const iss = claims.iss
    const orgClaim = orgId(claims)
    const issuer = typeof iss === "string" ? iss : config.issuer
    return {
      mode: "signed",
      user: {
        subject: verified.subject,
        tokenIdentifier: `${issuer}|${verified.subject}`,
        issuer,
        ...(typeof aud === "string" || Array.isArray(aud) ? { audience: aud as string | string[] } : {}),
        ...(orgClaim ? { orgId: orgClaim } : {}),
      },
    }
  }
}

export async function verifyClerkBearer(token: string, config: EnabledConfig): Promise<VerifiedClerkAuth> {
  const verified = await createClerkTokenVerifier({
    issuer: config.issuer,
    algorithms: [...CLERK_ALGORITHMS],
    jwksUrl: config.jwksUrl,
    ...(config.audience ? { audience: config.audience } : {}),
  }).verify(token)
  if (!verified.subject) throw new Error("Clerk verifier did not return a subject")

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

/** The retained Clerk/legacy-native implementation of the legacy internal port. */
export function clerkAuthAdapter(input: {
  env?: NodeJS.ProcessEnv
  verifier?: ClerkVerifier
  native?: AdapterNativeSessionAuthPort
  authorityConfigured?: boolean
} = {}): ControlPlaneAuthAdapter {
  const env = input.env ?? process.env
  const config = controlPlaneAuthConfig(env, { authorityConfigured: input.authorityConfigured })
  if (!config.enabled) return { config }
  const native = input.native ?? createClerkNativeSessionAuthPort({ env })
  if (native.adapter !== "clerk") throw new Error("Clerk auth requires its Clerk-owned native session adapter")
  return {
    config,
    native,
    verifier: async (token, selected) => native.acceptsAccessToken(token)
      ? native.authenticate(token)
      : input.verifier
        ? input.verifier(token, selected)
        : verifyClerkBearer(token, selected),
  }
}
