import type { Workspace } from "./index"
import { workspaceBacking } from "./backing"
import { workspacePlacement } from "./placement"

/**
 * A stored workspace as a control-plane LIST row.
 *
 * `GET /api/workspace?host=` answers rows of this shape whoever serves it, so
 * a client reads one contract from the hosted control plane, from a signed node
 * and from a loopback daemon. The field set is the authority's own list row
 * (`listWorkspaces`) minus `role`, `placement` and `host_online` — the three
 * facts one machine's store cannot know, having no principal, no enrollment and
 * no serving-host table. Adding a field the authority does not send, `status`
 * being the tempting one, makes a daemon's rows disagree with the control
 * plane's on the same route, which is the divergence this exists to end. `backing` is the bare word the authority stores,
 * NOT {@link workspaceResponse}'s object: every client narrows a list row by
 * comparing that field to `"cloud-vm"` / `"local-worktree"`, and an object
 * there matches neither, so the row parses as "states no placement" and the
 * reader drops the whole list rather than one row.
 *
 * Distinct from {@link workspaceResponse}, which answers the RESOLVE routes and
 * carries the object backing, the git block and the sandbox status. Sending a
 * resolve projection to a list caller is what this exists to stop.
 *
 * Carries no `placement`, which bounds where it may be served. A `cloud-vm` row
 * needs none — a client reads it as the provisioner's machine, which has no
 * enrollment. A `local-worktree` row does: a client reads a machine with no
 * `placement.host_enrollment_id` as one it cannot reach, and renders it offline.
 * The enrollment id is the SERVING host's own identity, not a fact this store
 * holds, so a route that lists machine-placed rows to a client must add it here
 * rather than call this and hope.
 */
export function controlPlaneListRow(ws: Workspace) {
  const backing = workspaceBacking(ws)
  const { directory } = workspacePlacement(ws)
  return {
    workspace_id: ws.id,
    project_id: ws.project_id ?? ws.id,
    backing: backing.kind,
    ...(ws.workspace_name ? { display_name: ws.workspace_name } : {}),
    ...(directory ? { remote_directory: directory } : {}),
  }
}

/** Product-neutral JSON projection returned by workspace resolve routes. */
export function workspaceResponse(ws: Workspace | undefined, statusOverride?: string) {
  if (!ws) return undefined
  const backing = workspaceBacking(ws)
  return {
    workspaceId: ws.id,
    projectId: ws.project_id ?? ws.id,
    directory: backing.kind === "local-worktree" ? ws.directory : (ws.remote_directory ?? ws.directory),
    workspaceName: ws.workspace_name ?? null,
    backing,
    kind: ws.kind,
    driver: ws.driver ?? null,
    status: statusOverride ?? ws.status ?? null,
    git: {
      repo: ws.repo_name ?? null,
      branch: ws.git_branch ?? null,
      remote: ws.git_remote ?? null,
    },
  }
}

export type WorkspaceResponse = NonNullable<ReturnType<typeof workspaceResponse>>
