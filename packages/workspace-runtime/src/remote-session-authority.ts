import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessDecision,
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
  ): Promise<SessionAccessDecision> => {
    const url = options.url?.trim()
    if (!url || !input.credential) return denied("session_authority_unavailable")
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: {
          authorization: input.credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: input.sessionId,
          action,
          ...(action === "register" && input.sessionTitle ? { title: input.sessionTitle } : {}),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      })
      if (response.ok) return { allowed: true }
      return denied(response.status === 401 ? "session_authority_proof_invalid" : "session_private")
    } catch {
      return denied("session_authority_unavailable")
    }
  }
  const authorize = (input: SessionAuthorityInput) => request(
    input,
    sessionAccessRequiresWrite(input) ? "write" : "read",
  )
  return managedWorkspaceSessionAccessPolicy({
    requireActor: true,
    authorizeSessionRead: authorize,
    authorizeSessionWrite: authorize,
    registerSession: (input) => request(input, "register"),
  })
}

export function remoteWorkspaceSessionAccessPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  return remoteWorkspaceSessionAccessPolicy({ url: env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL] })
}

function denied(code: string): SessionAccessDecision {
  return {
    allowed: false,
    status: 403,
    code,
    message: "Session access requires current creator, participant, or organization administrator authority",
  }
}
