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
}

export const SESSION_TURN_AUTHORITY_METHODS = [
  "acquireSessionTurn",
  "renewSessionTurn",
  "releaseSessionTurn",
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

