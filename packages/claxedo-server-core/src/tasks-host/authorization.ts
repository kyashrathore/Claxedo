import { asRecord } from "@claxedo/helpers/guards"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { bearerToken, localControlPlaneAuth, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { asOrgId, asProjectId } from "@claxedo/server-core/platform/auth/branded-id"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  tasksErrorDetail,
  type SessionReference,
  type Task,
  type TasksActor,
  type TasksAuthorizationPort,
  type TasksSessionBridgePort,
} from "@claxedo/tasks"
import type { TasksAuthenticate, TasksAuthenticated } from "@claxedo/tasks/http"
import {
  tasksRequestCost,
  type TasksCapabilityOwner,
  type TasksCapabilityPort,
  type TasksCapabilityScope,
  type TasksRequestCost,
} from "./capability"

/** The scope an unsigned local daemon serves: the one machine. Its owner is `localControlPlaneAuth`'s subject. */
const TASKS_LOCAL_SCOPE = "local"

/**
 * The owner a grant acts as on an unsigned local machine: the one person this
 * daemon serves, in the project the grant's workspace sits in.
 *
 * The same pair `unsignedLocalTasksAuthenticate` mints its person actor from, so a
 * task an agent writes and a task the app writes share one scope and one
 * preset catalog; only the project and the Start gates tell them apart.
 */
export function localTasksWorkspaceOwner(projectId: string): TasksCapabilityOwner {
  const subject = localControlPlaneAuth().user.subject
  return { userId: subject, actorId: subject, orgId: TASKS_LOCAL_SCOPE, projectId }
}

/** A verified capability and the workspace owner the authority resolved it to. */
export type TasksCapabilityGrant = Readonly<{ scope: TasksCapabilityScope; owner: TasksCapabilityOwner }>

export type TasksPrincipals = {
  actorOf(auth: SignedControlPlaneAuth, scopeId: string): TasksActor
  /** The principal an actor was minted from, or undefined for an actor this host did not mint. */
  authOf(actor: TasksActor): SignedControlPlaneAuth | undefined
  /**
   * `session` is the one the kit may record as provenance: the grant's own
   * when it was minted for a session, else the calling-session name the
   * request carried and the verifier already admitted.
   */
  capabilityActorOf(grant: TasksCapabilityGrant, session?: SessionReference): TasksActor
  /** The grant an actor was minted from, or undefined for an actor carrying a signed principal instead. */
  capabilityOf(actor: TasksActor): TasksCapabilityGrant | undefined
}

/**
 * The principal is held against the actor object, never against its id
 * strings: two requests can carry the same scope and owner, so a lookup by
 * those strings would hand one request the other's signed principal.
 */
export function createTasksPrincipals(): TasksPrincipals {
  const principals = new WeakMap<TasksActor, SignedControlPlaneAuth>()
  const grants = new WeakMap<TasksActor, TasksCapabilityGrant>()
  return {
    actorOf(auth, scopeId) {
      const actor: TasksActor = { scopeId, ownerId: auth.user.subject }
      principals.set(actor, auth)
      return actor
    },
    authOf(actor) {
      return principals.get(actor)
    },
    capabilityActorOf(grant, session) {
      const actor: TasksActor = {
        scopeId: grant.owner.orgId,
        ownerId: grant.owner.userId,
        ...(session ? { session } : {}),
      }
      grants.set(actor, grant)
      return actor
    },
    capabilityOf(actor) {
      return grants.get(actor)
    },
  }
}

/**
 * The canonical human a Tasks actor was minted from, for a host whose session
 * authority records a creator.
 *
 * A Tasks actor's `ownerId` cannot answer this: it is a USER id, while a
 * session reservation is recorded against an ACTOR id. Both live on what the
 * actor was minted from — a signed principal, or the workspace owner a
 * capability resolved to — so the actor id is read from there rather than
 * derived from a string the kit happens to carry.
 *
 * Human principals only. An actor this registry did not mint, or a service or
 * agent principal, is undefined, and a reservation asked for with a resolver
 * that cannot answer refuses instead of reserving as itself.
 */
export type TasksRuntimePrincipal = (actor: TasksActor) => Promise<PrivateSessionRuntimePrincipal | undefined>

/**
 * A capability carries no principal of its own, and the actor it resolved to
 * is the workspace's owner: a session it starts is reserved for that person,
 * and a session it asks to open is opened as that person, not as the agent
 * that asked.
 */
function capabilityRuntimePrincipal(grant: TasksCapabilityGrant): PrivateSessionRuntimePrincipal {
  return { principalKind: "user", actorId: grant.owner.actorId, actorKind: "human" }
}

