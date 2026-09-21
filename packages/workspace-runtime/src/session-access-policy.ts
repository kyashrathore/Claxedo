import type { RelayHostAuthContext } from "./workspace-host-service-auth"
import { errorBody } from "./routes/error-body"

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
  | "queue_read"
  | "abort"
  | "revert"
  | "unrevert"
  | "fork"
  | "command"
  | "shell"
  | "summarize"
  | "delete"
  | "session_event_stream"
  | "checkpoint_read"
  | "checkpoint_write"
  | "tool_read"
  | "tool_write"
  | "pty_read"
  | "pty_write"
  | "agent_lifecycle_read"
  | "agent_lifecycle_write"
  | "agent_setup_read"
  | "agent_setup_write"
  | "worktree_read"
  | "worktree_write"
  | "document_write"
  | "goal_state"
  | "goal_capabilities"
  | "goal_read"
  | "goal_start"
  | "goal_pause"
  | "goal_resume"
  | "goal_stop"
  | "goal_delete"

export type SessionAccessPolicyInput = {
  actor?: SessionAccessActor
  authority?: SessionWorkspaceAuthority
  /** Signed request proof forwarded only to the narrow authority callback. */
  credential?: string
  /** Cancels only the in-flight authority request; never serialized. */
  signal?: AbortSignal
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
  | { allowed: false; status: 401 | 403 | 409 | 503; code: string; message: string }

export type SessionAccessStreamDecision =
  | { allowed: true; lease: string; expiresAt: number }
  | Exclude<SessionAccessDecision, { allowed: true }>

export type SessionHostAccessDecision =
  | { allowed: true; lease?: string; expiresAt?: number }
  | Exclude<SessionAccessDecision, { allowed: true }>
export type SessionTurnLeaseDecision =
  | {
      allowed: true
      turnId: string
      leaseId: string
      fencingToken: number
      acquiredAt: number
      expiresAt: number
    }
  | Exclude<SessionAccessDecision, { allowed: true }>
export type SessionTurnReleaseDecision =
  | { released: boolean }
  | Exclude<SessionAccessDecision, { allowed: true }>
export type SessionReservationDecision =
  | { allowed: true; operationId: string }
  | Exclude<SessionAccessDecision, { allowed: true }>

export type SessionAccessPolicy = {
  /**
   * What the composition was given, not who is asking: `managed-private`
   * means an authority bundle is wired. The private-session lifecycle also
   * needs `sessionRequestProvenance` to say `relay-replayed`.
   */
  sessionAuthority: "local" | "managed-private"
  authorize(input: SessionAccessPolicyInput): Promise<SessionAccessDecision> | SessionAccessDecision
  filterSessions(
    input: SessionAccessPolicyInput & { sessionIds: readonly string[] },
  ): Promise<readonly string[]> | readonly string[]
  authorizePrefix(input: SessionAccessPolicyInput & { method: string; path: string }): Promise<SessionAccessDecision> | SessionAccessDecision
  /**
   * Workspace-level access. A remote authority answers a read with a
   * workspace stream lease when it can mint one: the credential a long-lived
   * unscoped `wr/events` connection presents for every session that first
   * appears on it after the request's own token has expired, and what renews
   * that lease (`lease`) in turn.
   */
  authorizeHost?(
    input: SessionAccessPolicyInput & { minimumRole: "viewer" | "editor" | "admin" | "owner"; lease?: string },
  ): Promise<SessionHostAccessDecision> | SessionHostAccessDecision
  registerSession?(
    input: SessionAccessPolicyInput & { sessionId: string; registrationOperationId: string },
  ): Promise<SessionAccessDecision> | SessionAccessDecision
  /**
   * Reserves a child session as the verified actor before the runtime creates
   * it, answering the registration operation the create then registers under.
   * Only the remote flavour has one: a child created in process by the
   * workspace's own runtime has no caller that reserved first.
   */
  reserveSession?(
    input: SessionAccessPolicyInput & { sessionId: string; parentSessionId: string },
  ): Promise<SessionReservationDecision> | SessionReservationDecision
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
  acquireTurn?(
    input: SessionAccessPolicyInput & { sessionId: string; turnId: string },
  ): Promise<SessionTurnLeaseDecision> | SessionTurnLeaseDecision
  renewTurn?(
    input: SessionAccessPolicyInput & {
      sessionId: string
      turnId: string
      leaseId: string
      fencingToken: number
    },
  ): Promise<SessionTurnLeaseDecision> | SessionTurnLeaseDecision
  releaseTurn?(
    input: SessionAccessPolicyInput & {
      sessionId: string
      turnId: string
      leaseId: string
      fencingToken: number
    },
  ): Promise<SessionTurnReleaseDecision> | SessionTurnReleaseDecision
}

export type SessionAuthorityInput = SessionAccessPolicyInput & {
  actor: SessionAccessActor
  authority: SessionWorkspaceAuthority
  sessionId: string
}

export type SessionAuthorityPredicate = (
  input: SessionAuthorityInput,
) => Promise<SessionAccessDecision | boolean | void> | SessionAccessDecision | boolean | void

export type SessionAuthorityStreamPredicate = (
  input: SessionAuthorityInput,
  lease?: string,
) => Promise<SessionAccessStreamDecision> | SessionAccessStreamDecision

export type SessionAuthorityTurnAcquirePredicate = (
  input: SessionAuthorityInput & { turnId: string },
) => Promise<SessionTurnLeaseDecision> | SessionTurnLeaseDecision

export type SessionAuthorityTurnRenewPredicate = (
  input: SessionAuthorityInput & { turnId: string; leaseId: string; fencingToken: number },
) => Promise<SessionTurnLeaseDecision> | SessionTurnLeaseDecision

export type SessionAuthorityTurnReleasePredicate = (
  input: SessionAuthorityInput & { turnId: string; leaseId: string; fencingToken: number },
) => Promise<SessionTurnReleaseDecision> | SessionTurnReleaseDecision

/**
 * The private-session authority a managed composition delegates to.
 *
 * It is one bundle because the capabilities are one contract: a policy that
 * can admit a request but not the live stream behind it still reports itself
 * as `managed-private`, and every managed terminal or session stream then
 * fails at the point it asks for the lease its agent callbacks renew. Turn
 * admission is the same contract's fifth capability — a relay-replayed prompt
 * on a `managed-private` policy always takes a durable turn lease, so the
 * bundle carries `acquireTurn`/`renewTurn`/`releaseTurn` as required members
 * rather than an optional add-on a composer can forget to wire up.
 */
export type ManagedSessionAuthority = {
  authorizeSessionRead: SessionAuthorityPredicate
  authorizeSessionWrite: SessionAuthorityPredicate
  authorizeSessionStream: SessionAuthorityStreamPredicate
  registerSession: SessionAuthorityPredicate
  acquireTurn: SessionAuthorityTurnAcquirePredicate
  renewTurn: SessionAuthorityTurnRenewPredicate
  releaseTurn: SessionAuthorityTurnReleasePredicate
}

export type ManagedWorkspaceSessionAccessPolicyOptions = {
  requireActor?: boolean
  /** Absent for the unbound local flavour; a whole bundle for managed-private. */
  authority?: ManagedSessionAuthority
}

type SessionRouteDecision =
  | { kind: "authorize"; operation: SessionAccessOperation }
  | { kind: "filter"; operation: SessionAccessOperation }
  | { kind: "stream"; operation: SessionAccessOperation }
  | { kind: "workspace" }

/**
 * Route-level contract for every client-presentation session-core surface.
 * `workspace` is an explicit decision for directory/catalog surfaces that do
 * not expose an existing Session transcript. New routes must choose a decision
 * here before the inventory test will pass.
 */
export const SESSION_CORE_ROUTE_ACCESS = {
  "DELETE /session/:id": { kind: "authorize", operation: "delete" },
  "GET /agent": { kind: "workspace" },
  "GET /command": { kind: "workspace" },
  "GET /experimental/session": { kind: "filter", operation: "session_list" },
  "GET /permission": { kind: "filter", operation: "permission_list" },
  "GET /permission/modes": { kind: "workspace" },
  "GET /question": { kind: "filter", operation: "question_list" },
  "GET /session": { kind: "filter", operation: "session_list" },
  "GET /session/:id": { kind: "authorize", operation: "session_meta_read" },
  "GET /session/:id/capabilities": { kind: "authorize", operation: "session_capabilities_read" },
  "GET /session/:id/subagents": { kind: "authorize", operation: "list_subagents" },
  "GET /session/:id/config": { kind: "authorize", operation: "session_config_read" },
  "GET /session/:id/goal": { kind: "authorize", operation: "goal_read" },
  "GET /session/:id/goal/capabilities": { kind: "authorize", operation: "goal_capabilities" },
  "GET /session/:id/goal/state": { kind: "authorize", operation: "goal_state" },
  "POST /session/:id/goal": { kind: "authorize", operation: "goal_start" },
  "POST /session/:id/goal/pause": { kind: "authorize", operation: "goal_pause" },
  "POST /session/:id/goal/resume": { kind: "authorize", operation: "goal_resume" },
  "POST /session/:id/goal/stop": { kind: "authorize", operation: "goal_stop" },
  "DELETE /session/:id/goal": { kind: "authorize", operation: "goal_delete" },
  "GET /session/:id/message": { kind: "authorize", operation: "message_read" },
  "GET /session/:id/permission-mode": { kind: "authorize", operation: "permission_mode_read" },
  "GET /session/:id/queue": { kind: "authorize", operation: "queue_read" },
  "POST /session/:id/queue/:seq/:action": { kind: "authorize", operation: "prompt" },
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
  "POST /session/:id/shell": { kind: "authorize", operation: "shell" },
  "POST /session/:id/summarize": { kind: "authorize", operation: "summarize" },
  "POST /session/:id/unrevert": { kind: "authorize", operation: "unrevert" },
  "POST /session/:sessionId/permissions/:permId": { kind: "authorize", operation: "permission_response" },
  "PUT /session/:id/permission-mode": { kind: "authorize", operation: "permission_mode_write" },
} as const satisfies Record<string, SessionRouteDecision>

/**
 * The two kinds of write a session decision can be asked about. A `send`
 * share carries an agent turn and nothing else, so the class has to reach the
 * session authority with the question: the level alone cannot tell a prompt
 * from a shell command, and both arrive as a write.
 */
export type SessionWriteClass = "agent_turn" | "session_control"

/** Driving the agent and answering what it asks: what a `send` share buys. */
const AGENT_TURN_OPERATIONS = new Set<SessionAccessOperation>([
  "prompt",
  "permission_response",
  "question_response",
  "abort",
])

const SESSION_CONTROL_OPERATIONS = new Set<SessionAccessOperation>([
  "session_create",
  "session_meta_write",
  "session_config_write",
  "permission_mode_write",
  "revert",
  "unrevert",
  "fork",
  "command",
  "shell",
  "summarize",
  "delete",
  "checkpoint_write",
  "tool_write",
  "pty_write",
  "agent_lifecycle_write",
  "goal_start",
  "goal_pause",
  "goal_resume",
  "goal_stop",
  "goal_delete",
  "agent_setup_write",
  "worktree_write",
  "document_write",
])

const SESSION_FILTER_CONCURRENCY = 16

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const

/**
 * A write carrying no session is the workspace's own, and the relay role is
 * the only thing that answers for it. A session-scoped write is the session
 * authority's question instead, because a `send` share admits someone the
 * workspace ranks below editor — or not at all.
 */
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
  if (
    input.authority
    && !input.sessionId
    && sessionAccessRequiresWrite(input)
    && ROLE_RANK[input.authority.role] < ROLE_RANK.editor
  ) {
    return {
      allowed: false,
      status: 403,
      code: "workspace_write_forbidden",
      message: "Workspace mutation requires workspace editor authority",
    }
  }
  return { allowed: true }
}

