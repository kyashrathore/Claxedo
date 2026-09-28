import { Hono } from "hono"
import { listProjects, resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { ControlPlaneAuthError, controlPlaneAuthContext, controlPlaneAuthConfig, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import type { ControlPlaneRouteAuthOptions } from "../platform/http/control-plane-route-auth"
import { projectAccess } from "@claxedo/server-core/projects/access"
import { workspaceInput } from "./request-context"

type ProjectRouteOptions = ControlPlaneRouteAuthOptions & { services?: ControlPlaneServicesContract }

/** These routes carry no bearer gate of their own, so they authenticate the request here. */
async function shellProjectAccess(request: Request, options: ProjectRouteOptions) {
  const auth = await controlPlaneAuthContext(request, { config: options.authConfig ?? controlPlaneAuthConfig(), verifier: options.verifier })
  return projectAccess(auth.mode === "signed" ? auth : undefined, options.services)
}

export function projectRoutes(options: ProjectRouteOptions) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    })
    .get("/project/current", async (c) => {
      const access = await shellProjectAccess(c.req.raw, options)
      const input = workspaceInput(c)
      const workspace = await resolveWorkspace({ workspaceId: input.workspaceId, directory: input.directory })
      const id = workspace?.project_id ?? workspace?.id
      if (!id || !await access.allowed(id, "read")) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      const project = (await listProjects()).find((item) => item.id === id)
      if (!project) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      return c.json(project)
    })
}
