import type { RelayHostAuthContext } from "./workspace-host-service-auth"
import { errorBody } from "./routes/http"

export type SessionAccessActor = {
  actorId: string
  actorKind: "human" | "agent"
}

export type SessionAccessAuthor = {
  id: string
  name: string
  avatarUrl?: string
  kind: "human" | "agent"
}

export type SessionWorkspaceAuthority = {
  managed: true
  workspaceId: string
  orgId: string
  role: "viewer" | "editor" | "admin" | "owner"
}

export type SessionAccessOperation =
  | "session_create"
  | "session_list"
  | "session_status"
  | "session_meta_read"
  | "session_meta_write"
  | "session_config_read"
  | "session_config_write"
  | "session_capabilities_read"
  | "list_subagents"
  | "message_read"
  | "prompt"
  | "permission_mode_read"
  | "permission_mode_write"
  | "permission_list"
  | "permission_response"
  | "question_list"
  | "question_response"
  | "todo_read"
  | "abort"
  | "revert"
  | "unrevert"
  | "fork"
  | "command"
  | "delete"
  | "session_event_stream"
  | "session_v2_proxy"
  | "checkpoint_read"
  | "checkpoint_write"
  | "tool_read"
  | "tool_write"
  | "pty_read"
  | "pty_write"
  | "agent_lifecycle_read"
  | "agent_lifecycle_write"

export type SessionAccessPolicyInput = {
  actor?: SessionAccessActor
  authority?: SessionWorkspaceAuthority
  /** Signed request proof forwarded only to the narrow authority callback. */
  credential?: string
  operation: SessionAccessOperation
  sessionId?: string
  sessionTitle?: string
  method?: string
  path?: string
}

export type SessionAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 503; code: string; message: string }

export type SessionAccessStreamDecision =
  | { allowed: true; lease?: string; expiresAt: number }
  | Exclude<SessionAccessDecision, { allowed: true }>

