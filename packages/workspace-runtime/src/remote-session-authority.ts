import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessDecision,
  type SessionAccessStreamDecision,
  type SessionAuthorityInput,
  sessionAccessRequiresWrite,
} from "./session-access-policy"

export const WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL = "WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL"

export function remoteWorkspaceSessionAccessPolicy(options: {
  url?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
} = {}) {
  const request = async (
    input: SessionAuthorityInput,
    action: "read" | "write" | "register",
    stream?: { lease?: string },
  ): Promise<SessionAccessDecision> => {
    const url = options.url?.trim()
    if (!url || (!input.credential && !stream?.lease)) return denied(503, "session_authority_unavailable")
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
          ...(stream ? { stream: true, ...(stream.lease ? { lease: stream.lease } : {}) } : {}),
          ...(action === "register" && input.sessionTitle ? { title: input.sessionTitle } : {}),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      })
      if (response.ok) {
        if (!stream) return { allowed: true }
        const body = await response.json().catch(() => undefined) as { lease?: unknown; expiresAt?: unknown } | undefined
        if (typeof body?.lease !== "string" || typeof body.expiresAt !== "number") {
          return denied(503, "session_authority_invalid_response")
        }
        const decision: SessionAccessStreamDecision = { allowed: true, lease: body.lease, expiresAt: body.expiresAt }
        return decision
      }
      const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined
      const status = response.status === 401 ? 401 : response.status === 503 ? 503 : 403
      return denied(
        status,
        typeof body?.error?.code === "string"
          ? body.error.code
          : status === 401
            ? "session_authority_proof_invalid"
            : status === 503
              ? "session_authority_unavailable"
              : "session_private",
        typeof body?.error?.message === "string" ? body.error.message : undefined,
      )
    } catch {
      return denied(503, "session_authority_unavailable")
    }
  }
  const authorize = (input: SessionAuthorityInput) => request(
    input,
    sessionAccessRequiresWrite(input) ? "write" : "read",
  )
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: true,
    authorizeSessionRead: authorize,
    authorizeSessionWrite: authorize,
    registerSession: (input) => request(input, "register"),
  })
  policy.authorizeStream = (input, lease) => request(
    input as SessionAuthorityInput,
    sessionAccessRequiresWrite(input) ? "write" : "read",
    { ...(lease ? { lease } : {}) },
  ) as Promise<SessionAccessStreamDecision>
  return policy
}

export function remoteWorkspaceSessionAccessPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  return remoteWorkspaceSessionAccessPolicy({ url: env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL] })
}

function denied(status: 401 | 403 | 503, code: string, message?: string): SessionAccessDecision {
  return {
    allowed: false,
    status,
    code,
    message: message ?? (status === 503
      ? "Session authority is temporarily unavailable"
      : "Session access requires current creator, participant, or organization administrator authority"),
  }
}
