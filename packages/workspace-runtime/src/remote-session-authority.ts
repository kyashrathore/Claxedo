import {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessRequiresWrite,
  type SessionAccessDecision,
  type SessionAccessStreamDecision,
  type SessionAuthorityInput,
} from "./session-access-policy"

export const WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL = "WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL"

export function remoteWorkspaceSessionAccessPolicy(options: {
  url?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
} = {}) {
  const request = async (
    input: SessionAuthorityInput,
    action: "read" | "write" | "register" | "registration_ambiguous" | "compensation_begin" | "compensation_complete",
    requestOptions?: { lease?: string; stream?: boolean; reason?: string },
  ): Promise<SessionAccessDecision | SessionAccessStreamDecision> => {
    const url = options.url?.trim()
    if (!url || (!input.credential && !requestOptions?.lease)) return denied(503, "session_authority_unavailable")
    if (action !== "read" && action !== "write" && !input.registrationOperationId) {
      return denied(503, "session_registration_operation_required")
    }
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: {
          ...(input.credential ? { authorization: input.credential } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: input.sessionId,
          action,
          ...(action !== "read" && action !== "write" ? { operationId: input.registrationOperationId } : {}),
          ...(requestOptions?.stream ? { stream: true, ...(requestOptions.lease ? { lease: requestOptions.lease } : {}) } : {}),
          ...(requestOptions?.reason ? { reason: requestOptions.reason } : {}),
          ...(action === "register" && input.sessionTitle ? { title: input.sessionTitle } : {}),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      })
      if (response.ok) {
        if (!requestOptions?.stream) return { allowed: true }
        const body = await response.json().catch(() => undefined) as { lease?: unknown; expiresAt?: unknown } | undefined
        if (typeof body?.lease !== "string" || typeof body.expiresAt !== "number") {
          return denied(503, "session_authority_invalid_response")
        }
        return { allowed: true, lease: body.lease, expiresAt: body.expiresAt }
      }
      const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined
      const status = response.status === 401 ? 401 : response.status === 503 ? 503 : 403
      return denied(
        status,
        typeof body?.error?.code === "string"
          ? body.error.code
          : status === 401 ? "session_authority_proof_invalid"
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
    authorizeSessionRead: authorize,
    authorizeSessionWrite: authorize,
    registerSession: (input) => request(input, "register") as Promise<SessionAccessDecision>,
  })
  policy.authorizeStream = (input, lease) => request(
    input as SessionAuthorityInput,
    sessionAccessRequiresWrite(input) ? "write" : "read",
    { stream: true, ...(lease ? { lease } : {}) },
  ) as Promise<SessionAccessStreamDecision>
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

function denied(status: 401 | 403 | 503, code: string, message?: string): Exclude<SessionAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    status,
    code,
    message: message ?? (status === 503
      ? "Session authority is temporarily unavailable"
      : "Session access requires current creator, participant, or organization administrator authority"),
  }
}
