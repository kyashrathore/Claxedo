import type { RelayHostAuthContext } from "./workspace-host-service-auth"
import { errorBody } from "./routes/http"

export type SessionAccessActor = { actorId: string; actorKind: "human" | "agent" }
export type SessionAccessAuthor = { id: string; name: string; avatarUrl?: string; kind: "human" | "agent" }
export type SessionWorkspaceAuthority = {
  managed: true
  workspaceId: string
  orgId: string
  role: "viewer" | "editor" | "admin" | "owner"
}

export type SessionAccessOperation =
  | "session_create" | "session_list" | "session_status" | "session_meta_read" | "session_meta_write"
  | "session_config_read" | "session_config_write" | "session_capabilities_read" | "list_subagents"
  | "message_read" | "prompt" | "permission_mode_read" | "permission_mode_write" | "permission_list"
  | "permission_response" | "question_list" | "question_response" | "todo_read" | "abort" | "revert"
  | "unrevert" | "fork" | "command" | "delete" | "session_event_stream" | "session_v2_proxy"
  | "checkpoint_read" | "checkpoint_write" | "tool_read" | "tool_write" | "pty_read" | "pty_write"
  | "agent_lifecycle_read" | "agent_lifecycle_write"

export type SessionAccessPolicyInput = {
  actor?: SessionAccessActor
  authority?: SessionWorkspaceAuthority
  /** Signed proof is forwarded only to the narrow authority oracle. */
  credential?: string
  operation: SessionAccessOperation
  sessionId?: string
  sessionTitle?: string
  /** Immutable reserve/register operation created before runtime creation. */
  registrationOperationId?: string
  method?: string
  path?: string
}

export type SessionAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 503; code: string; message: string }
export type SessionAccessStreamDecision =
  | { allowed: true; lease: string; expiresAt: number }
  | Exclude<SessionAccessDecision, { allowed: true }>

export type SessionAccessPolicy = {
  sessionAuthority: "local" | "managed-private"
  authorize(input: SessionAccessPolicyInput): Promise<SessionAccessDecision> | SessionAccessDecision
  filterSessions(input: SessionAccessPolicyInput & { sessionIds: readonly string[] }): Promise<readonly string[]> | readonly string[]
  authorizePrefix(input: SessionAccessPolicyInput & { method: string; path: string }): Promise<SessionAccessDecision> | SessionAccessDecision
  registerSession(input: SessionAccessPolicyInput & { sessionId: string; registrationOperationId: string }): Promise<SessionAccessDecision> | SessionAccessDecision
  markRegistrationAmbiguous?(
    input: SessionAccessPolicyInput & { sessionId: string; registrationOperationId: string; reason: string },
  ): Promise<SessionAccessDecision> | SessionAccessDecision
  beginRegistrationCompensation?(
    input: SessionAccessPolicyInput & { sessionId: string; registrationOperationId: string; reason: string },
  ): Promise<SessionAccessDecision> | SessionAccessDecision
  completeRegistrationCompensation?(
    input: SessionAccessPolicyInput & { sessionId: string; registrationOperationId: string; reason: string },
  ): Promise<SessionAccessDecision> | SessionAccessDecision
  authorizeStream?(
    input: SessionAccessPolicyInput & { sessionId: string },
    lease?: string,
  ): Promise<SessionAccessStreamDecision> | SessionAccessStreamDecision
}

export type SessionAuthorityInput = SessionAccessPolicyInput & {
  actor: SessionAccessActor
  authority: SessionWorkspaceAuthority
  sessionId: string
}
export type SessionAuthorityPredicate = (
  input: SessionAuthorityInput,
) => Promise<SessionAccessDecision | boolean | void> | SessionAccessDecision | boolean | void
export type ManagedWorkspaceSessionAccessPolicyOptions = {
  requireActor?: boolean
  authorizeSessionRead?: SessionAuthorityPredicate
  authorizeSessionWrite?: SessionAuthorityPredicate
  registerSession?: SessionAuthorityPredicate
}

type SessionRouteDecision =
  | { kind: "authorize"; operation: SessionAccessOperation }
  | { kind: "filter"; operation: SessionAccessOperation }
  | { kind: "stream"; operation: SessionAccessOperation }
  | { kind: "workspace" }

