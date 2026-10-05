import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxBrokeredSecret, SandboxManagerInput } from "@claxedo/sandbox-manager"
import type { WorkspaceRuntimePreparation } from "../../../workspace/route-support"
import {
  hostedSandboxInput,
  type HostedWorkspaceRow,
  type WorkspaceSandboxEgress,
} from "../../../workspace/hosted-sandbox-input"

/**
 * The live D1 row a sandbox that no request is serving is rebuilt from, such
 * as a running sandbox re-ensured after its owner's settings change. A
 * workspace deleted meanwhile is refused rather than re-created from nothing.
 */
export async function liveWorkspaceRow(database: D1Database, workspaceId: string): Promise<HostedWorkspaceRow> {
  const row = await database
    .prepare(`select workspace_id, project_id, home_region, repo_url, git_branch, remote_directory, machine_class
      from workspaces where workspace_id = ? and deleted_at is null`)
    .bind(workspaceId)
    .first()
  if (!row) throw new Error(`workspace ${workspaceId} has no live workspace row`)
  return row
}

export function hostedWorkspaceSandboxInput(input: {
  database: D1Database
  egress: WorkspaceSandboxEgress
}) {
  return async (
    workspaceId: string,
    prepared: { preparation: WorkspaceRuntimePreparation | undefined; secrets: readonly SandboxBrokeredSecret[] },
  ): Promise<SandboxManagerInput> => hostedSandboxInput(await liveWorkspaceRow(input.database, workspaceId), {
    egress: input.egress,
    ...prepared,
  })
}
