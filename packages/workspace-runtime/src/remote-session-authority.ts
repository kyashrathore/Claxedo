import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessDecision,
  type SessionAccessPolicyInput,
  type SessionAuthorityInput,
  type SessionReservationDecision,
  type SessionTurnLeaseDecision,
  type SessionWriteClass,
  sessionAccessRequiresWrite,
  sessionAccessWriteClass,
} from "./session-access-policy"
import { bool, num, rec, str } from "./json-value"

export const WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL = "WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL"

type AuthorityAction =
  | "read"
  | "write"
  | "reserve"
  | "start_status"
  | "start"
  | "register"
  | "adopt"
  | "registration_ambiguous"
  | "compensation_begin"
  | "compensation_complete"
  | "turn_acquire"
  | "turn_renew"
  | "turn_release"
type HostAuthorityAction = "host_read" | "host_admin"

/**
 * Consulted when the authority refuses a session, before that refusal is
 * returned, so a host may claim a session the plane has no row for.
 *
 * `adopt` and `reauthorize` are separate calls because an adoption may be
 * shared between callers while an authorization may not: whoever ends up
 * admitted must be admitted by a decision the authority made about THEM, not
 * by one it made about whoever adopted first. Either answer carries its own
 * call's status, so 503 is the authority being away and 401/403/409 is its
 * verdict.
 */
export type AdoptRefusedSession = (
  input: SessionAuthorityInput,
  refusal: {
    denial: Exclude<SessionAccessDecision, { allowed: true }>
    adopt: () => Promise<SessionAccessDecision>
    reauthorize: () => Promise<SessionAccessDecision>
  },
) => Promise<SessionAccessDecision>