export function sessionAccessRequiresWrite(
  input: Pick<SessionAccessPolicyInput, "operation" | "method">,
) {
  return sessionAccessWriteClass(input) !== undefined
}

/** The class a write carries to the session authority; nothing for a read. */
export function sessionAccessWriteClass(
  input: Pick<SessionAccessPolicyInput, "operation" | "method">,
): SessionWriteClass | undefined {
  if (AGENT_TURN_OPERATIONS.has(input.operation)) return "agent_turn"
  return SESSION_CONTROL_OPERATIONS.has(input.operation) ? "session_control" : undefined
}

function normalizeAuthorityDecision(result: SessionAccessDecision | boolean | void): SessionAccessDecision {
  if (result === undefined || result === true) return { allowed: true }
  if (result === false) {
    return {
      allowed: false,
      status: 403,
      code: "session_private",
      message: "Session access requires creator, participant, or session share authority",
    }
  }
  return result
}

const turnActorRequired = {
  allowed: false as const,
  status: 403 as const,
  code: "session_actor_required",
  message: "Managed session turns require verified actor claims",
}

/**
 * Without an authority bundle the policy declares `local` and refuses any
 * session-scoped request that arrives with relay claims
 * (`session_authority_required`); with one it declares `managed-private` and
 * every session-scoped decision is the bundle's.
 */
