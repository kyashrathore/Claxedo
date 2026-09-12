/**
 * Who a Tasks request is, and what that identity may reach.
 *
 * The kit knows only `TasksActor = { scopeId, ownerId }` — two opaque strings
 * — so a host has to keep the principal those strings were derived from
 * somewhere the authorization port can find it again. That is what
 * `createTasksPrincipals` is: the actor handed to the kit is minted here, and
 * the signed principal stays beside it under the actor's own identity. Nothing
 * is keyed by the id strings, so a caller cannot reach another request's
 * principal by claiming its scope.
 */
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { localControlPlaneAuth, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { asOrgId, asProjectId } from "@claxedo/server-core/platform/auth/branded-id"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { SessionReference, TasksActor, TasksAuthorizationPort } from "@claxedo/tasks"
import type { TasksAuthenticate, TasksAuthenticated } from "@claxedo/tasks/http"

/** The scope an unsigned local daemon serves: the one machine. Its owner is `localControlPlaneAuth`'s subject. */
export const TASKS_LOCAL_SCOPE = "local"

export type TasksPrincipals = {
  actorOf(auth: SignedControlPlaneAuth, scopeId: string): TasksActor
  /** The principal an actor was minted from, or undefined for an actor this host did not mint. */
  authOf(actor: TasksActor): SignedControlPlaneAuth | undefined
}

export function createTasksPrincipals(): TasksPrincipals {
  const principals = new WeakMap<TasksActor, SignedControlPlaneAuth>()
  return {
    actorOf(auth, scopeId) {
      const actor: TasksActor = { scopeId, ownerId: auth.user.subject }
      principals.set(actor, auth)
      return actor
    },
    authOf(actor) {
      return principals.get(actor)
    },
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
