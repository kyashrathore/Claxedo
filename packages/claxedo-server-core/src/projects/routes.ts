import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import { routeParam } from "@claxedo/helpers/route-param"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "../platform/auth/auth"
import { requireAuthority, type WorkspaceAuthority } from "../platform/auth/authority"
import { isClaxedoError } from "../platform/errors/base"
import { projectEnvProblem } from "../workspace/project-env"
import { projectAccess } from "./access"
import { resolveRepository, type RepositorySourceDeps } from "./repository-source"
import { PROJECT_NAME_MAX, ProjectStoreError, type ProjectSourceInput, type ProjectStore } from "./store"

/**
 * `/api/claxedo/projects`, served by the desktop's local server. A project is
 * a record with an id; a folder, a worktree or a cloud workspace is a
 * placement of it. Which
 * records the caller may reach is the deployment authority's answer
 * (`projectAccess`); how they are kept is the store's.
 */
export type ProjectRouteOptions = {
  store: ProjectStore
  /**
   * The signed caller, or `undefined` for the unsigned local product where one
   * person at the keyboard owns everything. Throws `ControlPlaneAuthError` for
   * a request the deployment refuses.
   */
  authenticate: (request: Request) => Promise<SignedControlPlaneAuth | undefined>
  /** Required wherever `authenticate` can answer a signed caller; a signed request without one is refused. */
  authority?: WorkspaceAuthority
  /**
   * Machine-wide operator authorization, throwing `ControlPlaneAuthError` for
   * a signed caller who does not hold it. A caller-named folder is an
   * arbitrary path on this server's filesystem that belongs to no project
   * yet, so no project role can decide it — only authority over the machine.
   */
  authorizeFolderSource?: (auth: SignedControlPlaneAuth) => void
  repositories?: RepositorySourceDeps
}

const repositoryUrlSource = z.object({ kind: z.literal("repository"), repoUrl: z.string().trim().min(1) }).strict()
const repositoryConnectionSource = z
  .object({
    kind: z.literal("repository"),
    connectionId: z.string().trim().min(1),
    repo: z.object({ fullName: z.string().trim().min(1) }).strict(),
  })
  .strict()

const createBody = z
  .object({
    name: z.string().trim().min(1).max(PROJECT_NAME_MAX).optional(),
    source: z.union([
      z.object({ kind: z.literal("directory"), directory: z.string().trim().min(1) }).strict(),
      repositoryUrlSource,
      repositoryConnectionSource,
    ]),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()

const updateBody = z
  .object({
    name: z.string().trim().max(PROJECT_NAME_MAX).optional(),
    env: z.record(z.string(), z.string()).optional(),
    icon: z.object({ color: z.string().optional(), override: z.string().optional() }).strict().optional(),
    commands: z.object({ start: z.string().optional() }).strict().optional(),
  })
  .strict()

function apiError(code: string, message: string) {
  return { error: { code, message } }
}

const ERROR_STATUSES = new Set<number>([400, 401, 402, 403, 404, 409, 422, 500, 501, 502, 503])

/** The status a thrown error names, when it is one an error body may carry. */
function errorStatus(status: number): ContentfulStatusCode {
  return (ERROR_STATUSES.has(status) ? status : 500) as ContentfulStatusCode
}

export function ProjectRoutes(options: ProjectRouteOptions) {
  const { store } = options
  const caller = async (c: Context) => {
    const auth = await options.authenticate(c.req.raw)
    return { auth, access: projectAccess(auth, options) }
  }

  const app = new Hono().onError((error, c) => {
    if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
    if (isClaxedoError(error)) return c.json(apiError(error.code, error.message), errorStatus(error.status))
    throw error
  })

  app.get("/", async (c) => {
    const { auth, access } = await caller(c)
    const projects = []
    for (const project of await store.list(auth)) {
      if (await access.allowed(project.id, "read")) projects.push(project)
    }
    return c.json({ projects })
  })

  app.post("/", async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json(apiError("project_invalid", "a directory or repository source is required"), 400)
    const body = parsed.data
    const auth = await options.authenticate(c.req.raw)
    if (auth) requireAuthority(options)
    if (body.source.kind === "directory") {
      if (!store.folders) {
        return c.json(apiError("project_source_unsupported", "A folder can only be a project's source on a machine with a filesystem"), 400)
      }
      if (auth) {
        if (!options.authorizeFolderSource) {
          throw new ControlPlaneAuthError(503, "authority_unavailable", "Deployment operator authorization is not configured")
        }
        options.authorizeFolderSource(auth)
      }
    }
    const envProblem = projectEnvProblem(body.env)
    if (envProblem) return c.json(apiError("project_env_invalid", envProblem), 400)
    const repository = body.source
    const source: ProjectSourceInput = repository.kind === "directory"
      ? repository
      : { kind: "repository", resolve: () => resolveRepository(repository, auth, options.repositories ?? {}) }
    const project = await store.create({ ...(body.name ? { name: body.name } : {}), source, ...(body.env ? { env: body.env } : {}) }, auth)
    return c.json({ project }, 201)
  })

  app.get("/:id", async (c) => {
    const { access } = await caller(c)
    const id = routeParam(c, "id")
    const project = (await access.allowed(id, "read")) ? await store.get(id) : undefined
    if (!project) return c.json(apiError("project_not_found", "No such project"), 404)
    return c.json({ project })
  })

  app.patch("/:id", async (c) => {
    const { auth, access } = await caller(c)
    const id = routeParam(c, "id")
    if (!(await access.allowed(id, "write"))) {
      return c.json(apiError("project_access_denied", "Project write access is required"), 403)
    }
    const parsed = updateBody.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json(apiError("project_invalid", "name, env, icon or commands expected"), 400)
    const envProblem = projectEnvProblem(parsed.data.env)
    if (envProblem) return c.json(apiError("project_env_invalid", envProblem), 400)
    const project = await store.update(id, parsed.data, auth)
    if (!project) return c.json(apiError("project_not_found", "No such project"), 404)
    return c.json({ project })
  })

  app.delete("/:id", async (c) => {
    const { auth, access } = await caller(c)
    const id = routeParam(c, "id")
    if (!(await access.allowed(id, "owner"))) {
      return c.json(apiError("project_access_denied", "Only the project's owner can remove it"), 403)
    }
    const removed = await store.remove(id, auth)
    if (!removed) return c.json(apiError("project_not_found", "No such project"), 404)
    return c.json({ deleted: true })
  })

  app.post("/:id/reclone", async (c) => {
    const { auth, access } = await caller(c)
    const id = routeParam(c, "id")
    if (!(await access.allowed(id, "write"))) {
      return c.json(apiError("project_access_denied", "Project write access is required"), 403)
    }
    const project = await store.reclone(id, (repoUrl) => resolveRepository({ kind: "repository", repoUrl }, auth, options.repositories ?? {}))
    if (!project) return c.json(apiError("project_not_found", "No such project"), 404)
    return c.json({ project })
  })

  return app
}

export { ProjectStoreError }
