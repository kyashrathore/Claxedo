import type { ClaxedoFetch } from "./contract"

/**
 * One row of `GET /api/workspace`, shaped as the control plane's
 * `listWorkspaces` projection writes it: the machine is stated by `backing`
 * and `placement`, and no field names a workspace type.
 */
export type ControlPlaneWorkspaceRow = {
  workspace_id: string
  backing: "local-worktree" | "cloud-vm"
  project_id?: string
  display_name?: string
  remote_directory?: string
  role?: string
  placement?: { host_enrollment_id?: string; directory?: string }
  host_online?: boolean
}

export function controlPlaneWorkspaceRow(
  input: Pick<ControlPlaneWorkspaceRow, "workspace_id" | "backing"> & Partial<ControlPlaneWorkspaceRow>,
): ControlPlaneWorkspaceRow {
  const directory = input.remote_directory
  return {
    role: "owner",
    ...input,
    placement: input.placement ?? {
      ...(input.backing === "local-worktree" ? { host_enrollment_id: `enr_${input.workspace_id}` } : {}),
      ...(directory ? { directory } : {}),
    },
    ...(input.backing === "local-worktree" ? { host_online: input.host_online ?? true } : {}),
  }
}

/**
 * The rows `GET /api/workspace?access=` answers for one scope.
 *
 * `user-hosted` is the only scope the route filters; `cloud` hands back every
 * row the caller can see, provisioned or not, so a client that trusts the
 * scope it asked for rather than the row's own `backing` mislabels machines as
 * cloud VMs.
 */
export function workspaceListScopeRows(
  rows: readonly ControlPlaneWorkspaceRow[],
  scope: string | null,
): readonly ControlPlaneWorkspaceRow[] {
  if (scope === "user-hosted") return rows.filter((row) => row.backing === "local-worktree")
  return rows
}

export function controlPlaneWorkspaceListFetch(rows: readonly ControlPlaneWorkspaceRow[]): ClaxedoFetch {
  return async (path) => {
    const url = new URL(path, "http://control.local")
    if (url.pathname !== "/api/workspace") return new Response("no such route", { status: 404 })
    return Response.json({ workspaces: workspaceListScopeRows(rows, url.searchParams.get("access")) })
  }
}
