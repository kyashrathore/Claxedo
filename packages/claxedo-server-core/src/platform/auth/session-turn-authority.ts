import type { PrivateSessionRuntimePrincipal } from "./private-session-authority"

/**
 * A durable prompt admission owned by the selected application store.
 *
 * `turnId` is the caller's stable user-message id. `leaseId` is an
 * unguessable ownership secret, while `fencingToken` is a monotonic generation
 * that authoritative event/message producers can persist to reject output
 * from an expired execution after a replacement turn has been admitted.
 */
export type SessionTurnLease = {
  sessionId: string
  workspaceId: string
  turnId: string
  leaseId: string
  fencingToken: number
  acquiredAt: number
  expiresAt: number
}

export type AcquireSessionTurnInput = PrivateSessionRuntimePrincipal & {
  sessionId: string
  workspaceId: string
  turnId: string
  /** Redeems a deferred grant in place of the credential the turn no longer holds. */
  grantId?: string
}

export type OwnedSessionTurnInput = AcquireSessionTurnInput & {
  leaseId: string
  fencingToken: number
}

export type ReleaseSessionTurnResult = {
  released: boolean
  sessionId: string
  turnId: string
  fencingToken: number
}

export type SessionTurnGrantIntent = "child_completion" | "queued_prompt"

export type GrantSessionTurnInput = PrivateSessionRuntimePrincipal & {
  sessionId: string
  workspaceId: string
  intent: SessionTurnGrantIntent
  /** `child_completion`: the child whose completion wakes `sessionId`. */
  subjectSessionId?: string
  /** `child_completion`: the child's registration, which must name `sessionId` as parent and the actor as creator. */
  registrationOperationId?: string
  /** `queued_prompt`: the message id fixed at queue time. */
  turnId?: string
  ttlMs?: number
}

/**
 * A single-use admission minted while a live credential proved `agent_turn`
 * on the session, redeemable by the same actor until `expiresAt`. Exactly one
 * of `turnId` and `turnIdPrefix` is set: a queued prompt knows its message id,
 * a child-completion wake knows only the `msg_wake_<child>_` shape of it.
 */
export type SessionTurnGrant = {
  grantId: string
  sessionId: string
  workspaceId: string
  actorId: string
  intent: SessionTurnGrantIntent
  subjectSessionId?: string
  turnId?: string
  turnIdPrefix?: string
  issuedAt: number
  expiresAt: number
  redeemedAt?: number
  redeemedTurnId?: string
  revokedAt?: number
}

export type RevokeSessionTurnGrantsInput = {
  sessionId?: string
  subjectSessionId?: string
  reason: string
}

export type RevokeSessionTurnGrantsResult = {
  revoked: number
}

export const SESSION_TURN_GRANT_DEFAULT_TTL_MS = 24 * 60 * 60_000
export const SESSION_TURN_GRANT_MIN_TTL_MS = 5 * 60_000
export const SESSION_TURN_GRANT_MAX_TTL_MS = 7 * 24 * 60 * 60_000

export function sessionTurnGrantTtl(ttlMs: number | undefined) {
  const ttl = ttlMs ?? SESSION_TURN_GRANT_DEFAULT_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < SESSION_TURN_GRANT_MIN_TTL_MS || ttl > SESSION_TURN_GRANT_MAX_TTL_MS) {
    throw new SessionTurnGrantError(
      "session_turn_grant_invalid",
      `ttlMs must be an integer between ${SESSION_TURN_GRANT_MIN_TTL_MS} and ${SESSION_TURN_GRANT_MAX_TTL_MS}`,
    )
  }
  return ttl
}

export function childCompletionTurnIdPrefix(childSessionId: string) {
  return `msg_wake_${childSessionId}_`
}

export type NormalizedGrantSessionTurnInput = {
  intent: SessionTurnGrantIntent
  ttlMs: number
  subjectSessionId?: string
  registrationOperationId?: string
  turnId?: string
  turnIdPrefix?: string
}

/** The intent-specific fields a grant row needs, refused as `session_turn_grant_invalid` when the intent's own field is missing. */
export function normalizeGrantSessionTurnInput(
  input: Pick<GrantSessionTurnInput, "intent" | "subjectSessionId" | "registrationOperationId" | "turnId" | "ttlMs">,
): NormalizedGrantSessionTurnInput {
  const intent = input.intent
  if (intent !== "child_completion" && intent !== "queued_prompt") {
    throw new SessionTurnGrantError("session_turn_grant_invalid", "intent must be child_completion or queued_prompt")
  }
  const ttlMs = sessionTurnGrantTtl(input.ttlMs)
  if (intent === "queued_prompt") return { intent, ttlMs, turnId: requiredGrantField(input.turnId, "turnId") }
  const subjectSessionId = requiredGrantField(input.subjectSessionId, "subjectSessionId")
  return {
    intent,
    ttlMs,
    subjectSessionId,
    registrationOperationId: requiredGrantField(input.registrationOperationId, "registrationOperationId"),
    turnIdPrefix: childCompletionTurnIdPrefix(subjectSessionId),
  }
}

