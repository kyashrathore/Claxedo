import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import { inProcessFetch, type McpClientInputs } from "@claxedo/mcp"
import type { McpCredential } from "@claxedo/mcp/context"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  TASKS_OPERATIONS,
  type TasksCapabilityPort,
  type TasksCapabilityScope,
} from "@claxedo/server-core/tasks-host/capability"

/**
 * The Tasks grants a box that is its own runtime host hands its own sessions.
 *
 * Hosted, a grant crosses from the control plane into a sandbox, so it has to
 * be a signed token that survives the trip. Here there is no trip: the control
 * plane and the runtime are one process, and the grant is a handle into this
 * registry with the scope never leaving memory — nothing to sign, nothing to
 * expire out from under a session, no signing key a self-host must configure
 * before its agents can write a task down.
 *
 * What does not change is the identity path either side of the handle. The
 * same `capabilityTasksAuthenticate` admits it, against the same workspace
 * owner read at request time, under the same table of what each route costs.
 * The registry is only how the scope gets from the mount to the routes.
 */
export type TasksSessionGrants = Readonly<{
  /** A handle the mount presents as its bearer, for the workspace's current owner. */
  issue(input: { workspaceId: string; sessionId?: string }): Promise<string | undefined>
  /** Forgets a handle. A session that ends keeps no way back in. */
  revoke(token: string): void
  capability: TasksCapabilityPort
}>

/**
 * One process, one registry.
 *
 * The mount that issues handles and the routes that verify them are composed
 * in different files — `app.ts` builds the endpoint, `start.ts` builds the
 * Tasks routes — and threading a registry between them would put a parameter
 * on every composition in between for a value that can only ever be this
 * process's own. The SQLite store these same routes take is held the same way.
 */
export function createTasksSessionGrants(input: {
  workspaceOwner: NonNullable<WorkspaceAuthority["resolveWorkspaceOwner"]>
}): TasksSessionGrants {
  const scopes = new Map<string, TasksCapabilityScope>()
  return {
    async issue({ workspaceId, sessionId }) {
      const owner = await input.workspaceOwner(workspaceId).catch(() => undefined)
      if (!owner) return undefined
      const token = randomToken()
      scopes.set(token, {
        userId: owner.userId,
        orgId: owner.orgId,
        projectId: owner.projectId,
        workspaceId,
        ...(sessionId ? { sessionId } : {}),
        operations: TASKS_OPERATIONS,
      })
      return token
    },
    revoke(token) {
      scopes.delete(token)
    },
    capability: {
      async verify(token) {
        return scopes.get(token)
      },
      workspaceOwner: input.workspaceOwner,
    },
  }
}

/**
 * How a session on this box presents its Tasks grant.
 *
 * Unsigned, there is nothing to present: the fetch arrives on this process's
 * own loopback and the loopback identity mints the one owner this machine has.
 * Signed, no such identity exists, so the fetch carries a handle this box
 * issued for the session's workspace and the capability branch resolves it to
 * that workspace's owner.
 *
 * Only a runtime credential gets one, because only a session has a workspace
 * to be the owner of; an account credential reaches Tasks as itself through
 * the routes it already signs for.
 */
export function selfHostedTasksClientInput(input: {
  app: { request(request: Request): Response | Promise<Response> }
  signed: boolean
  grants?: TasksSessionGrants
}): (credential: McpCredential) => Promise<McpClientInputs["tasks"]> {
  const loopback = (headers: Readonly<Record<string, string>> = {}) =>
    inProcessFetch((call) => input.app.request(call), headers)
  return async (credential) => {
    if (credential.kind !== "runtime") return undefined
    if (!input.signed) return { fetch: loopback(), operations: TASKS_OPERATIONS }
    const grant = await input.grants?.issue({
      workspaceId: credential.workspaceId,
      ...(credential.sessionId ? { sessionId: credential.sessionId } : {}),
    })
    if (!grant) return undefined
    return { fetch: loopback({ authorization: `Bearer ${grant}` }), operations: TASKS_OPERATIONS }
  }
}
