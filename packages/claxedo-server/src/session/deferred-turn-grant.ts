import { errors as joseErrors, jwtVerify, SignJWT, type JWTPayload } from "jose"
import { RUNTIME_ACCESS_TOKEN_ALGORITHM } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  childCompletionTurnIdPrefix,
  SessionTurnGrantError,
  type SessionTurnGrant,
  type SessionTurnGrantIntent,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { credentialFault, runtimeTokenSigningKey, runtimeTokenVerificationKey } from "../platform/auth/runtime-token-keys"

export const DEFERRED_TURN_GRANT_AUDIENCE = "workspace-runtime-deferred-turn" as const
export const DEFERRED_TURN_GRANT_ISSUER = "claxedo-control-plane" as const

/** The deployment lacks what minting or verifying needs — a fault, not a bad grant. */
export class DeferredTurnGrantConfigurationError extends Error {
  readonly code = "deferred_turn_grant_misconfigured"
}

const deferredTurnGrantFault = credentialFault("Deferred turn grant", DeferredTurnGrantConfigurationError)

/**
 * What a deferred turn grant says, as the control plane reads it back. The
 * row `grantId` names is the authority at redemption; the token only carries
 * the row's binding to whoever presents it later without a credential.
 */
export type DeferredTurnGrantClaims = PrivateSessionRuntimePrincipal & {
  grantId: string
  orgId: string
  workspaceId: string
  sessionId: string
  intent: SessionTurnGrantIntent
  subjectSessionId?: string
  turnId?: string
  turnIdPrefix?: string
  issuedAt: number
  expiresAt: number
}

export type DeferredTurnGrantInput = Omit<DeferredTurnGrantClaims, "issuedAt">

/** The token's claims for a grant row the authority just wrote for `principal`. */
export function deferredTurnGrantClaims(
  principal: PrivateSessionRuntimePrincipal,
  orgId: string,
  grant: SessionTurnGrant,
): DeferredTurnGrantInput {
  if (grant.actorId !== principal.actorId) {
    throw new SessionTurnGrantError("session_turn_grant_invalid", "Deferred turn grant row was minted for another actor")
  }
  return {
    ...principal,
    grantId: grant.grantId,
    orgId,
    workspaceId: grant.workspaceId,
    sessionId: grant.sessionId,
    intent: grant.intent,
    ...(grant.subjectSessionId === undefined ? {} : { subjectSessionId: grant.subjectSessionId }),
    ...(grant.turnId === undefined ? {} : { turnId: grant.turnId }),
    ...(grant.turnIdPrefix === undefined ? {} : { turnIdPrefix: grant.turnIdPrefix }),
    expiresAt: grant.expiresAt,
  }
}