/** Closed inventory: a new session-core route must make an explicit privacy decision. */
export const SESSION_CORE_ROUTE_ACCESS = {
  "DELETE /session/:id": { kind: "authorize", operation: "delete" },
  "GET /agent": { kind: "workspace" },
  "GET /command": { kind: "workspace" },
  "GET /event": { kind: "stream", operation: "session_event_stream" },
  "GET /experimental/session": { kind: "filter", operation: "session_list" },
  "GET /permission": { kind: "filter", operation: "permission_list" },
  "GET /permission/modes": { kind: "workspace" },
  "GET /question": { kind: "filter", operation: "question_list" },
  "GET /session": { kind: "filter", operation: "session_list" },
  "GET /session/:id": { kind: "authorize", operation: "session_meta_read" },
  "GET /session/:id/capabilities": { kind: "authorize", operation: "session_capabilities_read" },
  "GET /session/:id/subagents": { kind: "authorize", operation: "list_subagents" },
  "GET /session/:id/config": { kind: "authorize", operation: "session_config_read" },
  "GET /session/:id/message": { kind: "authorize", operation: "message_read" },
  "GET /session/:id/permission-mode": { kind: "authorize", operation: "permission_mode_read" },
  "GET /session/:id/todo": { kind: "authorize", operation: "todo_read" },
  "GET /session/capabilities": { kind: "workspace" },
  "GET /session/status": { kind: "filter", operation: "session_status" },
  "PATCH /session/:id": { kind: "authorize", operation: "session_meta_write" },
  "PATCH /session/:id/config": { kind: "authorize", operation: "session_config_write" },
  "POST /question/:id/reject": { kind: "authorize", operation: "question_response" },
  "POST /question/:id/reply": { kind: "authorize", operation: "question_response" },
  "POST /session": { kind: "authorize", operation: "session_create" },
  "POST /session/:id/abort": { kind: "authorize", operation: "abort" },
  "POST /session/:id/command": { kind: "authorize", operation: "command" },
  "POST /session/:id/fork": { kind: "authorize", operation: "fork" },
  "POST /session/:id/message": { kind: "authorize", operation: "prompt" },
  "POST /session/:id/prompt_async": { kind: "authorize", operation: "prompt" },
  "POST /session/:id/revert": { kind: "authorize", operation: "revert" },
  "POST /session/:id/unrevert": { kind: "authorize", operation: "unrevert" },
  "POST /session/:sessionId/permissions/:permId": { kind: "authorize", operation: "permission_response" },
  "PUT /session/:id/permission-mode": { kind: "authorize", operation: "permission_mode_write" },
} as const satisfies Record<string, SessionRouteDecision>

export const SESSION_V2_PROXY_ROUTE_ACCESS = {
  "ALL /api/session": { kind: "prefix", operation: "session_v2_proxy" },
  "ALL /api/session/*": { kind: "prefix", operation: "session_v2_proxy" },
} as const

const WRITE_OPERATIONS = new Set<SessionAccessOperation>([
  "session_create", "session_meta_write", "session_config_write", "prompt", "permission_mode_write",
  "permission_response", "question_response", "abort", "revert", "unrevert", "fork", "command", "delete",
  "checkpoint_write", "tool_write", "pty_write", "agent_lifecycle_write",
])
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const
const FILTER_CONCURRENCY = 16

export function sessionAccessRequiresWrite(input: Pick<SessionAccessPolicyInput, "operation" | "method">) {
  if (WRITE_OPERATIONS.has(input.operation)) return true
  return input.operation === "session_v2_proxy"
    && !["GET", "HEAD", "OPTIONS"].includes((input.method ?? "GET").toUpperCase())
}

function workspaceDecision(input: SessionAccessPolicyInput, requireActor: boolean): SessionAccessDecision {
  if (!input.authority && !requireActor) return { allowed: true }
  if (!input.actor) return denied(403, "session_actor_required", "Managed session access requires verified actor claims")
  if (input.authority && sessionAccessRequiresWrite(input) && ROLE_RANK[input.authority.role] < ROLE_RANK.editor) {
    return denied(403, "session_write_forbidden", "Session mutation requires workspace editor authority")
  }
  return { allowed: true }
}

