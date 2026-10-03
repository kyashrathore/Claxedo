import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"
import { maySqlForPrincipalRow } from "./authorization"

/** Current placement admission plus the producer generation that wrote these facts. */
export function sessionRuntimeAvailableSql(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid authority time")
  const serving = HOST_SERVING_WORKSPACE_SQL.replace("?", String(now))
  const operates = maySqlForPrincipalRow({ userId: "runtime_workspace.owner_user_id", actorId: "runtime_actor.actor_id" }, "operate", { kind: "workspace", alias: "runtime_workspace" })
  return `EXISTS (
    SELECT 1 FROM workspaces runtime_workspace
    WHERE runtime_workspace.workspace_id = s.workspace_id AND runtime_workspace.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM actors runtime_actor WHERE runtime_actor.user_id = runtime_workspace.owner_user_id
        AND runtime_actor.kind = 'human' AND ${operates})
      AND (
        runtime_workspace.backing = 'cloud-vm' AND s.runtime_enrollment_id IS NULL AND EXISTS (
          SELECT 1 FROM sandbox_leases lease
          WHERE lease.workspace_id = s.workspace_id AND lease.status = 'ready'
            AND lease.lease_id = s.runtime_host_id AND lease.epoch = s.runtime_generation
        )
        OR runtime_workspace.backing = 'local-worktree' AND EXISTS (
          SELECT 1 FROM host_workspace_assignments assignment
          JOIN host_enrollments enrollment ON enrollment.host_id = assignment.host_id
            AND enrollment.owner_actor_id = assignment.owner_actor_id
          WHERE assignment.workspace_id = s.workspace_id AND assignment.host_id = s.runtime_host_id
            AND enrollment.enrollment_id = s.runtime_enrollment_id
            AND enrollment.serving_generation = s.runtime_generation AND ${serving}
        )
      )
  )`
}
