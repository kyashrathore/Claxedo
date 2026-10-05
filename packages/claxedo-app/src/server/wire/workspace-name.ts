import { nonEmptyString } from "@claxedo/helpers/guards"

const UNNAMED_CLOUD_WORKSPACE = "Cloud workspace"

function ownName(row: Record<string, unknown>, id: string): string | undefined {
  return [row.workspace_name, row.workspaceName, row.display_name, row.displayName].map(nonEmptyString).find((name) => name !== undefined && name !== id)
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path
}

export function cloudWorkspaceName(row: Record<string, unknown>, id: string, branch: string | undefined): string {
  return ownName(row, id) ?? [UNNAMED_CLOUD_WORKSPACE, branch].filter(Boolean).join(" · ")
}

export function placementName(row: Record<string, unknown>, id: string, cloud: boolean, path: string | undefined, branch: string | undefined): string {
  if (cloud) return cloudWorkspaceName(row, id, branch)
  return ownName(row, id) ?? (path ? folderName(path) : id)
}
