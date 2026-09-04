import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Hono } from "hono"
import { z } from "zod"
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
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"

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

const execFileAsync = promisify(execFile)

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

function safeRepoUrl(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "ssh:" ? input : undefined
  } catch {
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(input) ? input : undefined
  }
}

export type CloneOptions = {
  /** An `Authorization` header value for the repository's host, never placed in argv. */
  authorization?: string
  host?: string
}

async function cloneRepository(repoUrl: string, directory: string, options: CloneOptions = {}) {
  await fs.mkdir(path.dirname(directory), { recursive: true })
  // The credential rides in git's config environment, not on the command
  // line, so it is invisible to `ps` and never lands in the clone's config.
  const env = options.authorization && options.host
    ? {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.https://${options.host}/.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: ${options.authorization}`,
        GIT_TERMINAL_PROMPT: "0",
      }
    : { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  await execFileAsync("git", ["clone", "--", repoUrl, directory], { env })
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
 */
export type LocalProjectWorkspaceRegistration = {
  workspaceId: string
  displayName: string
  directory: string
  repoUrl?: string
}

export type LocalProjectRouteDeps = {
  clone?: typeof cloneRepository
  /**
   * Registers the workspace with the signed caller's authority. Supplied by
   * signed compositions only; the unsigned local product has no authority and
   * no caller identity, and the route skips registration there.
   */
  registerWorkspace?: (auth: SignedControlPlaneAuth, workspace: LocalProjectWorkspaceRegistration) => Promise<void>
  /**
   * A credential for cloning `repoUrl` as the signed caller — the token of
   * their connected GitHub account, say — or `undefined` to clone anonymously.
   * Signed compositions supply it from the connections host.
   */
  cloneCredential?: (auth: SignedControlPlaneAuth, repoUrl: string) => Promise<{ authorization: string } | undefined>
}

export function LocalProjectRoutes(options: ControlPlaneRouteAuthOptions = {}, deps: LocalProjectRouteDeps = {}) {
  const clone = deps.clone ?? cloneRepository
  return new Hono()
    .get("/", controlPlaneRouteAuth(options), async (c) => {
      const records = await listProjectRecords()
      const projects = await Promise.all(records.map((record) => projectView(record.id)))
      return c.json({ projects: projects.filter(Boolean) })
    })
    .post("/", controlPlaneRouteAuth(options), async (c) => {
      const parsed = createBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json(apiError("project_invalid", "name and a directory or repository source are required"), 400)
      const body = parsed.data
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
          const auth = signedRouteAuth(c.req.raw)
          const credential = auth && deps.cloneCredential ? await deps.cloneCredential(auth, repoUrl) : undefined
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
      const auth = signedRouteAuth(c.req.raw)
      if (auth && deps.registerWorkspace) {
        try {
          await deps.registerWorkspace(auth, {
            workspaceId: workspace.id,
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
      const directory = c.req.query("directory")?.trim()
      if (!directory) return c.json(apiError("project_invalid", "directory is required"), 400)
      const workspace = await getWorkspaceByDirectory(directory)
      const view = workspace?.project_id ? await projectView(workspace.project_id) : undefined
      return view ? c.json({ project: view }) : c.json(apiError("project_not_found", "No project at that directory"), 404)
    })
    .patch("/:id", controlPlaneRouteAuth(options), async (c) => {
      const id = c.req.param("id")
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
