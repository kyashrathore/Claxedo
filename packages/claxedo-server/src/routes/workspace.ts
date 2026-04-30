import fs from "fs/promises"
import path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Hono } from "hono"
import { z } from "zod"

const execFileAsync = promisify(execFile)
import { dataDir } from "../paths"
import { defaultSandboxProvider, hasSandboxAuth, listSandboxProviders, sandboxProvider } from "../cloud/sandbox"
import { loadUserConfig, saveUserConfig } from "../agent-config"
import { putCredential, deleteCredentialsByProvider } from "../credentials/registry"
import { ensureHostForUrl } from "../network/policy"
import { deleteWorkspace, ensureWorkspace, getProjectWorkspace, listProjects, resolveWorkspace } from "../workspace-store"
import { discardWorkspaceRuntime, ensureWorkspaceRuntime, getWorkspaceRuntimeStatus } from "../workspace-supervisor"
import { Log } from "../log"

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

const ensureBody = z.object({
  workspaceId: z.string().optional(),
  directory: z.string().optional(),
})

const log = Log.create({ service: "workspace-routes" })

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

function workspaceJson(ws: Awaited<ReturnType<typeof resolveWorkspace>>) {
  if (!ws) return
  const live = getWorkspaceRuntimeStatus(ws.id)
  const stopped = live === "stopped" ? "stopped" : undefined
  return {
    workspaceId: ws.id,
    projectId: ws.project_id ?? ws.id,
    directory: ws.directory,
    kind: ws.kind,
    provider: ws.provider ?? null,
    sandboxId: ws.sandbox_id ?? null,
    status: stopped ?? ws.status ?? null,
    git: {
      repo: ws.repo_name ?? null,
      branch: ws.git_branch ?? null,
      remote: ws.git_remote ?? null,
    },
  }
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

      // Store sandbox provider credentials in the credential registry
      try {
        const secret = id === "modal"
          ? JSON.stringify(body.auth)
          : body.auth.api_key ?? Object.values(body.auth)[0] ?? ""
        if (secret) {
          await putCredential({
            provider_id: id,
            kind: "sandbox_provider",
            source: "managed",
            label: `Sandbox provider ${id}`,
            secret,
          })
        }
      } catch {
        // Fallback to legacy config if backend unavailable
        cfg.sandbox = {
          ...cfg.sandbox,
          auth: { ...cfg.sandbox?.auth, [id]: body.auth },
        }
      }

      cfg.sandbox = {
        ...cfg.sandbox,
        default_provider: body.default ? id : cfg.sandbox?.default_provider,
      }
      await saveUserConfig(cfg)
      return c.json(listSandboxProviders(cfg.sandbox))
    })
    .delete("/providers/:id/auth", async (c) => {
      const id = sandboxProvider(c.req.param("id"))
      if (!id) return c.json({ error: "Unsupported provider" }, 400)
      const cfg = await loadUserConfig()

      // Delete from credential registry
      await deleteCredentialsByProvider(id).catch(() => {})

      // Also clean up legacy config if present
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
      return c.json(workspaceJson(ws))
    })
    .get("/", async (c) => c.json(await listProjects()))
    .delete("/:id", async (c) => {
      const id = c.req.param("id")
      const ws = await resolveWorkspace({ workspaceId: id })
      if (!ws) return c.json({ error: "Workspace not found" }, 404)
      await discardWorkspaceRuntime(id, "workspace_deleted").catch(() => {})
      await deleteWorkspace(id)
      if (ws.kind === "cloud") {
        await fs.rm(ws.directory, { recursive: true, force: true }).catch(() => {})
      }
      return c.json({ ok: true })
    })
    .post("/ensure", async (c) => {
      const body = ensureBody.parse(await c.req.json().catch(() => ({})))
      const ws = await resolveWorkspace({
        workspaceId: body.workspaceId,
        directory: body.directory,
      })
      if (!ws) return c.json({ error: "Workspace not found" }, 404)
      if (ws.kind === "cloud") {
        const err = await ensureWorkspaceRuntime(ws.id).then(
          () => undefined,
          (err) => err,
        )
        if (err) {
          return c.json(
            {
              error: "workspace runtime unavailable",
              detail: err instanceof Error ? err.message : String(err),
              workspaceId: ws.id,
              directory: ws.directory,
            },
            503,
          )
        }
      }
      const next = await resolveWorkspace({ workspaceId: ws.id })
      if (!next) return c.json({ error: "Workspace not found" }, 404)
      return c.json(workspaceJson(next))
    })
    .post("/create", async (c) => {
      const body = createBody.parse(await c.req.json().catch(() => ({})))
      const cfg = await loadUserConfig()
      const id = sandboxProvider(body.provider) ?? defaultSandboxProvider(cfg.sandbox)
      log.info("Create cloud workspace requested", {
        provider: id,
        requestedProvider: body.provider,
        projectId: body.projectId,
        workspaceName: body.workspaceName,
        hasRepoUrl: !!body.repoUrl?.trim(),
        hasAuth: hasSandboxAuth(cfg.sandbox, id),
      })
      if (!hasSandboxAuth(cfg.sandbox, id)) {
        log.warn("Create cloud workspace rejected: missing credentials", {
          provider: id,
          projectId: body.projectId,
          workspaceName: body.workspaceName,
        })
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

      // Auto-add git host to network allowlist so sandbox can clone
      if (repoUrl) {
        ensureHostForUrl(repoUrl, `workspace:${repoUrl}`)
      }

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
      log.info("Create cloud workspace stored", {
        workspaceId: ws.id,
        projectId,
        directory: ws.directory,
        provider: id,
        repoUrl,
        remoteDirectory: remote_directory,
      })

      // Start provisioning immediately (fire-and-forget)
      // Frontend subscribes to /api/claxedo/events for provision progress
      void ensureWorkspaceRuntime(ws.id).catch(async (err) => {
        log.warn("Create cloud workspace provisioning failed", {
          workspaceId: ws.id,
          provider: id,
          error: err instanceof Error ? err.message : String(err),
        })
        await discardWorkspaceRuntime(ws.id, "provision_failed").catch(() => {})
        await deleteWorkspace(ws.id).catch(() => {})
      })

      return c.json(workspaceJson(ws))
    })
}