export function managedWorkspaceSessionAccessPolicy(
  options: ManagedWorkspaceSessionAccessPolicyOptions = {},
): SessionAccessPolicy {
  const authority = options.authority
  const authorize = async (input: SessionAccessPolicyInput) => {
    const workspace = authorizeManaged(input, options.requireActor === true)
    if (!workspace.allowed || !input.authority || !input.sessionId) return workspace
    if (!input.actor) return workspace
    if (!authority) {
      return {
        allowed: false,
        status: 403,
        code: "session_authority_required",
        message: "Managed session access requires creator, participant, or session share authority",
      } satisfies SessionAccessDecision
    }
    const predicate = sessionAccessRequiresWrite(input)
      ? authority.authorizeSessionWrite
      : authority.authorizeSessionRead
    return normalizeAuthorityDecision(await predicate({
      ...input,
      actor: input.actor,
      authority: input.authority,
      sessionId: input.sessionId,
    }))
  }
  return {
    sessionAuthority: authority ? "managed-private" : "local",
    ...(authority
      ? {
          async authorizeStream(input: SessionAccessPolicyInput & { sessionId: string }, lease?: string) {
            const workspace = authorizeManaged(input, options.requireActor === true)
            if (!workspace.allowed) return workspace
            if (!input.authority || !input.actor) {
              return {
                allowed: false as const,
                status: 403 as const,
                code: "session_actor_required",
                message: "Managed session streams require verified actor claims",
              }
            }
            return authority.authorizeSessionStream({
              ...input,
              actor: input.actor,
              authority: input.authority,
              sessionId: input.sessionId,
            }, lease)
          },
          async acquireTurn(input: SessionAccessPolicyInput & { sessionId: string; turnId: string }) {
            const workspace = authorizeManaged(input, options.requireActor === true)
            if (!workspace.allowed) return workspace
            if (!input.authority || !input.actor) return turnActorRequired
            return authority.acquireTurn({
              ...input,
              actor: input.actor,
              authority: input.authority,
              sessionId: input.sessionId,
            })
          },
          async renewTurn(input: SessionAccessPolicyInput & {
            sessionId: string
            turnId: string
            leaseId: string
            fencingToken: number
          }) {
            const workspace = authorizeManaged(input, options.requireActor === true)
            if (!workspace.allowed) return workspace
            if (!input.authority || !input.actor) return turnActorRequired
            return authority.renewTurn({
              ...input,
              actor: input.actor,
              authority: input.authority,
              sessionId: input.sessionId,
            })
          },
          async releaseTurn(input: SessionAccessPolicyInput & {
            sessionId: string
            turnId: string
            leaseId: string
            fencingToken: number
          }) {
            const workspace = authorizeManaged(input, options.requireActor === true)
            if (!workspace.allowed) return workspace
            if (!input.authority || !input.actor) return turnActorRequired
            return authority.releaseTurn({
              ...input,
              actor: input.actor,
              authority: input.authority,
              sessionId: input.sessionId,
            })
          },
        }
      : {}),
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
      if (!authority) {
        return {
          allowed: false,
          status: 403,
          code: "session_authority_required",
          message: "Managed session creation requires creator registration authority",
        }
      }
      return normalizeAuthorityDecision(await authority.registerSession({
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

/**
 * The two members of a request context this function reads. Narrowed to the ONE
 * key it actually asks for, so the returned claims arrive already typed instead
 * of as a union the body then had to assert its way out of.
 */
type SessionAccessContextReader = {
  get(name: "relayHostAuth"): RelayHostAuthContext["relayHostAuth"]
  req?: { header(name: string): string | undefined }
}

export type SessionRequestProvenance = "loopback-direct" | "relay-replayed"

type SessionRequestProvenanceReader = SessionAccessContextReader & {
  get(name: "relayHostDirectAuth"): RelayHostAuthContext["relayHostDirectAuth"]
}

/**
 * Who reached this runtime, read off the request rather than off the
 * composition it was mounted with.
 *
 * Both marks are set only where a boundary verified the caller: the relay
 * host-token middleware, the owner grant, and the embedded exposure the
 * daemon ingress stamps after refusing every relayed request it cannot
 * verify. The direct mark is that middleware admitting a bearer it trusts
 * without a relay identity: the credential this runtime minted for the
 * harness it launched, its own config token on health, an agent hook
 * callback, and the token the control plane injects. None of them names an
 * actor, so the request cannot be attributed to the person at this machine's
 * keyboard and gets the private-session lifecycle instead. Only an unmarked
 * request is the machine's own user. Registration, turn admission and event
 * privacy ask this, not `SessionAccessPolicy.sessionAuthority`.
 */
export function sessionRequestProvenance(input: SessionRequestProvenanceReader): SessionRequestProvenance {
  return input.get("relayHostAuth") || input.get("relayHostDirectAuth") ? "relay-replayed" : "loopback-direct"
}

/**
 * Actor identity is read off the `relayHostAuth` mark alone, never off a
 * header the caller could write; only a boundary that verified the caller
 * sets the mark.
 */
export function sessionAccessContext(input: SessionAccessContextReader):
  Pick<SessionAccessPolicyInput, "actor" | "authority" | "credential"> & { author?: SessionAccessAuthor } {
  const auth = input.get("relayHostAuth")
  if (!auth) return {}
  const profile = auth as typeof auth & {
    actor_public_id?: string
    actor_name?: string
    actor_avatar_url?: string
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
  return {
    ...(input.req?.header("authorization") ? { credential: input.req.header("authorization") } : {}),
    actor: { actorId: auth.actor_id, actorKind: auth.actor_kind },
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
