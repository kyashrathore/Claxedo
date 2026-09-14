import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessDecision,
  type SessionAccessPolicyInput,
  type SessionAuthorityInput,
  type SessionReservationDecision,
  type SessionTurnLeaseDecision,
  sessionAccessRequiresWrite,
} from "./session-access-policy"
import { bool, num, rec, str } from "./json-value"

export const WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL = "WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL"

type AuthorityAction =
  | "read"
  | "write"
  | "reserve"
  | "register"
  | "registration_ambiguous"
  | "compensation_begin"
  | "compensation_complete"
  | "turn_acquire"
  | "turn_renew"
  | "turn_release"
type HostAuthorityAction = "host_read" | "host_admin"
export function remoteWorkspaceSessionAccessPolicy(
  options: {
    url?: string
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    timeoutMs?: number
  } = {},
) {
  /**
   * POST one authority action and let `decode` name its SUCCESS shape.
   *
   * Every failure — no URL, a missing turn id, a transport error, a non-2xx
   * response, an unreadable success body — is an `AuthorityDenial`, and that is
   * a member of all four decision types the policy hooks return. Only the
   * success shape varies by action, so the caller supplies the decoder for it
   * and the return type comes out exact. Previously one function returned the
   * union of all four and nine call sites asserted their way back out of it.
   */
  const request = async <T>(
    input: AuthorityRequestInput,
    action: AuthorityAction,
    decode: (body: Record<string, unknown> | undefined) => T | AuthorityDenial,
    requestOptions?: AuthorityRequestOptions,
  ): Promise<T | AuthorityDenial> => {
    const url = options.url?.trim()
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
  const authorize = (input: SessionAuthorityInput) =>
    request(input, sessionAccessRequiresWrite(input) ? "write" : "read", decodeAllowed)
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: true,
    authority: {
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
    const url = options.url?.trim()
    if (!url || !input.credential) return denied(503, "session_authority_unavailable")
    const action: HostAuthorityAction =
      input.minimumRole === "admin" || input.minimumRole === "owner" ? "host_admin" : "host_read"
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: { authorization: input.credential, "content-type": "application/json" },
        body: JSON.stringify({ action }),
        signal: input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal,
      })
      if (response.ok) return { allowed: true }
      const error = rec((await jsonBody(response))?.error)
      const status = response.status === 401 ? 401 : response.status === 503 ? 503 : 403
      return denied(status, str(error?.code) ?? "host_authority_denied", str(error?.message))
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
 * on purpose — the registration hooks carry no `actor`, and typing the request
 * as if they did is what forced three `as SessionAuthorityInput` casts.
 */
type AuthorityRequestInput = SessionAccessPolicyInput & { sessionId: string }

type AuthorityRequestOptions = {
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

/** Map a non-2xx authority response onto the refusal the caller should see. */
function deniedFromResponse(response: Response, body: Record<string, unknown> | undefined): AuthorityDenial {
  const error = rec(body?.error)
  const status = response.status === 401 ? 401 : response.status === 409 ? 409 : response.status === 503 ? 503 : 403
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
    ...(isRegistrationAction(action) ? { operationId: input.registrationOperationId } : {}),
    ...(requestOptions?.stream
      ? { stream: true, ...(requestOptions.lease ? { lease: requestOptions.lease } : {}) }
      : {}),
    ...(requestOptions?.reason ? { reason: requestOptions.reason } : {}),
    ...(requestOptions?.parentSessionId ? { parentSessionId: requestOptions.parentSessionId } : {}),
    ...((action === "register" || action === "reserve") && input.sessionTitle ? { title: input.sessionTitle } : {}),
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
        : "Session access requires current creator, participant, or organization administrator authority"),
  }
}
