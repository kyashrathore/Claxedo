import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { bearerToken, localControlPlaneAuth, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { asOrgId, asProjectId } from "@claxedo/server-core/platform/auth/branded-id"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SessionReference, TasksActor, TasksAuthorizationPort } from "@claxedo/tasks"
import type { TasksAuthenticate, TasksAuthenticated } from "@claxedo/tasks/http"
import {
  tasksRequestCost,
  type TasksCapabilityOwner,
  type TasksCapabilityPort,
  type TasksCapabilityScope,
} from "./capability"

/** The scope an unsigned local daemon serves: the one machine. Its owner is `localControlPlaneAuth`'s subject. */
const TASKS_LOCAL_SCOPE = "local"

/** A verified capability and the workspace owner the authority resolved it to. */
export type TasksCapabilityGrant = Readonly<{ scope: TasksCapabilityScope; owner: TasksCapabilityOwner }>

export type TasksPrincipals = {
  actorOf(auth: SignedControlPlaneAuth, scopeId: string): TasksActor
  /** The principal an actor was minted from, or undefined for an actor this host did not mint. */
  authOf(actor: TasksActor): SignedControlPlaneAuth | undefined
  capabilityActorOf(grant: TasksCapabilityGrant): TasksActor
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
    capabilityActorOf(grant) {
      const actor: TasksActor = { scopeId: grant.owner.orgId, ownerId: grant.owner.userId }
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

export function signedTasksRuntimePrincipal(principals: TasksPrincipals): TasksRuntimePrincipal {
  return async (actor) => {
    const grant = principals.capabilityOf(actor)
    // A capability carries no principal of its own, and the actor it resolved
    // to is the workspace's owner: the session it starts is reserved for that
    // person, not for the agent that asked.
    if (grant) return { principalKind: "user", actorId: grant.owner.actorId, actorKind: "human" }
    const principal = principals.authOf(actor)?.principal
    if (!principal || principal.actorKind !== "human") return undefined
    return { principalKind: "user", actorId: principal.actorId, actorKind: "human" }
  }
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
 * is one — so it falls through to the signed identity, which refuses it with
 * its own words.
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
    return { actor: input.principals.capabilityActorOf({ scope, owner }) }
  }
}

/**
 * The unsigned local principal. The global unsigned-local guard already
 * refuses a non-loopback request before any route runs; this is the same
 * refusal at the feature's own door, so mounting these routes somewhere that
 * guard does not cover cannot open them to the network.
 */
export function loopbackTasksAuthenticate(principals: TasksPrincipals): TasksAuthenticate {
  return (request): TasksAuthenticated => {
    if (!isLoopbackLocalRequest(request)) {
      return { error: "Tasks is loopback-only on an unsigned local server", status: 403 }
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
      // A capability reaches links only through a task in its own project,
      // which admission already resolved through the workspace's owner. What
      // is still checked here is the same thing the signed branch checks: a
      // link naming no workspace cannot be re-checked by anyone, so it is not
      // shown rather than shown unchecked.
      if (input.principals.capabilityOf(actor)) return session.workspaceId !== null
      const auth = authOf(actor)
      if (!auth) return false
      // A hosted session is always registered under a workspace. A link that
      // names none cannot be re-checked, so it is not shown rather than shown
      // unchecked.
      if (session.workspaceId === null) return false
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
 * and every request that gets this far came from the loopback interface of the
 * machine whose projects and sessions these are.
 */
export function createLocalTasksAuthorization(): TasksAuthorizationPort {
  return {
    async authorizeProject() {
      return true
    },
    async authorizeSessionOpen() {
      return true
    },
  }
}
