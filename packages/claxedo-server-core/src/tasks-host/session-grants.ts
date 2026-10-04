/**
 * The Tasks grants a host that runs its own sessions hands those sessions.
 *
 * Hosted, a grant crosses from the control plane into a sandbox, so it has to
 * be a signed token that survives the trip. On a box that is both the control
 * plane and the runtime there is no trip: the grant is a handle into this
 * registry with the scope never leaving memory — nothing to sign, nothing to
 * expire out from under a session, no signing key an operator must configure
 * before their agents can write a task down.
 *
 * What does not change is the identity path either side of the handle. The
 * same `capabilityTasksAuthenticate` admits it, against the same workspace
 * owner read at request time, under the same table of what each route costs,
 * and the same Start gates read the scope it resolves to. The registry is only
 * how the scope gets from the MCP mount to the routes.
 */
import { randomToken } from "../platform/auth/web-crypto"
import { TASKS_OPERATIONS, type TasksCapabilityOwner, type TasksCapabilityPort, type TasksCapabilityScope } from "./capability"

export type TasksSessionGrants = Readonly<{
  /**
   * A handle the mount presents as its bearer, for the workspace's current
   * owner. It is issued once per MCP session and lives until this process
   * ends: nothing on the box reports a session's end here, so what bounds a
   * handle is the request-time owner read behind it, not its lifetime.
   *
   * Undefined when this host can name no owner for the workspace, or when
   * Tasks is off: a session is then handed no grant at all rather than one
   * that would have to be believed on what it says about itself.
   */
  issue(input: { workspaceId: string; sessionId?: string }): Promise<string | undefined>
  capability: TasksCapabilityPort
}>

/**
 * One process, one registry.
 *
 * The mount that issues handles and the routes that verify them are composed
 * in different files — the app builds the endpoint, the product entry builds
 * the Tasks routes — and threading a registry between them would put a
 * parameter on every composition in between for a value that can only ever be
 * this process's own.
 */
export function createTasksSessionGrants(input: {
  workspaceOwner: (workspaceId: string) => Promise<TasksCapabilityOwner | undefined>
  /**
   * Whether this machine has Tasks on, read at every issue and every verify.
   * The hosted plane revokes a sandbox's signed pass when its project turns
   * Tasks off; here the handle never left the process, so the switch is
   * simply asked again at the door. Absent means always on.
   */
  enabled?: () => boolean
}): TasksSessionGrants {
  const scopes = new Map<string, TasksCapabilityScope>()
  const enabled = input.enabled ?? (() => true)
  return {
    async issue({ workspaceId, sessionId }) {
      if (!enabled()) return undefined
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
    capability: {
      async verify(token) {
        return enabled() ? scopes.get(token) : undefined
      },
      workspaceOwner: input.workspaceOwner,
    },
  }
}
