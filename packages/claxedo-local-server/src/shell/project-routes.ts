import { Hono, type Context } from "hono"
import { z } from "zod"
import { listProjects, resolveWorkspace, updateProjectMetadata } from "@claxedo/server-core/workspace/store/index"
import { ControlPlaneAuthError, controlPlaneAuthContext, controlPlaneAuthConfig, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import type { ControlPlaneRouteAuthOptions } from "../platform/http/control-plane-route-auth"
import { projectAccess } from "../platform/auth/project-access"
import { workspaceInput } from "./request-context"

type ProjectRouteOptions = ControlPlaneRouteAuthOptions & { services?: ControlPlaneServicesContract }
const metadataUpdate = z.object({
  name: z.string().optional(),
  icon: z.object({ color: z.string().optional(), override: z.string().optional() }).strict().optional(),
  commands: z.object({ start: z.string().optional() }).strict().optional(),
}).strict()

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
    .get("/project", async (c) => {
      const access = await shellProjectAccess(c.req.raw, options)
      const projects = await listProjects()
      const visible = []
      for (const project of projects) if (await access.allowed(project.id, "read")) visible.push(project)
      return c.json(visible)
    })
    .get("/project/current", (c) => currentProject(c, options, false))
    /**
     * The ensure form of `/project/current`, on the verb that may write.
     * Creation stays local-only: a directory the caller names is theirs by
     * definition only in the unsigned product, and a signed caller's project
     * is created through `POST /api/claxedo/projects`, which registers it with
     * their authority. A signed POST resolves exactly like the GET.
     */
    .post("/project/current", (c) => currentProject(c, options, true))
    .patch("/project/:projectId", async (c) => {
      const access = await shellProjectAccess(c.req.raw, options)
      const id = c.req.param("projectId")
      if (!await access.allowed(id, "write")) return c.json({ error: { code: "project_access_denied", message: "Project write access is required" } }, 403)
      const parsed = metadataUpdate.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ error: { code: "project_metadata_invalid", message: "Project metadata must contain only name, icon, and commands string fields" } }, 400)
      const project = await updateProjectMetadata(id, parsed.data)
      if (!project) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      return c.json(project)
    })
}

async function currentProject(c: Context, options: ProjectRouteOptions, create: boolean) {
  const access = await shellProjectAccess(c.req.raw, options)
  const input = workspaceInput(c)
  const workspace = await resolveWorkspace({ workspaceId: input.workspaceId, directory: input.directory, create: create && access.local && !!input.directory })
  const id = workspace?.project_id ?? workspace?.id
  if (!id || !await access.allowed(id, "read")) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
  const project = (await listProjects()).find((item) => item.id === id)
  if (!project) return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
  return c.json(project)
}
