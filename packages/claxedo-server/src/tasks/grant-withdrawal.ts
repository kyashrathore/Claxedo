import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import type { TasksRootIdentity } from "./root-capability"

export type GrantWithdrawalInput = Readonly<{
  passes: SandboxPassRegister
  /** The audience whose passes this withdrawal ends. */
  audience: string
  /** Written on each revoked pass, so a refusal can say which switch ended it. */
  reason: string
  /** The same reading the launch environment and the renewal route make for this grant's group. */
  groupEnabled: (root: TasksRootIdentity) => Promise<boolean>
}>

/**
 * How a grant already in a sandbox ends before its expiry, one per grant:
 * the Tasks capability under the Tasks group, the owner grant under the
 * subagents group.
 *
 * A consent write names a user, a project set or an organization, never a
 * workspace, and which roots it turns off depends on the defaults above and
 * below it — so rather than mirror that precedence here, every outstanding
 * grant in the organization is re-read the way it was minted and the ones
 * whose project now says off are revoked. The set is bounded by the grant
 * lifetime: nothing older than an hour is outstanding.
 */
export function createGrantWithdrawal(input: GrantWithdrawalInput) {
  return {
    /** Answers the workspaces whose grants were revoked. */
    async reconcile(orgId: string): Promise<readonly string[]> {
      const outstanding = await input.passes.outstanding({ orgId, audience: input.audience })
      const roots = new Map<string, TasksRootIdentity>()
      for (const pass of outstanding) {
        const { projectId, ...scope } = pass.scope
        if (projectId) roots.set(scope.workspaceId, { ...scope, projectId })
      }
      const revoked: string[] = []
      for (const [workspaceId, root] of roots) {
        // A root whose activation cannot be read any more — the workspace is
        // gone, or its owner lost the project — has no consent left to stand on.
        const enabled = await input.groupEnabled(root).catch(() => false)
        if (enabled) continue
        await input.passes.revoke({ workspaceId, audience: input.audience, reason: input.reason })
        revoked.push(workspaceId)
      }
      return revoked
    },
  }
}
