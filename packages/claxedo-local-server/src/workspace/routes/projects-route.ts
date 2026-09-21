import fs from "node:fs/promises"
import path from "node:path"
import { Hono } from "hono"
import { z } from "zod"
import { createBoundedGit } from "@claxedo/workspace-runtime/host"
import { safeRepoUrl } from "@claxedo/sandbox-contract"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { projectEnvProblem } from "@claxedo/server-core/workspace/project-env"
import {
  ensureWorkspace,
  findProjectRecordByName,
  getProjectRecord,
  getProjectWorkspace,
  getWorkspaceByDirectory,
  listProjectRecords,
  upsertProjectRecord,
} from "@claxedo/server-core/workspace/store/index"
import { controlPlaneRouteAuth, signedRouteAuth, type ControlPlaneRouteAuthOptions } from "../../platform/http/control-plane-route-auth"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { projectAccess } from "../../platform/auth/project-access"

/**
 * Projects on a server with its own filesystem.
 *
 * A project is a repository and a name; where it executes is a workspace. On
 * this server every project has a checkout on disk: a folder the caller
 * already has here, or a repository cloned into `<dataDir>/projects/<slug>` at
 * creation. That checkout is the project's local worktree; cloud sandboxes
 * for the same project are provisioned from the repository separately and
 * start with the project's `env`.
 *
 * Names are unique per server (case-insensitive).
 */

/**
 * Cloning a repository takes as long as the repository is large, so it runs on
 * a pool of its own: on the shared runner a clone would hold a slot the file
 * tree and diff routes are waiting for.
 */
const CLONE_TIMEOUT_MS = 30 * 60_000
const cloneGit = createBoundedGit({ timeoutMs: CLONE_TIMEOUT_MS })

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("directory"), directory: z.string().trim().min(1) }).strict(),
      z.object({ kind: z.literal("repository"), repoUrl: z.string().trim().min(1) }).strict(),
    ]),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export function projectSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

export function projectsDirectory() {
  return path.join(dataDir(), "projects")
}

export type CloneOptions = {
  /** An `Authorization` header value for the repository's host, never placed in argv. */
  authorization?: string
  host?: string
}

async function cloneRepository(repoUrl: string, directory: string, options: CloneOptions = {}) {
  const parent = path.dirname(directory)
  await fs.mkdir(parent, { recursive: true })
  await cloneGit(["clone", "--", repoUrl, directory], parent, {
    ...(options.authorization && options.host
      ? { credential: { host: options.host, authorization: options.authorization } }
      : {}),
  })
}

/** GitHub's token-in-basic-auth form for `x-access-token`, as the cloud clone path uses. */
export function githubCloneAuthorization(token: string) {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
}

function repositoryHost(repoUrl: string) {
  try {
    return new URL(repoUrl).hostname || undefined
  } catch {
    return undefined
  }
}

function apiError(code: string, message: string) {
  return { error: { code, message } }
}