export function remoteWorkspaceSessionAccessPolicy(
  options: {
    /**
     * A function where the address arrives after composition: a desktop daemon
     * is handed the control plane's authority endpoint by a heartbeat ack, and
     * its runtimes are composed before the first beat.
     */
    url?: string | (() => string | undefined)
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    timeoutMs?: number
    /**
     * False where the host has a local owner: an unstamped request is that
     * machine's own user on loopback, not an unidentified caller. Every
     * relay-replayed request carries a verified actor regardless, because the
     * ingress that stamps it rejects the ones it cannot verify.
     */
    requireActor?: boolean
    adoptRefusedSession?: AdoptRefusedSession
  } = {},
) {
  const authorityUrl = () => (typeof options.url === "function" ? options.url() : options.url)?.trim()
  /**
   * POST one authority action and let `decode` name its SUCCESS shape.
   *
   * Every failure — no URL, a missing turn id, a transport error, a non-2xx
   * response, an unreadable success body — is an `AuthorityDenial`, and that is
   * a member of all four decision types the policy hooks return. Only the
   * success shape varies by action, so the caller supplies the decoder for it
   * and the return type comes out exact instead of a union of all four.
   */
  const request = async <T>(
    input: AuthorityRequestInput,
    action: AuthorityAction,
    decode: (body: Record<string, unknown> | undefined) => T | AuthorityDenial,
    requestOptions?: AuthorityRequestOptions,
  ): Promise<T | AuthorityDenial> => {
    const url = authorityUrl()
    if (!url || (!input.credential && !requestOptions?.lease && !requestOptions?.leaseId)) {
      return denied(503, "session_authority_unavailable")
    }
    if (isRegistrationAction(action) && !input.registrationOperationId) {
      return denied(503, "session_registration_operation_required")
    }
    if (isTurnAction(action) && !requestOptions?.turnId) return denied(503, "session_turn_id_required")
    if (
      (action === "turn_renew" || action === "turn_release") &&
      (!requestOptions?.leaseId || !positiveInteger(requestOptions.fencingToken))
    )
      return denied(503, "session_turn_lease_required")
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: {
          ...(input.credential && action !== "turn_renew" && action !== "turn_release"
            ? { authorization: input.credential }
            : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(authorityRequestBody(input, action, requestOptions)),
        signal: input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal,
      })
      if (!response.ok) return deniedFromResponse(response, await jsonBody(response))
      return decode(await jsonBody(response))
    } catch {
      return denied(503, "session_authority_unavailable")
    }
  }
  const authorize = async (input: SessionAuthorityInput): Promise<SessionAccessDecision> => {
    const writeClass = sessionAccessWriteClass(input)
    const action = writeClass ? "write" : "read"
    const classified = writeClass ? { writeClass } : undefined
    const decision = await request(input, action, decodeAllowed, classified)
    const adoptRefused = options.adoptRefusedSession
    if (decision.allowed || !adoptRefused) return decision
    return adoptRefused(input, {
      denial: decision,
      adopt: () => request(input, "adopt", decodeAllowed),
      reauthorize: () => request(input, action, decodeAllowed, classified),
    })
  }
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: options.requireActor ?? true,
    authority: {
      authorizeSessionStartStatus: (input) => request(input, "start_status", decodeAllowed),
      authorizeSessionStart: (input) => request(input, "start", decodeAllowed),
      authorizeSessionRead: authorize,
      authorizeSessionWrite: authorize,
      authorizeSessionStream: (input, lease) =>
        request(input, sessionAccessRequiresWrite(input) ? "write" : "read", decodeStreamLease, {
          stream: true,
          ...(lease ? { lease } : {}),
        }),
      registerSession: (input) => request(input, "register", decodeAllowed),
      acquireTurn: (input) => request(input, "turn_acquire", decodeTurnLease, { turnId: input.turnId }),
      renewTurn: (input) =>
        request(input, "turn_renew", decodeTurnLease, {
          turnId: input.turnId,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
        }),
      releaseTurn: (input) =>
        request(input, "turn_release", decodeTurnRelease, {
          turnId: input.turnId,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
        }),
    },
  })
  policy.authorizeHost = async (input) => {
    const url = authorityUrl()
    if (!url || (!input.credential && !input.lease)) return denied(503, "session_authority_unavailable")
    const action: HostAuthorityAction =
      input.minimumRole === "admin" || input.minimumRole === "owner" ? "host_admin" : "host_read"
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: {
          ...(input.credential && !input.lease ? { authorization: input.credential } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, ...(input.lease ? { lease: input.lease } : {}) }),
        signal: input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal,
      })
      if (response.ok) {
        const body = await jsonBody(response)
        const lease = str(body?.lease)
        const expiresAt = typeof body?.expiresAt === "number" ? body.expiresAt : undefined
        return lease && expiresAt !== undefined ? { allowed: true, lease, expiresAt } : { allowed: true }
      }
      const error = rec((await jsonBody(response))?.error)
      // Only the authority's own refusal is a refusal; anything else it
      // answered — a fault, a missing route, a throttle — is the authority
      // being unavailable, and is not what sends a reader to the session arm.
      if (response.status === 401 || response.status === 403) {
        return denied(response.status, str(error?.code) ?? "host_authority_denied", str(error?.message))
      }
      return denied(503, str(error?.code) ?? "session_authority_unavailable", str(error?.message))
    } catch {
      return denied(503, "session_authority_unavailable")
    }
  }
  policy.reserveSession = (input) =>
    request(input, "reserve", decodeReservation, { parentSessionId: input.parentSessionId })
  policy.markRegistrationAmbiguous = (input) =>
    request(input, "registration_ambiguous", decodeAllowed, { reason: input.reason })
  policy.beginRegistrationCompensation = (input) =>
    request(input, "compensation_begin", decodeAllowed, { reason: input.reason })
  policy.completeRegistrationCompensation = (input) =>
    request(input, "compensation_complete", decodeAllowed, { reason: input.reason })
  return policy
}

/**
 * What a transport call actually reads: the session it is about plus the proof,
 * cancellation and registration fields. Narrower than `SessionAuthorityInput`
 * on purpose: the registration hooks carry no `actor`, so typing the request
 * with it would put a cast at each of them.
 */
type AuthorityRequestInput = SessionAccessPolicyInput & { sessionId: string }

type AuthorityRequestOptions = {
  writeClass?: SessionWriteClass
  lease?: string
  stream?: boolean
  reason?: string
  parentSessionId?: string
  turnId?: string
  leaseId?: string
  fencingToken?: number
}

/**
 * The refusal shape shared by every decision type: `SessionAccessDecision`,
 * `SessionAccessStreamDecision`, `SessionTurnLeaseDecision` and
 * `SessionTurnReleaseDecision` all include it verbatim.
 */
type AuthorityDenial = Exclude<SessionAccessDecision, { allowed: true }>

/** The authority's JSON body, or `undefined` when there is not a readable one. */
async function jsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
  return rec(await response.json().catch(() => undefined))
}

/** A plain grant: the action succeeded and carries no payload. */
function decodeAllowed(): { allowed: true } {
  return { allowed: true }
}

