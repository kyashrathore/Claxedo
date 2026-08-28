import type { SignedControlPlaneAuth } from "./auth"

/** Canonical application actor identity. Provider subjects never cross this port. */
export type PrivateSessionActor = {
  actorId: string
  actorKind: "human" | "agent"
}

/**
 * Runtime principals are explicit and discriminated. A provider token subject
 * is neither an actor id nor a substitute for `principalKind`.
 */
export type PrivateSessionRuntimePrincipal =
  | { principalKind: "user"; actorId: string; actorKind: "human" }
  | { principalKind: "service"; actorId: string; actorKind: "agent" }

/** Display metadata is optional presentation data, never session authority. */
export type PrivateSessionDisplayAuthor = {
  id: string
  kind: "human" | "agent"
  publicId?: string
  name?: string
  avatarUrl?: string
}

export type PrivateSessionRegistrationState =
  "reserved" | "registered" | "reconciliation_required" | "compensation_pending" | "compensated"

export type ReservePrivateSessionInput = {
  operationId: string
  sessionId: string
  workspaceId: string
  kind: "create" | "fork"
  parentSessionId?: string
  title?: string
}

export type PrivateSessionRegistrationResult = {
  changed: boolean
  operationId: string
  sessionId: string
  workspaceId: string
  state: PrivateSessionRegistrationState
}

export type RegisterRuntimePrivateSessionInput = PrivateSessionRuntimePrincipal & {
  operationId: string
  sessionId: string
  workspaceId: string
  title?: string
}

export type TransitionPrivateSessionRegistrationInput = PrivateSessionRuntimePrincipal & {
  operationId: string
  sessionId: string
  workspaceId: string
  reason: string
}

export type AuthorizeRuntimePrivateSessionInput = PrivateSessionRuntimePrincipal & {
  sessionId: string
  workspaceId: string
  action: "read" | "write"
}

export type PrivateSessionParticipantInput = {
  sessionId: string
  workspaceId: string
  participantActorId: string
}