export function signedTasksRuntimePrincipal(principals: TasksPrincipals): TasksRuntimePrincipal {
  return async (actor) => {
    const grant = principals.capabilityOf(actor)
    if (grant) return capabilityRuntimePrincipal(grant)
    const principal = principals.authOf(actor)?.principal
    if (!principal || principal.actorKind !== "human") return undefined
    return { principalKind: "user", actorId: principal.actorId, actorKind: "human" }
  }
}

type CapabilityScopeReader = Pick<TasksCapabilityPort, "workspaceOwner" | "ownerMayReadSession">

/**
 * Whether a session reference a request names may be recorded as where the
 * request came from.
 *
 * A grant minted for one session may name exactly that session. A grant
 * minted for a root names none of its own, so it may name a session of its
 * workspace that the control plane places there now, asked as the owner —
 * the same answer that opens a linked session — and a plane that cannot
 * answer admits no name. A malformed reference is refused here rather than
 * left for the kit to reject as merely invalid.
 */
async function provenanceRefusal(
  grant: TasksCapabilityGrant,
  capability: CapabilityScopeReader,
  named: unknown,
): Promise<string | undefined> {
  const { scope, owner } = grant
  const from = asRecord(named)
  if (scope.sessionId) {
    return from?.sessionId === scope.sessionId && from.workspaceId === scope.workspaceId
      ? undefined
      : "This session may record only itself as a task's provenance"
  }
  const refusal = "This session may record only a session of its own workspace as provenance"
  const sessionId = from?.sessionId
  if (typeof sessionId !== "string" || sessionId.length === 0 || from?.workspaceId !== scope.workspaceId) return refusal
  if (!capability.ownerMayReadSession) return refusal
  const placed = await capability.ownerMayReadSession(owner, { sessionId, workspaceId: scope.workspaceId }).catch(() => false)
  return placed ? undefined : refusal
}

/**
 * The one rule for what a capability may name beyond its own workspace, asked
 * at every door a name comes through: the create body, the task a Start reads
 * back, the session a Start says it is asked from, and the workspace a linked
 * session lives in.
 *
 * A workspace is admitted when the authority places it in the scope's project
 * now, so a task may prefer any of the project's workspaces and none else; a
 * preference of none is admitted because the project the scope already
 * confines then chooses. Both provenance fields are held to
 * `provenanceRefusal`.
 */
export async function capabilityScopeRefusal(
  grant: TasksCapabilityGrant,
  capability: CapabilityScopeReader,
  named: Readonly<{ workspaceId?: string | null; createdFrom?: unknown; startedFrom?: unknown }>,
): Promise<string | undefined> {
  const { scope } = grant
  if (named.workspaceId != null && named.workspaceId !== scope.workspaceId) {
    const owner = await capability.workspaceOwner(named.workspaceId).catch(() => undefined)
    if (!owner || owner.orgId !== scope.orgId || owner.projectId !== scope.projectId) {
      return `This session may act only in project ${scope.projectId}`
    }
  }
  for (const reference of [named.createdFrom, named.startedFrom]) {
    if (reference === undefined) continue
    const refused = await provenanceRefusal(grant, capability, reference)
    if (refused) return refused
  }
  return undefined
}

export type SignedTasksAuthenticateInput = {
  authority: WorkspaceAuthority
  principals: TasksPrincipals
  /** The deployment's own signed-request reader, already bound to its adapters. */
  signed(request: Request): Promise<{ auth?: SignedControlPlaneAuth } | { error: unknown; status: number }>
}

/**
 * The hosted principal: a signed request, mapped to the organization the
 * authority resolves for it. The scope is that organization and the owner is
 * the token subject, so one person's presets stay theirs inside an
 * organization every member can otherwise read tasks in.
 */
export function signedTasksAuthenticate(input: SignedTasksAuthenticateInput): TasksAuthenticate {
  return async (request) => {
    const result = await input.signed(request)
    if ("error" in result) return { error: "This request is not signed", status: result.status === 403 ? 403 : 401 }
    if (!result.auth) return { error: "This request is not signed", status: 401 }
    const orgId = await input.authority.resolveOrgId(result.auth)
    return { actor: input.principals.actorOf(result.auth, orgId) }
  }
}

function capabilityRefusal(message: string): TasksAuthenticated {
  return { error: message, status: 403 }
}