function decodeReservation(body: Record<string, unknown> | undefined): SessionReservationDecision {
  const operationId = str(body?.operationId)
  return operationId === undefined ? denied(503, "session_authority_invalid_response") : { allowed: true, operationId }
}

function decodeStreamLease(
  body: Record<string, unknown> | undefined,
): { allowed: true; lease: string; expiresAt: number } | AuthorityDenial {
  const lease = str(body?.lease)
  const expiresAt = num(body?.expiresAt)
  if (lease === undefined || expiresAt === undefined) return denied(503, "session_authority_invalid_response")
  return { allowed: true, lease, expiresAt }
}

function decodeTurnLease(
  body: Record<string, unknown> | undefined,
): Exclude<SessionTurnLeaseDecision, AuthorityDenial> | AuthorityDenial {
  const turnId = str(body?.turnId)
  const leaseId = str(body?.leaseId)
  const fencingToken = body?.fencingToken
  const acquiredAt = num(body?.acquiredAt)
  const expiresAt = num(body?.expiresAt)
  if (
    turnId === undefined || leaseId === undefined || !positiveInteger(fencingToken)
    || acquiredAt === undefined || expiresAt === undefined || expiresAt <= acquiredAt
  ) return denied(503, "session_authority_invalid_response")
  return { allowed: true, turnId, leaseId, fencingToken, acquiredAt, expiresAt }
}

function decodeTurnRelease(body: Record<string, unknown> | undefined): { released: boolean } | AuthorityDenial {
  const released = bool(body?.released)
  return released === undefined ? denied(503, "session_authority_invalid_response") : { released }
}

/**
 * Map a non-2xx authority response onto the refusal the caller should see.
 * Only the authority's own answers (401, 403, 409) are refusals; anything
 * else — a fault, a throttle, a missing route — is the authority being away,
 * which a lease outlives and a reader retries, never a refusal it acts on.
 */
function deniedFromResponse(response: Response, body: Record<string, unknown> | undefined): AuthorityDenial {
  const error = rec(body?.error)
  const status = response.status === 401 ? 401 : response.status === 403 ? 403 : response.status === 409 ? 409 : 503
  return denied(
    status,
    str(error?.code)
      ?? (status === 401
        ? "session_authority_proof_invalid"
        : status === 409
          ? "session_turn_in_progress"
          : status === 503
            ? "session_authority_unavailable"
            : "session_private"),
    str(error?.message),
  )
}

function authorityRequestBody(
  input: AuthorityRequestInput,
  action: AuthorityAction,
  requestOptions?: AuthorityRequestOptions,
) {
  return {
    sessionId: input.sessionId,
    action,
    ...(requestOptions?.writeClass ? { writeClass: requestOptions.writeClass } : {}),
    ...(isRegistrationAction(action) ? { operationId: input.registrationOperationId } : {}),
    ...(requestOptions?.stream
      ? { stream: true, ...(requestOptions.lease ? { lease: requestOptions.lease } : {}) }
      : {}),
    ...(requestOptions?.reason ? { reason: requestOptions.reason } : {}),
    ...(requestOptions?.parentSessionId ? { parentSessionId: requestOptions.parentSessionId } : {}),
    ...((action === "register" || action === "reserve" || action === "adopt") && input.sessionTitle
      ? { title: input.sessionTitle }
      : {}),
    ...(requestOptions?.turnId ? { turnId: requestOptions.turnId } : {}),
    ...(requestOptions?.leaseId ? { leaseId: requestOptions.leaseId } : {}),
    ...(requestOptions?.fencingToken !== undefined ? { fencingToken: requestOptions.fencingToken } : {}),
  }
}

export function remoteWorkspaceSessionAccessPolicyFromEnv(env: Record<string, string | undefined> = process.env) {
  return remoteWorkspaceSessionAccessPolicy({ url: env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL] })
}

function isRegistrationAction(action: string) {
  return (
    action === "start_status" ||
    action === "start" ||
    action === "register" ||
    action === "registration_ambiguous" ||
    action === "compensation_begin" ||
    action === "compensation_complete"
  )
}

function isTurnAction(action: string) {
  return action === "turn_acquire" || action === "turn_renew" || action === "turn_release"
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function denied(
  status: 401 | 403 | 409 | 503,
  code: string,
  message?: string,
): Exclude<SessionAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    status,
    code,
    message:
      message ??
      (status === 503
        ? "Session authority is temporarily unavailable"
        : "Session access requires creator, participant, or session share authority"),
  }
}
