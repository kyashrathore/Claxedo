import { PublicApiError } from "../../../platform/errors/public-api-error"

/**
 * A machine-placed workspace exists in the inventory exactly as long as a
 * machine is assigned to serve it: unsharing it or revoking its machine retires
 * the row, and sharing it again revives the same record. Cloud rows are never
 * touched here — their lifetime is the sandbox's.
 */
export function retireMachinePlacedWorkspaceSql(where: string) {
  return `
    UPDATE workspaces SET deleted_at = ?, updated_at = ?
    WHERE backing = 'local-worktree' AND deleted_at IS NULL AND ${where}
  `
}

export function refuseCloudWorkspace(workspace: { backing?: unknown }) {
  if (workspace.backing === "cloud-vm") {
    throw new PublicApiError("workspace_backing_conflict", "workspace_backing_conflict: cannot assign a machine to a cloud workspace")
  }
}