function requiredGrantField(value: string | undefined, name: string) {
  const text = value?.trim()
  if (!text || text.length > 512) {
    throw new SessionTurnGrantError("session_turn_grant_invalid", `${name} is required for this grant intent`)
  }
  return text
}

export type SessionTurnGrantErrorCode =
  | "session_turn_grant_expired"
  | "session_turn_grant_redeemed"
  | "session_turn_grant_revoked"
  | "session_turn_grant_mismatch"
  | "session_turn_grant_invalid"

export class SessionTurnGrantError extends Error {
  constructor(
    readonly code: SessionTurnGrantErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "SessionTurnGrantError"
  }
}

/**
 * Why `grant` cannot admit `turnId` for this actor now, or `undefined` when it
 * can. A grant already redeemed for this exact turn still admits it while
 * that lease is live, so an admitted turn's own retry sees its lease rather
 * than a refusal; once the lease is released nothing else redeems the grant.
 *
 * Both stores answer the same question: SQLite asks it before writing inside
 * its transaction, D1 encodes the same predicate in its guarded batch and asks
 * this only to name the refusal after the batch was rejected.
 */
export function sessionTurnGrantRefusal(
  grant: SessionTurnGrant | undefined,
  input: { actorId: string; sessionId: string; workspaceId: string; turnId: string; now: number },
  liveLease: { turnId: string; actorId: string } | undefined,
): SessionTurnGrantError | undefined {
  if (!grant) return new SessionTurnGrantError("session_turn_grant_invalid", "Session turn grant does not exist")
  if (grant.actorId !== input.actorId || grant.sessionId !== input.sessionId || grant.workspaceId !== input.workspaceId) {
    return new SessionTurnGrantError("session_turn_grant_mismatch", "Session turn grant was minted for another actor or session")
  }
  if (grant.revokedAt !== undefined) {
    return new SessionTurnGrantError("session_turn_grant_revoked", "Session turn grant was revoked")
  }
  if (grant.expiresAt <= input.now) {
    return new SessionTurnGrantError("session_turn_grant_expired", "Session turn grant has expired")
  }
  if (grant.redeemedAt !== undefined) {
    const retrying = grant.redeemedTurnId === input.turnId
      && liveLease?.turnId === input.turnId
      && liveLease.actorId === input.actorId
    if (!retrying) return new SessionTurnGrantError("session_turn_grant_redeemed", "Session turn grant was already redeemed")
    return undefined
  }
  const turnMatches = grant.turnId !== undefined
    ? grant.turnId === input.turnId
    : grant.turnIdPrefix !== undefined && input.turnId.startsWith(grant.turnIdPrefix)
  if (!turnMatches) {
    return new SessionTurnGrantError("session_turn_grant_mismatch", "Session turn grant does not cover this turn id")
  }
  return undefined
}

export class SessionTurnConflictError extends Error {
  readonly code = "session_turn_in_progress"

  constructor(
    readonly sessionId: string,
    readonly activeUntil?: number,
  ) {
    super(`Session ${sessionId} is already processing a turn`)
    this.name = "SessionTurnConflictError"
  }
}

export class SessionTurnLeaseLostError extends Error {
  readonly code = "session_turn_lease_lost"

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} turn lease is no longer owned by this execution`)
    this.name = "SessionTurnLeaseLostError"
  }
}

/**
 * Provider-neutral durable runtime coordination. This is intentionally a peer
 * of `PrivateSessionAuthority`: session visibility stays in that port, while
 * exactly-one prompt admission and its fencing generation stay here.
 */
export type SessionTurnAuthority = {
  acquireSessionTurn(input: AcquireSessionTurnInput): Promise<SessionTurnLease>
  renewSessionTurn(input: OwnedSessionTurnInput): Promise<SessionTurnLease>
  releaseSessionTurn(input: OwnedSessionTurnInput): Promise<ReleaseSessionTurnResult>
  /** Requires `agent_turn` on `sessionId` at mint time; `acquireSessionTurn` requires it again at redemption. */
  grantSessionTurn(input: GrantSessionTurnInput): Promise<SessionTurnGrant>
  revokeSessionTurnGrants(input: RevokeSessionTurnGrantsInput): Promise<RevokeSessionTurnGrantsResult>
}

export const SESSION_TURN_AUTHORITY_METHODS = [
  "acquireSessionTurn",
  "renewSessionTurn",
  "releaseSessionTurn",
  "grantSessionTurn",
  "revokeSessionTurnGrants",
] as const satisfies readonly (keyof SessionTurnAuthority)[]

type MissingSessionTurnMethod = Exclude<
  keyof SessionTurnAuthority,
  (typeof SESSION_TURN_AUTHORITY_METHODS)[number]
>
type UnknownSessionTurnMethod = Exclude<
  (typeof SESSION_TURN_AUTHORITY_METHODS)[number],
  keyof SessionTurnAuthority
>
const SESSION_TURN_METHOD_INVENTORY_IS_EXACT: [MissingSessionTurnMethod, UnknownSessionTurnMethod] extends [
  never,
  never,
]
  ? true
  : never = true
void SESSION_TURN_METHOD_INVENTORY_IS_EXACT