export type PrivateSessionVisibility = {
  sessionId: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

/**
 * Signed RHT claims needed by a future runtime-session oracle.
 *
 * `jti` identifies the short-lived RHT. `parent_jti` identifies the Runtime
 * Access Token from which the relay derived it; renewal and revocation checks
 * must use the parent, not the short-lived child. These claims deliberately do
 * not carry an authentication-provider subject.
 */
export type RelayHostPrivateSessionClaims = {
  principal_kind: "user" | "service"
  actor_id: string
  actor_kind: "human" | "agent"
  org_id: string
  workspace_id: string
  host_id: string
  jti: string
  parent_jti: string
}

export type PrivateSessionRuntimeProof = PrivateSessionRuntimePrincipal & {
  orgId: string
  workspaceId: string
  hostId: string
  relayHostTokenJti: string
  parentRuntimeAccessTokenJti: string
}

/**
 * Normalize already-verified RHT claims for the authority boundary. Signature,
 * issuer, audience, and expiry verification remain the token verifier's job.
 */
export function privateSessionRuntimeProof(claims: RelayHostPrivateSessionClaims): PrivateSessionRuntimeProof {
  const principalKind = claims.principal_kind
  const actorKind = claims.actor_kind
  if (
    (principalKind !== "user" && principalKind !== "service") ||
    (actorKind !== "human" && actorKind !== "agent") ||
    (principalKind === "user" && actorKind !== "human") ||
    (principalKind === "service" && actorKind !== "agent")
  )
    throw new TypeError("Relay Host Token principal and actor kinds are inconsistent")

  const actorId = requiredClaim(claims.actor_id, "actor_id")
  const orgId = requiredClaim(claims.org_id, "org_id")
  const workspaceId = requiredClaim(claims.workspace_id, "workspace_id")
  const hostId = requiredClaim(claims.host_id, "host_id")
  const relayHostTokenJti = requiredClaim(claims.jti, "jti")
  const parentRuntimeAccessTokenJti = requiredClaim(claims.parent_jti, "parent_jti")
  return {
    principalKind,
    actorId,
    actorKind,
    orgId,
    workspaceId,
    hostId,
    relayHostTokenJti,
    parentRuntimeAccessTokenJti,
  } as PrivateSessionRuntimeProof
}

/**
 * Provider-neutral private-session authority. The lifecycle protocol is one
 * state machine: an ambiguous create is reconciled by retrying the same exact
 * registration; definitive denial enters compensation and can never register.
 */
export type PrivateSessionAuthority = {
  reserveSession: (
    auth: SignedControlPlaneAuth,
    input: ReservePrivateSessionInput,
  ) => Promise<PrivateSessionRegistrationResult>
  registerRuntimeSession: (input: RegisterRuntimePrivateSessionInput) => Promise<unknown>
  markSessionRegistrationAmbiguous: (
    input: TransitionPrivateSessionRegistrationInput,
  ) => Promise<PrivateSessionRegistrationResult>
  beginSessionCompensation: (
    input: TransitionPrivateSessionRegistrationInput,
  ) => Promise<PrivateSessionRegistrationResult>
  completeSessionCompensation: (
    input: TransitionPrivateSessionRegistrationInput,
  ) => Promise<PrivateSessionRegistrationResult>

  authorizeSessionRead: (
    auth: SignedControlPlaneAuth,
    input: { sessionId: string; workspaceId: string },
  ) => Promise<void>
  authorizeSessionWrite: (
    auth: SignedControlPlaneAuth,
    input: { sessionId: string; workspaceId: string },
  ) => Promise<void>
  authorizeRuntimeSession: (input: AuthorizeRuntimePrivateSessionInput) => Promise<void>

  grantSessionParticipant: (
    auth: SignedControlPlaneAuth,
    input: PrivateSessionParticipantInput,
  ) => Promise<{ participant_id: string }>
  revokeSessionParticipant: (
    auth: SignedControlPlaneAuth,
    input: PrivateSessionParticipantInput,
  ) => Promise<{ removed: boolean }>

  listSessions: (auth: SignedControlPlaneAuth, input: { workspaceId: string }) => Promise<unknown>
  resolveSession: (auth: SignedControlPlaneAuth, input: { sessionId: string }) => Promise<unknown>
  readSessionMessages: (
    auth: SignedControlPlaneAuth,
    input: { sessionId: string; workspaceId: string; limit?: number; before?: string },
  ) => Promise<unknown>
  syncSessionMessages: (
    auth: SignedControlPlaneAuth,
    input: {
      sessionId: string
      workspaceId: string
      messages: unknown[]
      intakeReady?: boolean
      maxEventOrdinal?: number
    },
  ) => Promise<unknown>
  upsertSessionVisibility: (
    auth: SignedControlPlaneAuth,
    input: { workspaceId: string; sessions: PrivateSessionVisibility[] },
  ) => Promise<unknown>
  replaceSessionVisibility: (
    auth: SignedControlPlaneAuth,
    input: { workspaceId: string; sessions: PrivateSessionVisibility[] },
  ) => Promise<unknown>
  deleteSessionVisibility: (
    auth: SignedControlPlaneAuth,
    input: { sessionId: string; workspaceId: string },
  ) => Promise<unknown>
}

export const PRIVATE_SESSION_AUTHORITY_METHODS = [
  "reserveSession",
  "registerRuntimeSession",
  "markSessionRegistrationAmbiguous",
  "beginSessionCompensation",
  "completeSessionCompensation",
  "authorizeSessionRead",
  "authorizeSessionWrite",
  "authorizeRuntimeSession",
  "grantSessionParticipant",
  "revokeSessionParticipant",
  "listSessions",
  "resolveSession",
  "readSessionMessages",
  "syncSessionMessages",
  "upsertSessionVisibility",
  "replaceSessionVisibility",
  "deleteSessionVisibility",
] as const satisfies readonly (keyof PrivateSessionAuthority)[]

type MissingPrivateSessionMethod = Exclude<
  keyof PrivateSessionAuthority,
  (typeof PRIVATE_SESSION_AUTHORITY_METHODS)[number]
>
type UnknownPrivateSessionMethod = Exclude<
  (typeof PRIVATE_SESSION_AUTHORITY_METHODS)[number],
  keyof PrivateSessionAuthority
>
const PRIVATE_SESSION_METHOD_INVENTORY_IS_EXACT: [MissingPrivateSessionMethod, UnknownPrivateSessionMethod] extends [
  never,
  never,
]
  ? true
  : never = true
void PRIVATE_SESSION_METHOD_INVENTORY_IS_EXACT

function requiredClaim(value: string, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Relay Host Token ${name} claim is required`)
  }
  return value.trim()
}