function normalize(result: SessionAccessDecision | boolean | void): SessionAccessDecision {
  if (result === undefined || result === true) return { allowed: true }
  if (result === false) return denied(403, "session_private")
  return result
}

export function managedWorkspaceSessionAccessPolicy(
  options: ManagedWorkspaceSessionAccessPolicyOptions = {},
): SessionAccessPolicy {
  const complete = Boolean(options.authorizeSessionRead && options.authorizeSessionWrite && options.registerSession)
  const authorize = async (input: SessionAccessPolicyInput): Promise<SessionAccessDecision> => {
    const workspace = workspaceDecision(input, options.requireActor === true)
    if (!workspace.allowed || !input.authority || !input.sessionId || !input.actor) return workspace
    const predicate = sessionAccessRequiresWrite(input) ? options.authorizeSessionWrite : options.authorizeSessionRead
    if (!predicate) return denied(403, "session_authority_required")
    return normalize(await predicate({ ...input, actor: input.actor, authority: input.authority, sessionId: input.sessionId }))
  }
  return {
    sessionAuthority: complete ? "managed-private" : "local",
    authorize,
    authorizePrefix: authorize,
    async registerSession(input) {
      const workspace = workspaceDecision(input, options.requireActor === true)
      if (!workspace.allowed || !input.authority || !input.actor) return workspace
      if (!options.registerSession) return denied(503, "session_authority_required")
      return normalize(await options.registerSession({
        ...input,
        actor: input.actor,
        authority: input.authority,
        sessionId: input.sessionId,
      }))
    },
    async filterSessions(input) {
      const workspace = workspaceDecision(input, options.requireActor === true)
      if (!workspace.allowed) return []
      const visible: string[] = []
      for (let offset = 0; offset < input.sessionIds.length; offset += FILTER_CONCURRENCY) {
        const batch = input.sessionIds.slice(offset, offset + FILTER_CONCURRENCY)
        const decisions = await Promise.all(batch.map(async (sessionId) => ({
          sessionId,
          decision: await authorize({ ...input, sessionId }),
        })))
        visible.push(...decisions.filter((item) => item.decision.allowed).map((item) => item.sessionId))
      }
      return visible
    },
  }
}

type AccessContextReader = {
  get(name: "relayHostAuth" | "relayHostDirectAuth"):
    | RelayHostAuthContext["relayHostAuth"] | RelayHostAuthContext["relayHostDirectAuth"]
  req?: { header(name: string): string | undefined }
}

/** Actor/tenant identity is accepted only from verified relay-host middleware. */
export function sessionAccessContext(input: AccessContextReader):
  Pick<SessionAccessPolicyInput, "actor" | "authority" | "credential"> & { author?: SessionAccessAuthor } {
  const auth = input.get("relayHostAuth") as RelayHostAuthContext["relayHostAuth"]
  if (!auth) return {}
  return {
    ...(input.req?.header("authorization") ? { credential: input.req.header("authorization") } : {}),
    actor: { actorId: auth.actor_id, actorKind: auth.actor_kind },
    ...(auth.actor_public_id && auth.actor_name
      ? { author: {
          id: auth.actor_public_id,
          name: auth.actor_name,
          ...(auth.actor_avatar_url ? { avatarUrl: auth.actor_avatar_url } : {}),
          kind: auth.actor_kind,
        } }
      : {}),
    authority: {
      managed: true,
      workspaceId: auth.workspace_id,
      orgId: auth.org_id,
      role: auth.role,
    },
  }
}

export function sessionAccessDenied(decision: Exclude<SessionAccessDecision, { allowed: true }>) {
  return Response.json(errorBody(decision.code, decision.message), { status: decision.status })
}

function denied(status: 401 | 403 | 503, code: string, message?: string): Exclude<SessionAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    status,
    code,
    message: message ?? (status === 503
      ? "Session authority is temporarily unavailable"
      : "Session access requires creator, participant, or organization administrator authority"),
  }
}
