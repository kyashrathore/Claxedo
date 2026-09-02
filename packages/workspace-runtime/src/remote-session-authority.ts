import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessDecision,
  type SessionAccessStreamDecision,
  type SessionAuthorityInput,
  type SessionTurnLeaseDecision,
  type SessionTurnReleaseDecision,
  sessionAccessRequiresWrite,
} from "./session-access-policy"

export const WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL = "WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL"

export function remoteWorkspaceSessionAccessPolicy(options: {
  url?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
} = {}) {
  type AuthorityAction =
    | "read" | "write" | "register"
    | "registration_ambiguous" | "compensation_begin" | "compensation_complete"
    | "turn_acquire" | "turn_renew" | "turn_release"
  type HostAuthorityAction = "host_read" | "host_admin"
  const request = async (
    input: SessionAuthorityInput,
    action: AuthorityAction,
    requestOptions?: {
      lease?: string
      stream?: boolean
      reason?: string
      turnId?: string
      leaseId?: string
      fencingToken?: number
    },
  ): Promise<
    SessionAccessDecision | SessionAccessStreamDecision | SessionTurnLeaseDecision | SessionTurnReleaseDecision
  > => {
    const url = options.url?.trim()
    if (!url || (!input.credential && !requestOptions?.lease && !requestOptions?.leaseId)) {
      return denied(503, "session_authority_unavailable")
    }
    if (isRegistrationAction(action) && !input.registrationOperationId) {
      return denied(503, "session_registration_operation_required")
    }
    if (isTurnAction(action) && !requestOptions?.turnId) return denied(503, "session_turn_id_required")
    if (
      (action === "turn_renew" || action === "turn_release")
      && (!requestOptions?.leaseId || !positiveInteger(requestOptions.fencingToken))
    ) return denied(503, "session_turn_lease_required")
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
        body: JSON.stringify({
          sessionId: input.sessionId,
          action,
          ...(isRegistrationAction(action) ? { operationId: input.registrationOperationId } : {}),
          ...(requestOptions?.stream
            ? { stream: true, ...(requestOptions.lease ? { lease: requestOptions.lease } : {}) }
            : {}),
          ...(requestOptions?.reason ? { reason: requestOptions.reason } : {}),
          ...(action === "register" && input.sessionTitle ? { title: input.sessionTitle } : {}),
          ...(requestOptions?.turnId ? { turnId: requestOptions.turnId } : {}),
          ...(requestOptions?.leaseId ? { leaseId: requestOptions.leaseId } : {}),
          ...(requestOptions?.fencingToken !== undefined ? { fencingToken: requestOptions.fencingToken } : {}),
        }),
        signal: input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal,
      })
      if (response.ok) {
        if (action === "turn_release") {
          const body = await response.json().catch(() => undefined) as { released?: unknown } | undefined
          return typeof body?.released === "boolean"
            ? { released: body.released }
            : denied(503, "session_authority_invalid_response")
        }
        if (action === "turn_acquire" || action === "turn_renew") {
          const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
          if (
            typeof body?.turnId !== "string"
            || typeof body.leaseId !== "string"
            || !positiveInteger(body.fencingToken)
            || typeof body.acquiredAt !== "number"
            || typeof body.expiresAt !== "number"
            || body.expiresAt <= body.acquiredAt
          ) return denied(503, "session_authority_invalid_response")
          return {
            allowed: true,
            turnId: body.turnId,
            leaseId: body.leaseId,
            fencingToken: body.fencingToken,
            acquiredAt: body.acquiredAt,
            expiresAt: body.expiresAt,
          }
        }
        if (!requestOptions?.stream) return { allowed: true }
        const body = await response.json().catch(() => undefined) as { lease?: unknown; expiresAt?: unknown } | undefined
        if (typeof body?.lease !== "string" || typeof body.expiresAt !== "number") {
          return denied(503, "session_authority_invalid_response")
        }
        return { allowed: true, lease: body.lease, expiresAt: body.expiresAt }
      }
      const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined
      const status = response.status === 401 ? 401 : response.status === 409 ? 409 : response.status === 503 ? 503 : 403
      return denied(
        status,
        typeof body?.error?.code === "string"
          ? body.error.code
          : status === 401 ? "session_authority_proof_invalid"
            : status === 409 ? "session_turn_in_progress"
            : status === 503 ? "session_authority_unavailable" : "session_private",
        typeof body?.error?.message === "string" ? body.error.message : undefined,
      )
    } catch {
      return denied(503, "session_authority_unavailable")
    }
  }
  const authorize = (input: SessionAuthorityInput) => request(
    input,
    sessionAccessRequiresWrite(input) ? "write" : "read",
  ) as Promise<SessionAccessDecision>
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: true,
    authority: {
      authorizeSessionRead: authorize,
      authorizeSessionWrite: authorize,
      authorizeSessionStream: (input, lease) => request(
        input,
        sessionAccessRequiresWrite(input) ? "write" : "read",
        { stream: true, ...(lease ? { lease } : {}) },
      ) as Promise<SessionAccessStreamDecision>,
      registerSession: (input) => request(input, "register") as Promise<SessionAccessDecision>,
      acquireTurn: (input) => request(
        input,
        "turn_acquire",
        { turnId: input.turnId },
      ) as Promise<SessionTurnLeaseDecision>,
      renewTurn: (input) => request(
        input,
        "turn_renew",
        { turnId: input.turnId, leaseId: input.leaseId, fencingToken: input.fencingToken },
      ) as Promise<SessionTurnLeaseDecision>,
      releaseTurn: (input) => request(
        input,
        "turn_release",
        { turnId: input.turnId, leaseId: input.leaseId, fencingToken: input.fencingToken },
      ) as Promise<SessionTurnReleaseDecision>,
    },
  })
  policy.authorizeHost = async (input) => {
    const url = options.url?.trim()
    if (!url || !input.credential) return denied(503, "session_authority_unavailable")
    const action: HostAuthorityAction = input.minimumRole === "admin" || input.minimumRole === "owner"
      ? "host_admin"
      : "host_read"
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: { authorization: input.credential, "content-type": "application/json" },
        body: JSON.stringify({ action }),
        signal: input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal,
      })
      if (response.ok) return { allowed: true }
      const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined
      const status = response.status === 401 ? 401 : response.status === 503 ? 503 : 403
      return denied(
        status,
        typeof body?.error?.code === "string" ? body.error.code : "host_authority_denied",
        typeof body?.error?.message === "string" ? body.error.message : undefined,
      )
    } catch {
      return denied(503, "session_authority_unavailable")
    }
  }
  policy.markRegistrationAmbiguous = (input) => request(
    input as SessionAuthorityInput,
    "registration_ambiguous",
    { reason: input.reason },
  ) as Promise<SessionAccessDecision>
  policy.beginRegistrationCompensation = (input) => request(
    input as SessionAuthorityInput,
    "compensation_begin",
    { reason: input.reason },
  ) as Promise<SessionAccessDecision>
  policy.completeRegistrationCompensation = (input) => request(
    input as SessionAuthorityInput,
    "compensation_complete",
    { reason: input.reason },
  ) as Promise<SessionAccessDecision>
  return policy
}

export function remoteWorkspaceSessionAccessPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  return remoteWorkspaceSessionAccessPolicy({ url: env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL] })
}

function isRegistrationAction(action: string) {
  return action === "register"
    || action === "registration_ambiguous"
    || action === "compensation_begin"
    || action === "compensation_complete"
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
    message: message ?? (status === 503
      ? "Session authority is temporarily unavailable"
      : "Session access requires current creator, participant, or organization administrator authority"),
  }
}
