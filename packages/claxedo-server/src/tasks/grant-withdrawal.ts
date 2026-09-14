import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { TASKS_CAPABILITY_AUDIENCE } from "./capability"
import type { TasksRootIdentity } from "./root-capability"

export type TasksGrantWithdrawalInput = Readonly<{
  passes: SandboxPassRegister
  /** The same reading the launch environment and the renewal route make. */
  tasksGroupEnabled: (root: TasksRootIdentity) => Promise<boolean>
}>

/**
 * How a Tasks grant already in a sandbox ends before its expiry.
 *
 * A consent write names a user, a project set or an organization, never a
 * workspace, and which roots it turns off depends on the defaults above and
 * below it — so rather than mirror that precedence here, every outstanding
 * grant in the organization is re-read the way it was minted and the ones
 * whose project now says off are revoked. The set is bounded by the grant
 * lifetime: nothing older than an hour is outstanding.
 */
export function createTasksGrantWithdrawal(input: TasksGrantWithdrawalInput) {
  return {
    /** Answers the workspaces whose grants were revoked. */
    async reconcile(orgId: string): Promise<readonly string[]> {
      const outstanding = await input.passes.outstanding({ orgId, audience: TASKS_CAPABILITY_AUDIENCE })
      const roots = new Map<string, TasksRootIdentity>()
      for (const pass of outstanding) {
        const { projectId, ...scope } = pass.scope
        if (projectId) roots.set(scope.workspaceId, { ...scope, projectId })
      }
      const revoked: string[] = []
      for (const [workspaceId, root] of roots) {
        // A root whose activation cannot be read any more — the workspace is
        // gone, or its owner lost the project — has no consent left to stand on.
        const enabled = await input.tasksGroupEnabled(root).catch(() => false)
        if (enabled) continue
        await input.passes.revoke({ workspaceId, audience: TASKS_CAPABILITY_AUDIENCE, reason: "tasks_group_disabled" })
        revoked.push(workspaceId)
      }
      return revoked
    },
    /** A workspace that is gone takes every pass minted for it, whatever the audience. */
    async release(workspaceId: string): Promise<void> {
      await input.passes.revoke({ workspaceId, reason: "workspace_deleted" })
    },
  }
}
