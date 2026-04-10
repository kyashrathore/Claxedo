import fs from "fs/promises"
import path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Hono } from "hono"
import { z } from "zod"

const execFileAsync = promisify(execFile)
import { dataDir } from "../paths"
import { defaultSandboxProvider, listSandboxProviders, sandboxAuth, sandboxProvider } from "../cloud/provider"
import { loadUserConfig, saveUserConfig } from "../agent-config"
import { ensureWorkspace, getProjectWorkspace, listProjects, resolveWorkspace } from "../workspace-store"
import { ensureWorkspaceRuntime } from "../workspace-supervisor"

const authBody = z.object({
  auth: z.record(z.string(), z.string()).default({}),
  default: z.boolean().optional(),
})

const defaultBody = z.object({
  provider: z.string(),
})

const createBody = z.object({
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  workspaceName: z.string().optional(),
  repoUrl: z.string().optional(),
  provider: z.string().optional(),
  provision: z.boolean().optional(),
})

function slug(input: string | undefined, alt: string) {
  const txt = (input ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return txt || alt
}

async function cloneRepo(repo: string, dir: string) {
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await execFileAsync("git", ["clone", repo, dir])
}

async function addWorktree(base: string, dir: string) {
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await execFileAsync("git", ["-C", base, "worktree", "add", dir])
}

export function WorkspaceRoutes() {
  return new Hono()
    .get("/providers", async (c) => {
      const cfg = await loadUserConfig()
      return c.json(listSandboxProviders(cfg.sandbox))
    })
    .put("/providers/default", async (c) => {
      const body = defaultBody.parse(await c.req.json().catch(() => ({})))
      const provider = sandboxProvider(body.provider)
      if (!provider) return c.json({ error: "Unsupported provider" }, 400)
      const cfg = await loadUserConfig()
      cfg.sandbox = {
        ...cfg.sandbox,
        default_provider: provider,
      }
      await saveUserConfig(cfg)
      return c.json(listSandboxProviders(cfg.sandbox))
    })
    .put("/providers/:id/auth", async (c) => {
      const id = sandboxProvider(c.req.param("id"))
      if (!id) return c.json({ error: "Unsupported provider" }, 400)
      const body = authBody.parse(await c.req.json().catch(() => ({})))
      const cfg = await loadUserConfig()
      cfg.sandbox = {
        ...cfg.sandbox,
        default_provider: body.default ? id : cfg.sandbox?.default_provider,
        auth: {
          ...cfg.sandbox?.auth,
          [id]: body.auth,
        },
      }
      await saveUserConfig(cfg)
      return c.json(listSandboxProviders(cfg.sandbox))
    })
    .delete("/providers/:id/auth", async (c) => {
      const id = sandboxProvider(c.req.param("id"))
      if (!id) return c.json({ error: "Unsupported provider" }, 400)
      const cfg = await loadUserConfig()
      const auth = { ...cfg.sandbox?.auth }
      delete auth[id]
      cfg.sandbox = {
        ...cfg.sandbox,
        auth,
        default_provider: cfg.sandbox?.default_provider === id ? undefined : cfg.sandbox?.default_provider,
      }
      await saveUserConfig(cfg)
      return c.json(listSandboxProviders(cfg.sandbox))
    })
    .get("/resolve", async (c) => {
      const ws = await resolveWorkspace({
        workspaceId: c.req.query("workspaceId") || c.req.query("workspace"),
        directory: c.req.query("directory"),
        create: c.req.query("create") === "true",
      })
      if (!ws) return c.json({ error: "Workspace not found" }, 404)
      return c.json({
        workspaceId: ws.id,
        projectId: ws.project_id ?? ws.id,
        directory: ws.directory,
        kind: ws.kind,
        provider: ws.provider ?? null,
        sandboxId: ws.sandbox_id ?? null,
        status: ws.status ?? null,
        git: {
          repo: ws.repo_name ?? null,
          branch: ws.git_branch ?? null,
          remote: ws.git_remote ?? null,
        },
      })
    })
    .get("/", async (c) => c.json(await listProjects()))
    .post("/create", async (c) => {
      const body = createBody.parse(await c.req.json().catch(() => ({})))
      const cfg = await loadUserConfig()
      const id = sandboxProvider(body.provider) ?? defaultSandboxProvider(cfg.sandbox)
      if (!sandboxAuth(cfg.sandbox, id)) {
        return c.json({ error: `Missing ${id} credentials` }, 400)
      }

      const workspaceId = `ws_${Date.now().toString(36)}`
      const projectId = body.projectId?.trim() || workspaceId
      const base = path.join(dataDir(), "cloud", "workspaces")
      const name = slug(body.workspaceName, "main")
      const dir = body.projectId
        ? path.join(base, projectId, name)
        : path.join(base, workspaceId, name)

      // For cloud workspaces: no local clone/worktree needed.
      // The repo will be cloned inside the Daytona sandbox.
      // Just resolve the repo URL and create a placeholder directory.
      let repoUrl = body.repoUrl?.trim()

      if (!repoUrl && body.projectId) {
        const root = await getProjectWorkspace(body.projectId)
        if (!root) return c.json({ error: "Project workspace not found" }, 404)
        repoUrl = root.git_remote || root.repo_url
        if (!repoUrl) {
          return c.json({ error: "Project has no remote URL to clone in sandbox" }, 400)
        }
      }

      if (!repoUrl) {
        return c.json({ error: "repoUrl or projectId is required" }, 400)
      }

      await fs.mkdir(dir, { recursive: true })

      let sandbox_id: string | undefined
      let status = "pending_sandbox"
      const remote_directory = "/workspace"

      const repoName = repoUrl ? path.basename(repoUrl).replace(/\.git$/, "") : undefined
      const ws = await ensureWorkspace({
        workspaceId,
        project_id: projectId,
        project_name: body.projectName?.trim() || repoName || path.basename(dir),
        workspace_name: name,
        directory: dir,
        kind: "cloud",
        provider: id,
        repo_url: repoUrl,
        sandbox_id,
        remote_directory,
        status,
      })
      if (!ws) return c.json({ error: "failed to create workspace" }, 500)

      // Start provisioning immediately (fire-and-forget)
      // Frontend subscribes to /api/claxedo/events for provision progress
      ensureWorkspaceRuntime(ws.id).catch(() => {})

      return c.json({
        workspaceId: ws.id,
        projectId: ws.project_id ?? ws.id,
        directory: ws.directory,
        provider: ws.provider,
        kind: ws.kind,
        sandboxId: ws.sandbox_id ?? null,
        status: ws.status ?? null,
        git: {
          repo: ws.repo_name ?? null,
          branch: ws.git_branch ?? null,
          remote: ws.git_remote ?? null,
        },
      })
    })
}