/**
 * The agent's principal: a capability this control plane minted for one
 * workspace, acting as that workspace's current owner.
 *
 * The token names a user, and that name is a claim to check rather than an
 * identity to adopt: the actor comes from the workspace the scope names, read
 * from the authority now, and a token whose user is no longer that owner is
 * refused. A session may act only in the project of its own workspace, so the
 * scope's project, the workspace's project and any project the request names
 * must be one project.
 *
 * A bearer this plane did not mint is not an error here — the CLI's own token
 * is one — so it falls through to the identity behind it, which is the one
 * that decides what an unverified credential is worth: the signed reader
 * verifies it, and the unsigned local reader refuses it rather than reading it
 * as the person at the machine.
 */
export function capabilityTasksAuthenticate(input: {
  capability: TasksCapabilityPort
  principals: TasksPrincipals
  signed: TasksAuthenticate
}): TasksAuthenticate {
  return async (request) => {
    const token = bearerToken(request.headers.get("authorization"))
    const scope = token ? await input.capability.verify(token).catch(() => undefined) : undefined
    if (!scope) return await input.signed(request)
    const cost = await tasksRequestCost(request)
    if (!cost) return capabilityRefusal("A session's Tasks grant cannot reach this command")
    if (!scope.operations.includes(cost.operation)) {
      return capabilityRefusal(`This session's Tasks grant does not allow ${cost.operation}`)
    }
    const owner = await input.capability.workspaceOwner(scope.workspaceId).catch(() => undefined)
    if (!owner || owner.userId !== scope.userId || owner.orgId !== scope.orgId) {
      return capabilityRefusal("This session's workspace no longer answers for the grant it carries")
    }
    if (owner.projectId !== scope.projectId || (cost.projectId !== undefined && cost.projectId !== scope.projectId)) {
      return capabilityRefusal(`This session may act only in project ${scope.projectId}`)
    }
    const refused = await capabilityScopeRefusal({ scope, owner }, input.capability, cost)
    if (refused) return capabilityRefusal(refused)
    return { actor: input.principals.capabilityActorOf({ scope, owner }, provenanceSession(scope, cost)) }
  }
}

/**
 * The session this request's provenance fields may record. A grant minted for
 * a session records exactly that one whether the request names it or not; a
 * root's grant records the calling session the request named, which
 * `capabilityScopeRefusal` has already held to the workspace, and nothing when
 * it named none.
 */
function provenanceSession(scope: TasksCapabilityScope, cost: TasksRequestCost): SessionReference | undefined {
  if (scope.sessionId) return { sessionId: scope.sessionId, workspaceId: scope.workspaceId }
  const named = asRecord(cost.createdFrom ?? cost.startedFrom)
  const sessionId = named?.sessionId
  return typeof sessionId === "string" && sessionId.length > 0
    ? { sessionId, workspaceId: scope.workspaceId }
    : undefined
}

/**
 * The Start door for a capability: a task the owner pointed at a workspace
 * outside the scope's project is refused before the bridge resolves a runtime,
 * reads a transcript or reserves a session there. The task's stored preference
 * is what is checked, because it is the one thing Start reads that admission
 * never saw. A signed person's Start passes untouched.
 */
export function confineCapabilityBridge(
  principals: TasksPrincipals,
  capability: TasksCapabilityPort,
  bridge: TasksSessionBridgePort,
): TasksSessionBridgePort {
  const refusal = async (actor: TasksActor, task: Task) => {
    const grant = principals.capabilityOf(actor)
    const message = grant ? await capabilityScopeRefusal(grant, capability, { workspaceId: task.workspaceId }) : undefined
    return message ? { ok: false as const, error: tasksErrorDetail("forbidden", message) } : undefined
  }
  return {
    sessionState: (origins) => bridge.sessionState(origins),
    preview: async (command) => (await refusal(command.actor, command.task)) ?? bridge.preview(command),
    start: async (command) => (await refusal(command.actor, command.task)) ?? bridge.start(command),
    handoff: (command) => bridge.handoff(command),
    abandon: (command) => bridge.abandon(command),
  }
}

/**
 * A request presenting a bearer credential, whether or not the value parses.
 * The scheme is what makes it a presentation: `Bearer` with nothing usable
 * after it is a grant that failed, not a caller with no credential.
 *
 * Only this scheme. An unsigned box behind desktop basic auth sends
 * `Authorization: Basic …` on every call the person makes, which carries no
 * grant and answers no question a grant would.
 */
function presentsBearer(request: Request): boolean {
  return /^Bearer\b/i.test(request.headers.get("authorization")?.trim() ?? "")
}

