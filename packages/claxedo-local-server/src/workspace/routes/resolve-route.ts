import { Hono } from "hono"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { workspaceResponse } from "@claxedo/server-core/workspace/store/response"
import {
  controlPlaneRouteAuth,
  type ControlPlaneRouteAuthOptions,
} from "../../platform/http/control-plane-route-auth"

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
      return c.json(workspaceResponse(workspace))
    })
}
