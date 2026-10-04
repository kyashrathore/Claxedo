export type WorkspaceAccessRow = {
  workspace_id: string
  org_id: string
  project_id: string
  owner_user_id: string
  backing: "local-worktree" | "cloud-vm"
  display_name: string
  home_region: string | null
  repo_url: string | null
  repo_name: string | null
  repo_connection_id: string | null
  git_branch: string | null
  remote_directory: string | null
  host_enrollment_id: string | null
  deleted_at: number | null
}

export function workspaceJson(row: WorkspaceAccessRow) {
  return {
    workspace_id: row.workspace_id,
    org_id: row.org_id,
    project_id: row.project_id,
    backing: row.backing,
    placement: {
      ...(row.host_enrollment_id ? { host_enrollment_id: row.host_enrollment_id } : {}),
      ...(row.remote_directory ? { directory: row.remote_directory } : {}),
    },
    display_name: row.display_name,
    ...(row.home_region ? { home_region: row.home_region } : {}),
    ...(row.repo_url ? { repo_url: row.repo_url } : {}),
    ...(row.repo_name ? { repo_name: row.repo_name } : {}),
    ...(row.repo_connection_id ? { repo_connection_id: row.repo_connection_id } : {}),
    ...(row.git_branch ? { git_branch: row.git_branch } : {}),
    ...(row.remote_directory ? { remote_directory: row.remote_directory } : {}),
  }
}