/**
 * The unsigned local principal: the one person this machine serves, admitted
 * by the daemon capability the application presents on its own header and
 * carrying no bearer of its own.
 *
 * A bearer that reaches here is a session's Tasks grant that
 * `capabilityTasksAuthenticate` could not verify — unknown, issued by an
 * earlier process, or withdrawn because Tasks was turned off — and it is
 * refused. Reading it as the person instead would turn every stale or
 * withdrawn grant into the machine owner, which is the whole of what the grant
 * confines (security review P105).
 *
 * The global unsigned-local guard already refuses a non-loopback request
 * before any route runs; the same refusal is repeated at the feature's own
 * door, so mounting these routes somewhere that guard does not cover cannot
 * open them to the network.
 */
export function unsignedLocalTasksAuthenticate(principals: TasksPrincipals): TasksAuthenticate {
  return (request): TasksAuthenticated => {
    if (!isLoopbackLocalRequest(request)) {
      return { error: "Tasks is loopback-only on an unsigned local server", status: 403 }
    }
    if (presentsBearer(request)) {
      return { error: "This Tasks grant is not one this machine issued, or is no longer valid", status: 403 }
    }
    return { actor: principals.actorOf(localControlPlaneAuth(), TASKS_LOCAL_SCOPE) }
  }
}

/**
 * The hosted authority's answer, asked as the kit asks it. A refusal is
 * `false` rather than a throw: the kit turns it into the 403 that names the
 * project, and an authority that throws for an unknown project would otherwise
 * become a 500.
 */
export function createTasksAuthorization(input: {
  authority: WorkspaceAuthority
  principals: TasksPrincipals
  /** The port a grant was admitted through; a grant actor on a host that names none is refused everything. */
  capability?: TasksCapabilityPort
}): TasksAuthorizationPort {
  const authOf = (actor: TasksActor): SignedControlPlaneAuth | undefined => input.principals.authOf(actor)
  return {
    async authorizeProject(actor, projectId, access) {
      const grant = input.principals.capabilityOf(actor)
      // The grant's own project was rechecked against the workspace's current
      // owner when the request was admitted, and it is the only project this
      // actor has; `access` needs no second answer because the operations the
      // scope carries are what decided whether a write was admitted at all.
      if (grant) return projectId === grant.scope.projectId
      const auth = authOf(actor)
      if (!auth) return false
      return await input.authority
        .authorizeProject(auth, { orgId: asOrgId(actor.scopeId), projectId: asProjectId(projectId), action: access })
        .then(
          (result) => result.ok,
          () => false,
        )
    },
    async authorizeSessionOpen(actor, session: SessionReference) {
      // A hosted session is always registered under a workspace. A link that
      // names none cannot be re-checked, so it is not shown rather than shown
      // unchecked.
      if (session.workspaceId === null) return false
      const grant = input.principals.capabilityOf(actor)
      if (grant) {
        // Project membership is not session access: a shared task can link a
        // session of another participant's that the workspace's owner may not
        // open. The scope rule refuses a link into another project without
        // asking, and the rest is the session authority's answer for the owner
        // the grant resolved to — asked by canonical actor because a grant
        // carries no signed bearer to ask with — never for the user the token
        // names.
        const { capability, authority } = input
        if (!capability || !authority.authorizeRuntimeSession) return false
        if (await capabilityScopeRefusal(grant, capability, { workspaceId: session.workspaceId })) return false
        return await authority
          .authorizeRuntimeSession({
            ...capabilityRuntimePrincipal(grant),
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            action: "read",
          })
          .then(() => true, () => false)
      }
      const auth = authOf(actor)
      if (!auth) return false
      return await input.authority
        .authorizeSessionRead(auth, { sessionId: session.sessionId, workspaceId: session.workspaceId })
        .then(() => true)
        .catch(() => false)
    },
  }
}

/**
 * The unsigned local answer. There is no project authority on this product —
 * `@claxedo/local-server` cannot reach one, and its closure test asserts so —
 * and the person at this machine reaches these routes over its own loopback
 * interface, so their own projects and sessions need no second opinion.
 *
 * A session's grant is the caller that does: it holds one workspace, and the
 * project that workspace sits in is the whole of what it may work in, read
 * from the workspace now rather than from the handle.
 */
export function createLocalTasksAuthorization(
  principals: Pick<TasksPrincipals, "capabilityOf">,
  capability: CapabilityScopeReader,
): TasksAuthorizationPort {
  return {
    async authorizeProject(actor, projectId) {
      const grant = principals.capabilityOf(actor)
      return grant ? projectId === grant.scope.projectId : true
    },
    async authorizeSessionOpen(actor, session: SessionReference) {
      const grant = principals.capabilityOf(actor)
      if (!grant) return true
      // A link that names no workspace cannot be held to the grant's project,
      // so it is not shown rather than shown unchecked.
      if (session.workspaceId === null) return false
      return !(await capabilityScopeRefusal(grant, capability, { workspaceId: session.workspaceId }))
    },
  }
}
