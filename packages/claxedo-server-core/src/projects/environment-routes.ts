import { Hono, type Context } from "hono"
import { z } from "zod"
import { routeParam } from "@claxedo/helpers/route-param"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import { SINGLE_TENANT_ORG } from "../credentials/partition"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "../platform/auth/auth"
import { requireAuthority, type ProjectRole, type WorkspaceAuthority } from "../platform/auth/authority"
import { asProjectId } from "../platform/auth/branded-id"
import { errorBody } from "../platform/http/http"
import { ProjectEnvironmentError, projectEnvironment } from "./environment"

export type ProjectEnvironmentRouteOptions = {
  /** The signed caller, or `undefined` for the unsigned local product, where the one person at the keyboard owns every project. */
  authenticate: (request: Request) => Promise<SignedControlPlaneAuth | undefined>
  authority?: WorkspaceAuthority
  /** The credential store of the organization a project belongs to. */
  credentials: (orgId: string) => ControlPlaneCredentials
}

const setBody = z.object({ value: z.string().min(1) }).strict()

const EDITORS: readonly ProjectRole[] = ["admin", "owner"]

/**
 * `/api/claxedo/projects/:id/environment`: the names of a project's variables
 * for anyone who can read the project, and setting or removing one for its
 * admins and owners. A value is write-only; no answer carries one.
 */
export function ProjectEnvironmentRoutes(options: ProjectEnvironmentRouteOptions) {
  const reach = async (c: Context, action: "read" | "admin") => {
    const projectId = routeParam(c, "id")
    const auth = await options.authenticate(c.req.raw)
    if (!auth) return { projectId, org: SINGLE_TENANT_ORG, editable: true }
    const granted = await requireAuthority(options).authorizeProject(auth, { projectId: asProjectId(projectId), action })
    if (!granted.ok) return undefined
    return { projectId, org: granted.orgId, editable: EDITORS.includes(granted.role) }
  }
  const listing = async (target: { projectId: string; org: string; editable: boolean }) => ({
    names: await projectEnvironment(options.credentials(target.org), target.org).names(target.projectId),
    editable: target.editable,
  })
  const denied = (c: Context, action: "read" | "admin") =>
    c.json(errorBody("project_access_denied", action === "read" ? "No such project" : "Only the project's admins and owners can change its environment"), action === "read" ? 404 : 403)

  return new Hono()
    .onError((error, c) => {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      if (error instanceof ProjectEnvironmentError) return c.json(errorBody(error.code, error.message), 400)
      throw error
    })
    .get("/:id/environment", async (c) => {
      const target = await reach(c, "read")
      return target ? c.json(await listing(target)) : denied(c, "read")
    })
    .put("/:id/environment/:name", async (c) => {
      const target = await reach(c, "admin")
      if (!target) return denied(c, "admin")
      const body = setBody.safeParse(await c.req.json().catch(() => undefined))
      if (!body.success) return c.json(errorBody("project_env_invalid", "a non-empty value is required"), 400)
      await projectEnvironment(options.credentials(target.org), target.org).set(target.projectId, routeParam(c, "name"), body.data.value)
      return c.json(await listing(target))
    })
    .delete("/:id/environment/:name", async (c) => {
      const target = await reach(c, "admin")
      if (!target) return denied(c, "admin")
      await projectEnvironment(options.credentials(target.org), target.org).remove(target.projectId, routeParam(c, "name"))
      return c.json(await listing(target))
    })
}
