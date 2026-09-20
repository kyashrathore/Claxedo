import { Hono } from "hono"
import { listWorkspaces, resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { workspaceBacking } from "@claxedo/server-core/workspace/store/backing"
import { controlPlaneListRow, workspaceResponse } from "@claxedo/server-core/workspace/store/response"
import {
  controlPlaneRouteAuth,
  type ControlPlaneRouteAuthOptions,
} from "../../platform/http/control-plane-route-auth"

export function LocalWorkspaceRoutes(options: ControlPlaneRouteAuthOptions = {}) {
  return new Hono()
    /**
     * The control-plane workspace LIST, as this daemon can answer it.
     *
     * Rows are `controlPlaneListRow`, the shape every client narrows by
     * comparing a bare `backing` word; the resolve projection's object
     * `backing` matches neither word, so a client drops the WHOLE list rather
     * than the one row it cannot read.
     *
     * Only the provisioner's rows are listable here, whatever scope is asked.
     * A control-plane list row is addressed by its placement, and this store
     * holds one machine's inventory: a `cloud-vm` row is the provisioner's and
     * a client needs no enrollment to reach it, while a worktree on THIS
     * machine is reached over loopback through the project inventory and
     * carries no `placement.host_enrollment_id` here, so a client would render
     * every one of them offline.
     *
     * `user-hosted` is accepted and answers nothing: a workspace on somebody
     * else's machine is the authority's record, and a daemon has no authority
     * to ask.
     */
    .get("/", controlPlaneRouteAuth(options), async (c) => {
      const access = c.req.query("access")
      if (access && access !== "local" && access !== "cloud" && access !== "user-hosted") {
        return c.json({ error: { code: "workspace_access_invalid", message: "workspace access is invalid" } }, 400)
      }
      if (access === "local" || access === "user-hosted") return c.json({ workspaces: [] })
      const workspaces = (await listWorkspaces())
        .filter((workspace) => workspaceBacking(workspace).kind === "cloud-vm")
        .map(controlPlaneListRow)
      return c.json({ workspaces })
    })
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
      return c.json(workspaceResponse(workspace))
    })
}