export type SessionAccessPolicy = {
  /** Composition marker: non-loopback managed hosts require private-session authority. */
  sessionAuthority?: "local" | "managed-private"
  authorize(input: SessionAccessPolicyInput): Promise<SessionAccessDecision> | SessionAccessDecision
  filterSessions(
    input: SessionAccessPolicyInput & { sessionIds: readonly string[] },
  ): Promise<readonly string[]> | readonly string[]
  authorizePrefix(input: SessionAccessPolicyInput & { method: string; path: string }): Promise<SessionAccessDecision> | SessionAccessDecision
  registerSession?(
    input: SessionAccessPolicyInput & { sessionId: string },
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

/**
 * Route-level contract for every OpenCode-shaped session-core surface.
 * `workspace` is an explicit decision for directory/catalog surfaces that do
 * not expose an existing Session transcript. New routes must choose a decision
 * here before the inventory test will pass.
 */
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

const WRITE_OPERATIONS = new Set<SessionAccessOperation>([
  "session_create",
  "session_meta_write",
  "session_config_write",
  "prompt",
  "permission_mode_write",
  "permission_response",
  "question_response",
  "abort",
  "revert",
  "unrevert",
  "fork",
  "command",
  "delete",
  "checkpoint_write",
  "tool_write",
  "pty_write",
  "agent_lifecycle_write",
])

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const
const SESSION_FILTER_CONCURRENCY = 16

function authorizeManaged(input: SessionAccessPolicyInput, requireActor: boolean): SessionAccessDecision {
  if (!input.authority && !requireActor) return { allowed: true }
  if (!input.actor) {
    return {
      allowed: false,
      status: 403,
      code: "session_actor_required",
      message: "Managed session access requires verified actor claims",
    }
  }
  if (input.authority && sessionAccessRequiresWrite(input) && ROLE_RANK[input.authority.role] < ROLE_RANK.editor) {
    return {
      allowed: false,
      status: 403,
      code: "session_write_forbidden",
      message: "Session mutation requires workspace editor authority",
    }
  }
  return { allowed: true }
}

export function sessionAccessRequiresWrite(
  input: Pick<SessionAccessPolicyInput, "operation" | "method">,
) {
  if (WRITE_OPERATIONS.has(input.operation)) return true
  return input.operation === "session_v2_proxy"
    && !["GET", "HEAD", "OPTIONS"].includes((input.method ?? "GET").toUpperCase())
}

function normalizeAuthorityDecision(result: SessionAccessDecision | boolean | void): SessionAccessDecision {
  if (result === undefined || result === true) return { allowed: true }
  if (result === false) {
    return {
      allowed: false,
      status: 403,
      code: "session_private",
      message: "Session access requires creator, participant, or organization administrator authority",
    }
  }
  return result
}

/**
 * Workspace policy with an injectable creator/participant authority boundary.
 * Managed session-specific operations fail closed when the authority callbacks
 * are absent. Loopback composition may use the same object as an explicit local
 * policy; non-loopback hosts require the managed-private composition marker.
 */
export function managedWorkspaceSessionAccessPolicy(
  options: ManagedWorkspaceSessionAccessPolicyOptions = {},
): SessionAccessPolicy {
  const authorityBacked = Boolean(options.authorizeSessionRead && options.authorizeSessionWrite && options.registerSession)
  const authorize = async (input: SessionAccessPolicyInput) => {
    const workspace = authorizeManaged(input, options.requireActor === true)
    if (!workspace.allowed || !input.authority || !input.sessionId) return workspace
    if (!input.actor) return workspace
    const predicate = sessionAccessRequiresWrite(input)
      ? options.authorizeSessionWrite
      : options.authorizeSessionRead
    if (!predicate) {
      return {
        allowed: false,
        status: 403,
        code: "session_authority_required",
        message: "Managed session access requires creator, participant, or organization administrator authority",
      } satisfies SessionAccessDecision
    }
    return normalizeAuthorityDecision(await predicate({
      ...input,
      actor: input.actor,
      authority: input.authority,
      sessionId: input.sessionId,
    }))
  }
  return {
    sessionAuthority: authorityBacked ? "managed-private" : "local",
    async authorize(input) {
      return authorize(input)
    },
    async authorizePrefix(input) {
      return authorize(input)
    },
    async registerSession(input) {
      const workspace = authorizeManaged(input, options.requireActor === true)
      if (!workspace.allowed) return workspace
      if (!input.authority) return { allowed: true }
      if (!input.actor) return workspace
      if (!options.registerSession) {
        return {
          allowed: false,
          status: 403,
          code: "session_authority_required",
          message: "Managed session creation requires creator registration authority",
        }
      }
      return normalizeAuthorityDecision(await options.registerSession({
        ...input,
        actor: input.actor,
        authority: input.authority,
      }))
    },
    async filterSessions(input) {
      const workspace = authorizeManaged(input, options.requireActor === true)
      if (!workspace.allowed) return []
      const batches = Array.from(
        { length: Math.ceil(input.sessionIds.length / SESSION_FILTER_CONCURRENCY) },
        (_, index) => input.sessionIds.slice(
          index * SESSION_FILTER_CONCURRENCY,
          (index + 1) * SESSION_FILTER_CONCURRENCY,
        ),
      )
      const decisions = await batches.reduce(async (previous, batch) => [
        ...await previous,
        ...await Promise.all(batch.map(async (sessionId) => ({
          sessionId,
          decision: await authorize({ ...input, sessionId }),
        }))),
      ], Promise.resolve<Array<{ sessionId: string; decision: SessionAccessDecision }>>([]))
      return decisions.filter((item) => item.decision.allowed).map((item) => item.sessionId)
    },
  }
}

export const SESSION_V2_PROXY_ROUTE_ACCESS = {
  "ALL /api/session": { kind: "prefix", operation: "session_v2_proxy" },
  "ALL /api/session/*": { kind: "prefix", operation: "session_v2_proxy" },
} as const

type SessionAccessContextReader = {
  get(name: "relayHostAuth" | "relayHostDirectAuth"):
    | RelayHostAuthContext["relayHostAuth"]
    | RelayHostAuthContext["relayHostDirectAuth"]
  req?: { header(name: string): string | undefined }
}

/** Actor identity is accepted only from the relay-host verification middleware. */
export function sessionAccessContext(input: SessionAccessContextReader):
  Pick<SessionAccessPolicyInput, "actor" | "authority" | "credential"> & { author?: SessionAccessAuthor } {
  const auth = input.get("relayHostAuth") as RelayHostAuthContext["relayHostAuth"]
  if (!auth) return {}
  const profile = auth as typeof auth & {
    actor_public_id?: string
    actor_name?: string
    actor_avatar_url?: string
    /**
     * Embedded local hop stamp: carry display author without enabling
     * managed-private session authority (which has no registerSession on
     * the in-process embedded composition and would 403 session create).
     */
    attribution_only?: boolean
  }
  const author = auth.actor_kind && profile.actor_public_id && profile.actor_name
    ? {
        author: {
          id: profile.actor_public_id,
          name: profile.actor_name,
          ...(profile.actor_avatar_url ? { avatarUrl: profile.actor_avatar_url } : {}),
          kind: auth.actor_kind,
        } satisfies SessionAccessAuthor,
      }
    : {}
  if (profile.attribution_only) return author
  return {
    ...(input.req?.header("authorization") ? { credential: input.req.header("authorization") } : {}),
    ...(auth.actor_id && auth.actor_kind
      ? { actor: { actorId: auth.actor_id, actorKind: auth.actor_kind } }
      : {}),
    ...author,
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
