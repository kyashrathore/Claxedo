import { Hono } from "hono"
import { z } from "zod"
import { listProjects, resolveWorkspace, updateProjectMetadata } from "@claxedo/server-core/workspace/store/index"
import { ControlPlaneAuthError, controlPlaneAuthContext, controlPlaneAuthConfig, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type ProjectAction, type ProjectId } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import type { ControlPlaneRouteAuthOptions } from "../platform/http/control-plane-route-auth"
import { workspaceInput } from "./request-context"

type ProjectRouteOptions = ControlPlaneRouteAuthOptions & { services?: ControlPlaneServicesContract }
const metadataUpdate = z.object({
  name: z.string().optional(),
  icon: z.object({ color: z.string().optional(), override: z.string().optional() }).strict().optional(),
  commands: z.object({ start: z.string().optional() }).strict().optional(),
}).strict()

async function projectAccess(request: Request, options: ProjectRouteOptions) {
  const auth = await controlPlaneAuthContext(request, { config: options.authConfig ?? controlPlaneAuthConfig(), verifier: options.verifier })
  if (auth.mode !== "signed") return { local: true, allowed: async (_id: string, _action: ProjectAction) => true }
  const authority = requireAuthority(options.services)
  return {
    local: false,
    allowed: async (id: string, action: ProjectAction) => (await authority.authorizeProject(auth, { projectId: id as ProjectId, action })).ok,
  }
}

export function projectRoutes(options: ProjectRouteOptions) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    })
    .get("/project", async (c) => {
      const access = await projectAccess(c.req.raw, options)
      const projects = await listProjects()
      const visible = []
      for (const project of projects) if (await access.allowed(project.id, "read")) visible.push(project)
      return c.json(visible)
    })
    .get("/project/current", async (c) => {
      const access = await projectAccess(c.req.raw, options)
      const input = workspaceInput(c)
      const workspace = await resolveWorkspace({ workspaceId: input.workspaceId, directory: input.directory, create: access.local && !!input.directory })
      const id = workspace?.project_id ?? workspace?.id
      if (!id || !await access.allowed(id, "read")) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      const project = (await listProjects()).find((item) => item.id === id)
      if (!project) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      return c.json(project)
    })
    .patch("/project/:projectId", async (c) => {
      const access = await projectAccess(c.req.raw, options)
      const id = c.req.param("projectId")
      if (!await access.allowed(id, "write")) return c.json({ error: { code: "project_access_denied", message: "Project write access is required" } }, 403)
      const parsed = metadataUpdate.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ error: { code: "project_metadata_invalid", message: "Project metadata must contain only name, icon, and commands string fields" } }, 400)
      const project = await updateProjectMetadata(id, parsed.data)
      if (!project) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      return c.json(project)
    })
}
