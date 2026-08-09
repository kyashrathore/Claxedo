import { Hono } from "hono"
import { workspaceBacking } from "@claxedo/server-core/workspace/store/backing"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import {
  controlPlaneRouteAuth,
  type ControlPlaneRouteAuthOptions,
} from "../../platform/http/control-plane-route-auth"

function localWorkspaceJson(workspace: NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>) {
  const backing = workspaceBacking(workspace)
  const access = backing.kind === "cloud-vm"
    ? "cloud"
    : backing.kind === "user-hosted"
      ? "user-hosted"
      : "local"
  return {
    workspaceId: workspace.id,
    projectId: workspace.project_id ?? workspace.id,
    directory: backing.kind === "local-worktree" ? workspace.directory : (workspace.remote_directory ?? workspace.directory),
    workspaceName: workspace.workspace_name ?? null,
    access,
    backing,
    kind: workspace.kind,
    driver: workspace.driver ?? null,
    status: workspace.status ?? null,
    git: {
      repo: workspace.repo_name ?? null,
      branch: workspace.git_branch ?? null,
      remote: workspace.git_remote ?? null,
    },
  }
}

export function LocalWorkspaceRoutes(options: ControlPlaneRouteAuthOptions = {}) {
  return new Hono()
    .use("/resolve", controlPlaneRouteAuth(options))
    .get("/resolve", async (c) => {
      const workspaceId = c.req.query("workspaceId") || c.req.query("workspace")
      const directory = c.req.query("directory")
      if (!workspaceId && !directory) {
        return c.json({
          error: {
            code: "workspace_resolve_input_required",
            message: "workspace resolve requires directory or workspaceId",
          },
        }, 400)
      }

      const workspace = await resolveWorkspace({
        workspaceId,
        directory,
        create: c.req.query("create") === "true",
      })
      if (!workspace) {
        return c.json({
          error: {
            code: "workspace_not_found",
            message: "Local workspace not found",
          },
        }, 404)
      }
      return c.json(localWorkspaceJson(workspace))
    })
}
