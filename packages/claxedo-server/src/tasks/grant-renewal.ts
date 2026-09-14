import { Hono } from "hono"
import { decodeJwt } from "jose"
import { TASKS_ROUTE_PATH } from "@claxedo/tasks/http"
import { bearerToken } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { TasksCapabilityPort, TasksOperation } from "@claxedo/server-core/tasks-host/capability"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { TasksCapabilityConfigurationError, verifyTasksCapability } from "./capability"
import type { TasksRootGrant, TasksRootIdentity } from "./root-capability"

export const TASKS_GRANT_RENEWAL_CONTRIBUTION_ID = "claxedo-tasks-grant"

export type TasksGrantRenewalAudit = Readonly<{
  workspaceId: string
  owner: string
  orgId: string
  projectId: string
  sessionId?: string
  operations: readonly TasksOperation[]
  jti: string | undefined
}>

export type TasksGrantRenewalInput = Readonly<{
  signingEnv: Record<string, string | undefined>
  passes?: SandboxPassRegister
  workspaceOwner: TasksCapabilityPort["workspaceOwner"]
  tasksGroupEnabled: (root: TasksRootIdentity) => Promise<boolean>
  /** The launch minter, so a renewed grant holds exactly what a fresh one would. */
  grant: (root: TasksRootIdentity) => Promise<TasksRootGrant>
  audit?: (record: TasksGrantRenewalAudit) => void
  now?: () => number
}>

const OWNER_CHANGED = "This session's workspace no longer answers for the grant it carries"
const GROUP_DISABLED = "Tasks was turned off for this project."

/**
 * `POST /grant/renew` under the Tasks routes: the one channel a running
 * cloud root has back to the control plane, used to trade a still-valid Tasks
 * capability for a fresh one before it expires.
 *
 * Its own door rather than `capabilityTasksAuthenticate`: that authenticator
 * prices a request by the Tasks operation it costs, and renewal costs none.
 * What it shares with every Tasks request is the reading — the workspace's
 * owner and the project's consent are re-resolved now, and a token whose
 * answers changed is refused rather than renewed. The window is the token's
 * own lifetime; an expired one is not a renewal request but a fresh launch.
 */
export function tasksGrantRenewalContribution(input: TasksGrantRenewalInput): ControlPlaneRouteContribution {
  const log = Log.create({ service: "claxedo-tasks" })
  const audit = input.audit ?? ((record: TasksGrantRenewalAudit) => log.info("tasks.grant.renewed", record))
  const refusal = (code: string, message: string) => ({ error: { code, message } })
  const routes = new Hono()
  routes.post("/renew", async (c) => {
    const token = bearerToken(c.req.header("authorization"))
    if (!token) return c.json(refusal("tasks_grant_invalid", "A Tasks capability is required"), 401)
    let scope
    try {
      scope = await verifyTasksCapability(token, input.signingEnv, input.passes ? { revoked: input.passes.revoked } : {})
    } catch (cause) {
      if (cause instanceof TasksCapabilityConfigurationError) {
        log.error("tasks.grant.renewal_misconfigured", { error: cause.message })
        return c.json(refusal("tasks_capability_misconfigured", "This deployment cannot verify Tasks capabilities"), 503)
      }
      return c.json(refusal("tasks_grant_invalid", "This Tasks capability cannot be renewed"), 401)
    }
    const owner = await input.workspaceOwner(scope.workspaceId).catch(() => undefined)
    if (!owner || owner.userId !== scope.userId || owner.orgId !== scope.orgId || owner.projectId !== scope.projectId) {
      return c.json(refusal("tasks_grant_owner_changed", OWNER_CHANGED), 403)
    }
    const { operations: _operations, ...root } = scope
    if (!(await input.tasksGroupEnabled(root))) return c.json(refusal("tasks_group_disabled", GROUP_DISABLED), 403)
    const renewed = await input.grant(root)
    audit({
      workspaceId: root.workspaceId,
      owner: owner.actorId,
      orgId: root.orgId,
      projectId: root.projectId,
      ...(root.sessionId ? { sessionId: root.sessionId } : {}),
      operations: renewed.operations,
      jti: decodeJwt(renewed.token).jti,
    })
    return c.json({ token: renewed.token, operations: renewed.operations, expiresAt: renewed.expiresAt })
  })
  return { id: TASKS_GRANT_RENEWAL_CONTRIBUTION_ID, path: `${TASKS_ROUTE_PATH}/grant`, routes }
}