export async function mintDeferredTurnGrant(
  claims: DeferredTurnGrantInput,
  env: Record<string, string | undefined>,
  options: { now?: () => number } = {},
): Promise<{ grant: string; expiresAt: number }> {
  const shape = grantShape(claims)
  if (shape) throw new SessionTurnGrantError("session_turn_grant_invalid", shape)
  const now = Math.floor((options.now?.() ?? Date.now()) / 1_000)
  const exp = Math.floor(claims.expiresAt / 1_000)
  if (exp <= now) throw new SessionTurnGrantError("session_turn_grant_invalid", "Deferred turn grant row has already expired")
  const { alg, key } = await runtimeTokenSigningKey(env, deferredTurnGrantFault)
  const grant = await new SignJWT({
    principal_kind: claims.principalKind,
    actor_id: claims.actorId,
    actor_kind: claims.actorKind,
    org_id: claims.orgId,
    workspace_id: claims.workspaceId,
    session_id: claims.sessionId,
    intent: claims.intent,
    ...(claims.subjectSessionId === undefined ? {} : { subject_session_id: claims.subjectSessionId }),
    ...(claims.turnId === undefined ? {} : { turn_id: claims.turnId }),
    ...(claims.turnIdPrefix === undefined ? {} : { turn_id_prefix: claims.turnIdPrefix }),
  })
    .setProtectedHeader({ alg })
    .setIssuer(DEFERRED_TURN_GRANT_ISSUER)
    .setAudience(DEFERRED_TURN_GRANT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(claims.grantId)
    .sign(key)
  return { grant, expiresAt: exp * 1_000 }
}

/**
 * The claims of a grant this control plane signed for `sessionId`, or a
 * `SessionTurnGrantError` naming why the token is refused. Whether the row
 * it names still admits the turn is the turn authority's question at
 * redemption, not this one.
 */
export async function verifyDeferredTurnGrant(
  token: string,
  env: Record<string, string | undefined>,
  options: { sessionId: string; now?: () => number },
): Promise<DeferredTurnGrantClaims> {
  const { key } = await runtimeTokenVerificationKey(env, deferredTurnGrantFault)
  let payload: JWTPayload
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
      issuer: DEFERRED_TURN_GRANT_ISSUER,
      audience: DEFERRED_TURN_GRANT_AUDIENCE,
      requiredClaims: ["jti", "iat", "exp"],
      ...(options.now ? { currentDate: new Date(options.now()) } : {}),
    })
    payload = verified.payload
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new SessionTurnGrantError("session_turn_grant_expired", "Deferred turn grant has expired")
    }
    throw new SessionTurnGrantError("session_turn_grant_invalid", "Deferred turn grant is not one this control plane signed")
  }
  const claims = claimsOf(payload)
  if (!claims) throw new SessionTurnGrantError("session_turn_grant_invalid", "Deferred turn grant claims are invalid")
  const shape = grantShape(claims)
  if (shape) throw new SessionTurnGrantError("session_turn_grant_invalid", shape)
  if (claims.sessionId !== options.sessionId) {
    throw new SessionTurnGrantError("session_turn_grant_mismatch", "Deferred turn grant was minted for another session")
  }
  return claims
}

function claimsOf(payload: JWTPayload): DeferredTurnGrantClaims | undefined {
  const principalKind = payload.principal_kind
  const actorKind = payload.actor_kind
  const actorId = claimText(payload.actor_id)
  const grantId = claimText(payload.jti)
  const orgId = claimText(payload.org_id)
  const workspaceId = claimText(payload.workspace_id)
  const sessionId = claimText(payload.session_id)
  const intent = payload.intent
  const subjectSessionId = optionalClaimText(payload.subject_session_id)
  const turnId = optionalClaimText(payload.turn_id)
  const turnIdPrefix = optionalClaimText(payload.turn_id_prefix)
  if (
    !actorId || !grantId || !orgId || !workspaceId || !sessionId
    || (intent !== "child_completion" && intent !== "queued_prompt")
    || subjectSessionId === null || turnId === null || turnIdPrefix === null
    || payload.iat === undefined || payload.exp === undefined
  ) return undefined
  let principal: PrivateSessionRuntimePrincipal
  if (principalKind === "user" && actorKind === "human") principal = { principalKind, actorId, actorKind }
  else if (principalKind === "service" && actorKind === "agent") principal = { principalKind, actorId, actorKind }
  else return undefined
  return {
    ...principal,
    grantId,
    orgId,
    workspaceId,
    sessionId,
    intent,
    ...(subjectSessionId === undefined ? {} : { subjectSessionId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(turnIdPrefix === undefined ? {} : { turnIdPrefix }),
    issuedAt: payload.iat * 1_000,
    expiresAt: payload.exp * 1_000,
  }
}

/** Why the intent-specific fields do not describe one grant, or `undefined` when they do. */
function grantShape(claims: DeferredTurnGrantInput): string | undefined {
  if (claims.intent === "queued_prompt") {
    if (claims.turnId === undefined || claims.subjectSessionId !== undefined || claims.turnIdPrefix !== undefined) {
      return "A queued-prompt grant fixes exactly one turn id and names no child"
    }
    return undefined
  }
  if (claims.subjectSessionId === undefined || claims.turnId !== undefined
    || claims.turnIdPrefix !== childCompletionTurnIdPrefix(claims.subjectSessionId)) {
    return "A child-completion grant names its child and that child's wake turn-id prefix"
  }
  return undefined
}

function claimText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** `null` for a claim that is present but not usable text; `undefined` for an absent one. */
function optionalClaimText(value: unknown) {
  if (value === undefined) return undefined
  return claimText(value) ?? null
}
