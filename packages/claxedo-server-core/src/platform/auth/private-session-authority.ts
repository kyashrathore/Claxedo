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

export type AdoptRuntimePrivateSessionInput = PrivateSessionRuntimePrincipal & {
  sessionId: string
  workspaceId: string
  /** The machine the caller reached the session through; names the enrollment whose owner may adopt. */
  hostId: string
  title?: string
}

/**
 * An adoption's registration operation, derived from the session it claims so
 * that two concurrent first reads of the same session contend for one row
 * instead of minting two operations for one id.
 */
export function sessionAdoptionOperationId(sessionId: string) {
  return `session_adoption_${sessionId}`
}

export const SESSION_ADOPTION_OPERATION_PREFIX = "session_adoption_"

export type TransitionPrivateSessionRegistrationInput = PrivateSessionRuntimePrincipal & {
  operationId: string
  sessionId: string
  workspaceId: string
  reason: string
}

/**
 * What a session write is: driving the agent's turn, or controlling the
 * session and the machine through it. A `send` share carries the first and
 * never the second, so the level cannot answer a write on its own.
 */
export type SessionWriteClass = "agent_turn" | "session_control"

/** Startup control only: proves a live reservation without granting session access. */
export type AuthorizeRuntimeSessionStartInput = PrivateSessionRuntimePrincipal & {
  sessionId: string
  workspaceId: string
  registrationOperationId: string
}

export type AuthorizeRuntimePrivateSessionInput = PrivateSessionRuntimePrincipal & {
  sessionId: string
  workspaceId: string
  action: "read" | "write"
  /** Absent asks about a turn: what a caller that does not distinguish the two is doing. */
  writeClass?: SessionWriteClass
}

/** What an adapter is being asked about a session, read off the port's input. */
export type SessionAccessQuestion = "read" | SessionWriteClass

export function sessionAccessQuestion(
  input: { action: "read" | "write"; writeClass?: SessionWriteClass },
): SessionAccessQuestion {
  return input.action === "read" ? "read" : input.writeClass ?? "agent_turn"
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

export type PrivateSessionInventoryRow = {
  session_id: string
  workspace_id?: string
  [field: string]: unknown
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
  role?: "viewer" | "editor" | "admin" | "owner"
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
/**
 * The principal/actor pairing a Relay Host Token asserts.
 *
 * A user principal always acts as a human and a service always as an agent;
 * the pairing is the discriminant, so choosing the union member here is what
 * makes the proof below well-typed instead of asserted into shape.
 */
type RuntimePrincipalKinds =
  | { principalKind: "user"; actorKind: "human" }
  | { principalKind: "service"; actorKind: "agent" }

function runtimePrincipalKinds(principalKind: unknown, actorKind: unknown): RuntimePrincipalKinds {
  if (principalKind === "user" && actorKind === "human") return { principalKind, actorKind }
  if (principalKind === "service" && actorKind === "agent") return { principalKind, actorKind }
  throw new TypeError("Relay Host Token principal and actor kinds are inconsistent")
}

export function privateSessionRuntimeProof(claims: RelayHostPrivateSessionClaims): PrivateSessionRuntimeProof {
  const kinds = runtimePrincipalKinds(claims.principal_kind, claims.actor_kind)
  const actorId = requiredClaim(claims.actor_id, "actor_id")
  const orgId = requiredClaim(claims.org_id, "org_id")
  const workspaceId = requiredClaim(claims.workspace_id, "workspace_id")
  const hostId = requiredClaim(claims.host_id, "host_id")
  const relayHostTokenJti = requiredClaim(claims.jti, "jti")
  const parentRuntimeAccessTokenJti = requiredClaim(claims.parent_jti, "parent_jti")
  return {
    ...kinds,
    actorId,
    orgId,
    workspaceId,
    hostId,
    relayHostTokenJti,
    parentRuntimeAccessTokenJti,
  }
}

/**
 * Provider-neutral private-session authority. The lifecycle protocol is one
 * state machine: an ambiguous create is reconciled by retrying the same exact
 * registration; definitive denial enters compensation and can never register.
 *
 * A completed compensation releases the session id and the operation id it
 * held, so a caller that derives both from a request it repeats can start
 * over. A compensation that has only begun keeps holding them, because the
 * session it undoes may still exist.
 */
export type PrivateSessionAuthority = {
  /** Internal runtime principal, already authenticated by the host; never a public HTTP admission. */
  reserveRuntimeSession: (principal: PrivateSessionRuntimePrincipal, input: ReservePrivateSessionInput) => Promise<PrivateSessionRegistrationResult>

  reserveSession: (
    auth: SignedControlPlaneAuth,
    input: ReservePrivateSessionInput,
  ) => Promise<PrivateSessionRegistrationResult>
  registerRuntimeSession: (input: RegisterRuntimePrivateSessionInput) => Promise<unknown>
  /**
   * Registers a session the host already holds and the plane has no row for,
   * under the owner of the enrollment that serves the workspace on this host.
   *
   * Outside the reserve/register machine's guarantee: nothing reserved the id
   * before the transcript existed, so the id is the host's and the plane can
   * only refuse or accept it whole. The authority is therefore the one that
   * names the creator — the caller cannot — and it admits only that same owner,
   * so no member turns another person's local transcript into their own.
   */
  adoptRuntimeSession: (input: AdoptRuntimePrivateSessionInput) => Promise<{ adopted: boolean }>
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
  /** Reads only the creator-owned registration outcome, including terminal states. */
  authorizeRuntimeSessionStartStatus: (input: AuthorizeRuntimeSessionStartInput) => Promise<void>
  authorizeRuntimeSessionStart: (input: AuthorizeRuntimeSessionStartInput) => Promise<void>
  authorizeRuntimeSession: (input: AuthorizeRuntimePrivateSessionInput) => Promise<void>

  grantSessionParticipant: (
    auth: SignedControlPlaneAuth,
    input: PrivateSessionParticipantInput,
  ) => Promise<{ participant_id: string }>
  revokeSessionParticipant: (
    auth: SignedControlPlaneAuth,
    input: PrivateSessionParticipantInput,
  ) => Promise<{ removed: boolean }>

  listSessions: (
    auth: SignedControlPlaneAuth,
    input: { workspaceId: string },
  ) => Promise<PrivateSessionInventoryRow[]>
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
      fencingToken?: number
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
  "reserveRuntimeSession",
  "registerRuntimeSession",
  "adoptRuntimeSession",
  "markSessionRegistrationAmbiguous",
  "beginSessionCompensation",
  "completeSessionCompensation",
  "authorizeSessionRead",
  "authorizeSessionWrite",
  "authorizeRuntimeSession",
  "authorizeRuntimeSessionStart",
  "authorizeRuntimeSessionStartStatus",
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