async function projectView(id: string) {
  const record = await getProjectRecord(id)
  const workspace = await getProjectWorkspace(id)
  if (!record) return undefined
  return {
    id: record.id,
    name: record.name,
    env: record.env ?? {},
    directory: workspace?.directory ?? null,
    repoUrl: workspace?.repo_url ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
}

/**
 * A local project's workspace as the signed authority should know it. On a
 * signed server every engine call for a directory is authorised against the
 * authority's workspace membership (`resolveRelayActor` in the self-hosted
 * app), so a folder project must exist there too or it can never be opened.
 *
 * `projectId` is the local store's project id, and the authority must file the
 * workspace under that same id: the signed `/project` list authorises each
 * local project by its own id (`authorizeProject`), so a workspace registered
 * under a freshly minted authority project leaves its project invisible to the
 * caller who just created it.
 */
export type LocalProjectWorkspaceRegistration = {
  workspaceId: string
  projectId: string
  displayName: string
  directory: string
  repoUrl?: string
}

export type LocalProjectRouteDeps = {
  clone?: typeof cloneRepository
  /**
   * Answers which of this server's projects the signed caller holds a role on.
   * Signed compositions supply it; a signed request is refused rather than
   * served, because the store here is machine-global and nothing else in it
   * tells one account's projects from another's.
   */
  authority?: WorkspaceAuthority
  /**
   * Machine-wide operator authorization, throwing `ControlPlaneAuthError` for a
   * signed caller who does not hold it. A caller-named folder is an arbitrary
   * path on this server's filesystem that belongs to no project yet, so no
   * project role can decide it — only authority over the machine can.
   */
  authorizeLocalDirectoryImport?: (auth: SignedControlPlaneAuth) => void
  /**
   * Registers the workspace with the signed caller's authority. Required of a
   * signed composition and checked before the first write, since it is the only
   * thing that makes a created project reachable by the account that asked for
   * it. The unsigned local product has no authority and no caller identity, and
   * registers nothing.
   */
  registerWorkspace?: (auth: SignedControlPlaneAuth, workspace: LocalProjectWorkspaceRegistration) => Promise<void>
  /**
   * A credential for cloning `repoUrl` as the signed caller — the token of
   * their connected GitHub account, say — or `undefined` to clone anonymously.
   * Signed compositions supply it from the connections host.
   */
  cloneCredential?: (auth: SignedControlPlaneAuth, repoUrl: string) => Promise<{ authorization: string } | undefined>
}

/** This router's caller is the one its per-route bearer gate already verified. */
function verifiedCallerAccess(request: Request, deps: LocalProjectRouteDeps) {
  return projectAccess(signedRouteAuth(request), deps)
}

/**
 * What a signed composition must hold before this route writes anything: an
 * authority for the new workspace to belong to, and the registration that makes
 * it belong there. Both are checked before the first filesystem or clone write,
 * because a project registered for nobody is one this server cloned, wrote to
 * disk and stored while its creator — and every other account — is refused it.
 *
 * `undefined` is the unsigned local product: no caller to bind the workspace
 * to, and nothing to register it with.
 */
function callerRegistration(request: Request, deps: LocalProjectRouteDeps) {
  const auth = signedRouteAuth(request)
  if (!auth) return undefined
  requireAuthority(deps)
  const register = deps.registerWorkspace
  if (!register) {
    throw new ControlPlaneAuthError(503, "authority_unavailable", "Project registration is not configured for signed callers")
  }
  return { auth, register: (workspace: LocalProjectWorkspaceRegistration) => register(auth, workspace) }
}

export function LocalProjectRoutes(options: ControlPlaneRouteAuthOptions = {}, deps: LocalProjectRouteDeps = {}) {
  const clone = deps.clone ?? cloneRepository
  return new Hono()
    .onError((error, c) => {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    })
    .get("/", controlPlaneRouteAuth(options), async (c) => {
      const access = verifiedCallerAccess(c.req.raw, deps)
      const records = await listProjectRecords()
      const projects = []
      for (const record of records) {
        if (!(await access.allowed(record.id, "read"))) continue
        const view = await projectView(record.id)
        if (view) projects.push(view)
      }
      return c.json({ projects })
    })
    .post("/", controlPlaneRouteAuth(options), async (c) => {
      const parsed = createBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json(apiError("project_invalid", "name and a directory or repository source are required"), 400)
      const body = parsed.data
      const importer = body.source.kind === "directory" ? signedRouteAuth(c.req.raw) : undefined
      if (importer) {
        if (!deps.authorizeLocalDirectoryImport) {
          throw new ControlPlaneAuthError(503, "authority_unavailable", "Deployment operator authorization is not configured")
        }
        deps.authorizeLocalDirectoryImport(importer)
      }
      const caller = callerRegistration(c.req.raw, deps)
      const envProblem = projectEnvProblem(body.env)
      if (envProblem) return c.json(apiError("project_env_invalid", envProblem), 400)
      if (await findProjectRecordByName(body.name)) {
        return c.json(apiError("project_name_taken", `A project named "${body.name}" already exists`), 409)
      }

      let directory: string
      let repoUrl: string | undefined
      if (body.source.kind === "directory") {
        directory = body.source.directory
        const stat = await fs.stat(directory).catch(() => undefined)
        if (!stat?.isDirectory()) return c.json(apiError("project_directory_missing", "That folder does not exist on this server"), 400)
        const existing = await getWorkspaceByDirectory(directory)
        const owner = existing?.project_id ? await getProjectRecord(existing.project_id) : undefined
        if (owner) {
          return c.json(apiError("project_directory_taken", `That folder is already the project "${owner.name}"`), 409)
        }
      } else {
        repoUrl = safeRepoUrl(body.source.repoUrl)
        if (!repoUrl) return c.json(apiError("project_repository_invalid", "That is not a repository URL this server can clone"), 400)
        const slug = projectSlug(body.name)
        if (!slug) return c.json(apiError("project_invalid", "name must contain a letter or digit"), 400)
        directory = path.join(projectsDirectory(), slug)
        if (await fs.stat(directory).catch(() => undefined)) {
          return c.json(apiError("project_directory_taken", `${directory} already exists on this server`), 409)
        }
        try {
          const credential = caller && deps.cloneCredential ? await deps.cloneCredential(caller.auth, repoUrl) : undefined
          const host = repositoryHost(repoUrl)
          await clone(repoUrl, directory, credential && host ? { authorization: credential.authorization, host } : {})
        } catch (cause) {
          await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
          const message = cause instanceof Error ? cause.message : String(cause)
          return c.json(apiError("project_clone_failed", `Cloning failed: ${message.split("\n").find((line) => line.trim()) ?? message}`), 502)
        }
      }

      const workspace = await ensureWorkspace({ directory, kind: "local", project_name: body.name, ...(repoUrl ? { repo_url: repoUrl } : {}) })
      if (!workspace?.project_id) {
        return c.json(apiError("project_not_git", "Only git repositories can be projects; that folder is not one"), 400)
      }
      if (caller) {
        try {
          await caller.register({
            workspaceId: workspace.id,
            projectId: workspace.project_id,
            displayName: body.name,
            directory,
            ...(repoUrl ? { repoUrl } : {}),
          })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          return c.json(apiError("project_register_failed", `The project could not be registered for your account: ${message}`), 502)
        }
      }
      const record = await upsertProjectRecord({ id: workspace.project_id, name: body.name, env: body.env ?? {} })
      return c.json({ project: await projectView(record.id) }, 201)
    })
    .get("/by-directory", controlPlaneRouteAuth(options), async (c) => {
      const access = verifiedCallerAccess(c.req.raw, deps)
      const directory = c.req.query("directory")?.trim()
      if (!directory) return c.json(apiError("project_invalid", "directory is required"), 400)
      const workspace = await getWorkspaceByDirectory(directory)
      const projectId = workspace?.project_id
      const view = projectId && await access.allowed(projectId, "read") ? await projectView(projectId) : undefined
      return view ? c.json({ project: view }) : c.json(apiError("project_not_found", "No project at that directory"), 404)
    })
    .patch("/:id", controlPlaneRouteAuth(options), async (c) => {
      const access = verifiedCallerAccess(c.req.raw, deps)
      const id = c.req.param("id")
      if (!await access.allowed(id, "write")) {
        return c.json(apiError("project_access_denied", "Project write access is required"), 403)
      }
      const existing = await getProjectRecord(id)
      if (!existing) return c.json(apiError("project_not_found", "No such project"), 404)
      const parsed = updateBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json(apiError("project_invalid", "name or env expected"), 400)
      const envProblem = projectEnvProblem(parsed.data.env)
      if (envProblem) return c.json(apiError("project_env_invalid", envProblem), 400)
      if (parsed.data.name) {
        const clash = await findProjectRecordByName(parsed.data.name)
        if (clash && clash.id !== id) return c.json(apiError("project_name_taken", `A project named "${parsed.data.name}" already exists`), 409)
      }
      const record = await upsertProjectRecord({
        id,
        name: parsed.data.name ?? existing.name,
        ...(parsed.data.env !== undefined ? { env: parsed.data.env } : {}),
      })
      return c.json({ project: await projectView(record.id) })
    })
}
