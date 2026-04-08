import { Hono } from "hono"
import os from "os"
import path from "path"
import fs from "fs"
import { randomUUID } from "crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { defaultRunner, listCommands, loadUserConfig, saveUserConfig } from "../agent-config"
import { rebuildOpencodeJsonc } from "../agent-hooks"
import { claxedoBus, globalBus } from "../bus"
import { fanOutConfig } from "../config-fanout"
import { getLocalAgentAdapter, listLocalSessions } from "../local-agent-engine"
import { applySessionMeta, GLOBAL_SHOW_TAG, GLOBAL_TAG, taggedSessionMetas } from "../session-meta"
import { normalize } from "../session-runner"
import { ClaxedoDB } from "../storage/db"
import { ClaxedoCloudSessionTable } from "../storage/cloud-session.sql"
import { ensureWorkspaceRuntime, listWorkspaceRuntimes } from "../workspace-supervisor"
import { deleteWorkspaceByDirectory, ensureWorkspace, getProjectWorkspace, listProjects, listWorkspaces, resolveWorkspace } from "../workspace-store"
import { dataDir, stateDir } from "../paths"
import { opencodeHeaders } from "../opencode-auth"

let upstream = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096"
const execFileAsync = promisify(execFile)

type Ctx = {
  req: {
    url: string
    raw: Request
    query: (key: string) => string | undefined
    header: (key: string) => string | undefined
    param: (key: string) => string
    method: string
  }
}

const CLAUDE_ACP_MODELS: Record<string, object> = {
  "claude-sonnet-4-6": { id: "claude-sonnet-4-6", providerID: "claude-acp", name: "Claude Sonnet 4.6", family: "claude-4", release_date: "2025-05-01", attachment: true, reasoning: false, temperature: true, tool_call: true, limit: { context: 200000, output: 64000 }, options: {}, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
  "claude-opus-4-6": { id: "claude-opus-4-6", providerID: "claude-acp", name: "Claude Opus 4.6", family: "claude-4", release_date: "2025-06-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 64000 }, options: {}, cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 } },
  "claude-haiku-4-5": { id: "claude-haiku-4-5", providerID: "claude-acp", name: "Claude Haiku 4.5", family: "claude-4", release_date: "2025-04-01", attachment: true, reasoning: false, temperature: true, tool_call: true, limit: { context: 200000, output: 64000 }, options: {}, cost: { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 } },
}

const CODEX_ACP_MODELS: Record<string, object> = {
}

const CURSOR_ACP_MODELS: Record<string, object> = {
}

function opencodeUrl() {
  return upstream
}

export function configureOpenCodeCompat(url: string) {
  upstream = url
}

function workspaceInput(c: Ctx) {
  return {
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
  }
}

function workspaceRoot(ws: Awaited<ReturnType<typeof resolveWorkspace>>, input: ReturnType<typeof workspaceInput>) {
  return ws?.directory ?? input.directory ?? process.cwd()
}

function workspacePath(root: string, input?: string) {
  const file = input?.trim()
  if (!file) return root
  return path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file)
}

function runner(c: Ctx, fallback = defaultRunner()) {
  const type = c.req.query("runner") || c.req.header("x-claxedo-runner") || fallback.type
  if (type !== "claude-acp" && type !== "codex-acp" && type !== "cursor-acp" && type !== "opencode") return fallback
  if (type === "opencode") return { type: "opencode" } as const
  return normalize({
    type,
    ...(c.req.header("x-claxedo-binary") ? { binary: c.req.header("x-claxedo-binary")! } : {}),
    ...(c.req.header("x-claxedo-model") ? { model: c.req.header("x-claxedo-model")! } : {}),
  })
}

function version() {
  return process.env.npm_package_version || "1.0.0"
}

function bootPath(directory?: string) {
  const dir = directory?.trim() ?? ""
  return {
    home: os.homedir(),
    state: stateDir(),
    config: dataDir(),
    worktree: dir,
    directory: dir,
  }
}

async function globSearch(
  searchDir: string,
  query: string,
  type: "file" | "directory" | "any",
  limit: number,
) {
  const out: string[] = []
  const q = query.trim().toLowerCase()
  const queue = [""]
  while (queue.length && out.length < limit) {
    const rel = queue.shift()!
    const abs = rel ? path.join(searchDir, rel) : searchDir
    let rows: fs.Dirent[]
    try {
      rows = (await fs.promises.readdir(abs, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))
    } catch {
      continue
    }
    for (const row of rows) {
      if (row.name === ".git" || row.name === ".DS_Store") continue
      const next = rel ? path.join(rel, row.name) : row.name
      const hit = !q || next.toLowerCase().includes(q)
      if (row.isDirectory()) {
        queue.push(next)
        if (type !== "file" && hit) out.push(next)
      }
      if (!row.isDirectory() && type !== "directory" && hit) out.push(next)
      if (out.length >= limit) break
    }
  }
  return out
}

async function proxyUpstream(c: Ctx, pathname: string) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
    create: !!input.directory,
  })
  const url = new URL(pathname + new URL(c.req.url).search, opencodeUrl())
  const headers = opencodeHeaders(c.req.raw.headers)
  headers.delete("host")
  headers.delete("connection")
  if (ws) {
    headers.set("x-opencode-directory", ws.directory)
    headers.set("x-workspace-id", ws.id)
  }
  const req = new Request(url.toString(), {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore
    duplex: "half",
  })
  const res = await fetch(req)
  const responseHeaders = new Headers(res.headers)
  // fetch() auto-decompresses the body, so strip encoding headers to avoid
  // the browser trying to decompress an already-decompressed body.
  responseHeaders.delete("content-encoding")
  responseHeaders.delete("content-length")
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
  })
}

async function maybeProxy(c: Ctx, pathname: string) {
  const user = await loadUserConfig()
  if (defaultRunner(user).type !== "opencode") return
  return proxyUpstream(c, pathname)
}

async function buildAcpProviderResponse() {
  const user = await loadUserConfig()
  const runner = defaultRunner(user)
  const auth = user.auth ?? {}
  const all = [
    {
      id: "claude-acp",
      name: "Claude (ACP)",
      env: ["ANTHROPIC_API_KEY"],
      source: process.env.ANTHROPIC_API_KEY ? "env" : "config",
      options: {},
      models: CLAUDE_ACP_MODELS,
    },
    {
      id: "codex-acp",
      name: "Codex (ACP)",
      env: ["OPENAI_API_KEY"],
      source: process.env.OPENAI_API_KEY ? "env" : "config",
      options: {},
      models: CODEX_ACP_MODELS,
    },
    {
      id: "cursor-acp",
      name: "Cursor (ACP)",
      env: ["CURSOR_API_KEY"],
      source: process.env.CURSOR_API_KEY ? "env" : "config",
      options: {},
      models: CURSOR_ACP_MODELS,
    },
  ]

  return {
    all,
    default: {
      "claude-acp": runner.type === "claude-acp" ? runner.model ?? "claude-sonnet-4-6" : "claude-sonnet-4-6",
      "codex-acp": runner.type === "codex-acp" ? runner.model ?? "" : "",
      "cursor-acp": runner.type === "cursor-acp" ? runner.model ?? "" : "",
    },
    connected: [
      ...(process.env.ANTHROPIC_API_KEY || auth["claude-acp"] ? ["claude-acp"] : []),
      ...(process.env.OPENAI_API_KEY || auth["codex-acp"] ? ["codex-acp"] : []),
      ...(process.env.CURSOR_API_KEY || auth["cursor-acp"] ? ["cursor-acp"] : []),
    ],
  }
}

function configBody(config: Awaited<ReturnType<typeof loadUserConfig>>) {
  const runner = defaultRunner(config)
  const model = runner.model ?? (runner.type === "claude-acp" ? "claude-sonnet-4-6" : "")
  return {
    model: model ? `${runner.type}/${model}` : "",
    provider: {},
    mcp: config.mcp ?? {},
  }
}

function dirProject(id: string, directory: string, created: number, updated: number, sandboxes: string[] = []) {
  return {
    id,
    worktree: directory,
    name: path.basename(directory) || directory,
    time: { created, updated },
    sandboxes,
  }
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function hasTag(input: unknown, tag: string) {
  return Array.isArray(input) && input.includes(tag)
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function slug(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function text(input: unknown) {
  if (typeof input === "string") return input.trim()
  if (input instanceof Uint8Array) return new TextDecoder().decode(input).trim()
  return ""
}

async function gitRun(dir: string, args: string[]) {
  try {
    const out = await execFileAsync("git", ["-C", dir, ...args])
    return {
      ok: true as const,
      out: text(out.stdout),
      err: text(out.stderr),
    }
  } catch (err) {
    const cause = err as { stdout?: unknown; stderr?: unknown; message?: string }
    return {
      ok: false as const,
      out: text(cause.stdout),
      err: text(cause.stderr) || text(cause.message),
    }
  }
}

function trees(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .reduce<{ path?: string; branch?: string }[]>((all, line) => {
      if (!line) return all
      if (line.startsWith("worktree ")) {
        all.push({ path: line.slice("worktree ".length).trim() })
        return all
      }
      const last = all[all.length - 1]
      if (!last) return all
      if (line.startsWith("branch ")) last.branch = line.slice("branch ".length).trim()
      return all
    }, [])
}

async function canon(input: string) {
  const abs = path.resolve(input)
  const real = await fs.promises.realpath(abs).catch(() => abs)
  const next = path.normalize(real)
  return process.platform === "win32" ? next.toLowerCase() : next
}

async function locate(rows: { path?: string; branch?: string }[], dir: string) {
  const key = await canon(dir)
  for (const row of rows) {
    if (!row.path) continue
    if (await canon(row.path) === key) return row
  }
}

async function shell(dir: string, cmd: string) {
  try {
    const out = await execFileAsync(process.platform === "win32" ? "cmd" : "bash", process.platform === "win32" ? ["/c", cmd] : ["-lc", cmd], { cwd: dir })
    return {
      ok: true as const,
      out: text(out.stdout),
      err: text(out.stderr),
    }
  } catch (err) {
    const cause = err as { stdout?: unknown; stderr?: unknown; message?: string }
    return {
      ok: false as const,
      out: text(cause.stdout),
      err: text(cause.stderr) || text(cause.message),
    }
  }
}

async function primary(dir: string) {
  const remotes = await gitRun(dir, ["remote"])
  const list = remotes.ok
    ? remotes.out.split("\n").map((item) => item.trim()).filter(Boolean)
    : []
  const remote = list.includes("origin")
    ? "origin"
    : list.length === 1
      ? list[0]
      : list.includes("upstream")
        ? "upstream"
        : ""
  const head = remote
    ? await gitRun(dir, ["symbolic-ref", `refs/remotes/${remote}/HEAD`])
    : { ok: false as const, out: "", err: "" }
  if (head.ok && head.out.startsWith(`refs/remotes/${remote}/`)) {
    return {
      local: head.out.slice(`refs/remotes/${remote}/`.length),
      target: head.out.replace(/^refs\/remotes\//, ""),
    }
  }
  for (const item of ["main", "master"]) {
    const hit = await gitRun(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${item}`])
    if (hit.ok) return { local: item, target: item }
  }
  return undefined
}

async function wtinfo(dir: string, project_id: string, name?: string) {
  const root = path.join(dataDir(), "worktree", project_id)
  await fs.promises.mkdir(root, { recursive: true })
  const base = name ? slug(name) : ""
  for (const i of Array.from({ length: 26 }, (_, idx) => idx)) {
    const next = base || `wt-${randomUUID().slice(0, 8)}`
    const item = i === 0 ? next : `${next}-${randomUUID().slice(0, 4)}`
    const branch = `opencode/${item}`
    const directory = path.join(root, item)
    const hit = await fs.promises.stat(directory).then(() => true, () => false)
    if (hit) continue
    const ref = await gitRun(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
    if (ref.ok) continue
    return { name: item, branch, directory }
  }
  return undefined
}

function wtready(info: { name: string; branch: string; directory: string }) {
  globalBus.publish({
    directory: info.directory,
    payload: {
      type: "worktree.ready",
      properties: {
        name: info.name,
        branch: info.branch,
      },
    },
  })
  claxedoBus.publish({
    type: "worktree.ready",
    directory: info.directory,
    name: info.name,
    branch: info.branch,
  })
}

function wtfail(directory: string, message: string) {
  globalBus.publish({
    directory,
    payload: {
      type: "worktree.failed",
      properties: {
        message,
      },
    },
  })
  claxedoBus.publish({
    type: "worktree.failed",
    directory,
    message,
  })
}

function cloudSummary(input: {
  session_id: string
  project_id: string | null
  directory: string
  title: string | null
  provider: string | null
  repo_name: string | null
  git_branch: string | null
  git_remote: string | null
  data: string
  created_at: number
  updated_at: number
}) {
  const body = (() => {
    try {
      return JSON.parse(input.data) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  const time = rec(body.time)
  return {
    id: input.session_id,
    title: txt(body.title) ?? input.title ?? null,
    time: {
      created: num(time?.created) ?? input.created_at,
      updated: Math.max(num(time?.updated) ?? input.updated_at, input.updated_at),
      ...(num(time?.archived) ? { archived: num(time?.archived) } : {}),
    },
    directory: txt(body.directory) ?? input.directory,
    ...(txt(body.parentID) ? { parentID: txt(body.parentID) } : {}),
    ...(input.project_id ? { projectID: input.project_id } : {}),
    environment: {
      kind: "cloud",
      ...(input.provider ? { provider: input.provider } : {}),
    },
    git: {
      ...(input.repo_name ? { repo: input.repo_name } : {}),
      ...(input.git_branch ? { branch: input.git_branch } : {}),
      ...(input.git_remote ? { remote: input.git_remote } : {}),
    },
  }
}

const VALID_RUNNERS = new Set(["opencode", "claude-acp", "codex-acp", "cursor-acp"])

/** Read optional `?runner=` query param; returns undefined when absent or invalid */
function queryRunnerType(c: Ctx): string | undefined {
  const runner = c.req.query("runner")
  if (runner && VALID_RUNNERS.has(runner)) return runner
  return undefined
}

async function resolveRunnerType(override?: string) {
  if (override) return override
  return defaultRunner(await loadUserConfig()).type
}

async function providerBody(runnerOverride?: string) {
  const runnerType = await resolveRunnerType(runnerOverride)
  if (runnerType !== "opencode") return buildAcpProviderResponse()
  const res = await fetch(new URL("/provider", opencodeUrl()), {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`provider fetch failed: ${res.status}`)
  return res.json()
}

async function providerAuthBody(runnerOverride?: string) {
  const runnerType = await resolveRunnerType(runnerOverride)
  if (runnerType !== "opencode") {
    return {
      "claude-acp": [{ type: "api", label: "API Key" }],
      "codex-acp": [{ type: "api", label: "API Key" }],
      "cursor-acp": [{ type: "api", label: "API Key" }],
    }
  }
  const res = await fetch(new URL("/provider/auth", opencodeUrl()), {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`provider auth fetch failed: ${res.status}`)
  return res.json()
}

async function configProvidersBody(runnerOverride?: string) {
  const runnerType = await resolveRunnerType(runnerOverride)
  if (runnerType !== "opencode") {
    const provider = await buildAcpProviderResponse()
    return {
      providers: provider.all,
      default: provider.default,
    }
  }
  const res = await fetch(new URL("/config/providers", opencodeUrl()), {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`config providers fetch failed: ${res.status}`)
  return res.json()
}

async function globalConfigBody(runnerOverride?: string) {
  const runnerType = await resolveRunnerType(runnerOverride)
  if (runnerType !== "opencode") {
    const user = await loadUserConfig()
    return configBody(user)
  }
  const res = await fetch(new URL("/global/config", opencodeUrl()), {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`global config fetch failed: ${res.status}`)
  return res.json()
}

async function bootstrapBody(runnerOverride?: string) {
  return {
    healthy: true,
    version: version(),
    path: bootPath(),
    project: await listProjects(),
    provider: await providerBody(runnerOverride),
    provider_auth: await providerAuthBody(runnerOverride),
    config: await globalConfigBody(runnerOverride),
    config_providers: await configProvidersBody(runnerOverride),
  }
}

export function OpenCodeCompatRoutes() {
  return new Hono()
    .get("/api/claxedo/bootstrap", async (c) => {
      try {
        const runner = queryRunnerType(c)
        return c.json(await bootstrapBody(runner))
      } catch (err) {
        return c.json({
          error: err instanceof Error ? err.message : String(err),
        }, 502)
      }
    })
    .get("/global/health", (c) =>
      c.json({
        healthy: true,
        version: version(),
      }),
    )
    .get("/path", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      return c.json(bootPath(ws?.directory ?? input.directory))
    })
    .get("/find/file", async (c) => {
      const query = c.req.query("query") ?? ""
      const type = c.req.query("type") === "directory" ? "directory" : c.req.query("dirs") === "false" ? "file" : "any"
      const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      const searchDir = ws?.directory ?? input.directory ?? process.cwd()
      return c.json(await globSearch(searchDir, query, type, limit))
    })
    .get("/file", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      const root = workspaceRoot(ws, input)
      const dirPath = workspacePath(root, c.req.query("path"))
      const exclude = new Set([".git", ".DS_Store"])
      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
        return c.json(
          entries
            .filter((e) => !exclude.has(e.name))
            .map((e) => ({
              name: e.name,
              path: path.relative(root, path.join(dirPath, e.name)),
              absolute: path.join(dirPath, e.name),
              type: e.isDirectory() ? "directory" : "file",
              ignored: e.name.startsWith(".") || e.name === "node_modules",
            }))
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1
              return a.name.localeCompare(b.name)
            }),
        )
      } catch {
        return c.json([])
      }
    })
    .get("/file/content", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      const full = workspacePath(workspaceRoot(ws, input), c.req.query("path"))
      try {
        const buf = await fs.promises.readFile(full)
        try {
          return c.json({
            type: "text",
            content: new TextDecoder("utf-8", { fatal: true }).decode(buf).trim(),
          })
        } catch {
          return c.json({
            type: "binary",
            content: "",
          })
        }
      } catch {
        return c.json({
          type: "text",
          content: "",
        })
      }
    })
    .get("/provider", async (c) => {
      const runnerType = await resolveRunnerType(queryRunnerType(c))
      if (runnerType === "opencode") return proxyUpstream(c, "/provider")
      return c.json(await buildAcpProviderResponse())
    })
    .get("/session/status", async (c) => {
      const res = await maybeProxy(c, "/session/status")
      if (res) return res
      return c.json({})
    })
    .get("/mcp", async (c) => {
      const res = await maybeProxy(c, "/mcp")
      if (res) return res
      return c.json({})
    })
    .get("/question", async (c) => {
      const res = await maybeProxy(c, "/question")
      if (res) return res
      return c.json([])
    })
    .post("/mcp/:name/connect", async (c) => {
      const res = await maybeProxy(c, `/mcp/${encodeURIComponent(c.req.param("name"))}/connect`)
      if (res) return res
      return c.json(true)
    })
    .post("/mcp/:name/disconnect", async (c) => {
      const res = await maybeProxy(c, `/mcp/${encodeURIComponent(c.req.param("name"))}/disconnect`)
      if (res) return res
      return c.json(true)
    })
    .get("/lsp", async (c) => {
      const res = await maybeProxy(c, "/lsp")
      if (res) return res
      return c.json([])
    })
    .get("/vcs", async (c) => {
      const res = await maybeProxy(c, "/vcs")
      if (res) return res
      return c.json({})
    })
    .get("/provider/auth", async (c) => {
      const runnerType = await resolveRunnerType(queryRunnerType(c))
      if (runnerType === "opencode") return proxyUpstream(c, "/provider/auth")
      return c.json({
        "claude-acp": [{ type: "api", label: "API Key" }],
        "codex-acp": [{ type: "api", label: "API Key" }],
        "cursor-acp": [{ type: "api", label: "API Key" }],
      })
    })
    .post("/provider/:providerID/oauth/:step", async (c) => {
      const runnerType = await resolveRunnerType(queryRunnerType(c))
      if (runnerType !== "opencode") return c.json({ error: "oauth unsupported for ACP runners" }, 404)
      return proxyUpstream(c, `/provider/${encodeURIComponent(c.req.param("providerID"))}/oauth/${encodeURIComponent(c.req.param("step"))}`)
    })
    .get("/config/providers", async (c) => {
      const runnerType = await resolveRunnerType(queryRunnerType(c))
      if (runnerType === "opencode") return proxyUpstream(c, "/config/providers")
      const provider = await buildAcpProviderResponse()
      return c.json({
        providers: provider.all,
        default: provider.default,
      })
    })
    .put("/auth/:providerID", async (c) => {
      const id = c.req.param("providerID")
      const body = await c.req.json<{ auth?: { key?: string } }>().catch(() => null)
      const key = body?.auth?.key
      if (!key) return c.json({ error: "auth.key is required" }, 400)
      const user = await loadUserConfig()
      const runner = defaultRunner(user)
      if (runner.type === "opencode" && !id.endsWith("-acp")) return proxyUpstream(c, `/auth/${encodeURIComponent(id)}`)
      user.auth = { ...user.auth, [id]: key }
      await saveUserConfig(user)
      await fanOutConfig().catch(() => {})
      return c.json({})
    })
    .delete("/auth/:providerID", async (c) => {
      const id = c.req.param("providerID")
      const user = await loadUserConfig()
      const runner = defaultRunner(user)
      if (runner.type === "opencode" && !id.endsWith("-acp")) return proxyUpstream(c, `/auth/${encodeURIComponent(id)}`)
      user.auth = { ...user.auth }
      delete user.auth[id]
      await saveUserConfig(user)
      await fanOutConfig().catch(() => {})
      return c.json({})
    })
    .post("/global/dispose", (c) => c.json(true))
    .get("/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultRunner(user).type === "opencode") return proxyUpstream(c, "/config")
      return c.json(configBody(user))
    })
    .patch("/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultRunner(user).type === "opencode") return proxyUpstream(c, "/config")
      const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
      if (body) {
        await saveUserConfig({
          ...user,
          mcp: (body.mcp ?? user.mcp) as typeof user.mcp,
        })
        await rebuildOpencodeJsonc().catch(() => {})
        await fanOutConfig().catch(() => {})
      }
      return c.json(configBody(await loadUserConfig()))
    })
    .get("/global/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultRunner(user).type === "opencode") return proxyUpstream(c, "/global/config")
      return c.json(configBody(user))
    })
    .patch("/global/config", async (c) => {
      const user = await loadUserConfig()
      if (defaultRunner(user).type === "opencode") return proxyUpstream(c, "/global/config")
      const body = await c.req.json().catch(() => null) as { config?: Record<string, unknown> } | null
      if (body?.config) {
        await saveUserConfig({
          ...user,
          mcp: (body.config.mcp ?? user.mcp) as typeof user.mcp,
        })
        await rebuildOpencodeJsonc().catch(() => {})
        await fanOutConfig().catch(() => {})
      }
      return c.json(configBody(await loadUserConfig()))
    })
    .get("/agent", async (c) => {
      const user = await loadUserConfig()
      const hit = runner(c, defaultRunner(user))
      if (hit.type === "opencode") return proxyUpstream(c, "/agent")
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
        create: !!input.directory,
      }).catch(() => undefined)
      if (ws?.kind === "local") {
        const adapter = await getLocalAgentAdapter(ws, hit).catch(() => undefined)
        const list = adapter ? await adapter.listAgents(ws.directory).catch(() => []) : []
        if (Array.isArray(list) && list.length > 0) return c.json(list)
      }
      const runtimes = ws
        ? await ensureWorkspaceRuntime(ws.id)
          .then((item) => [{
            workspaceId: item.ws.id,
            directory: item.ws.directory,
            remoteDirectory: item.ws.remote_directory || item.ws.directory,
            url: item.url!,
          }])
          .catch(() => listWorkspaceRuntimes().filter((item) => item.workspaceId === ws.id))
        : listWorkspaceRuntimes()
      for (const rt of runtimes) {
        try {
          const res = await fetch(`${rt.url}/agent`, {
            headers: {
              "x-workspace-id": rt.workspaceId,
              "x-opencode-directory": rt.remoteDirectory,
            },
            signal: AbortSignal.timeout(2_000),
          })
          if (res.ok) return c.json(await res.json())
        } catch { /* try next */ }
      }
      // Fallback when no workspace runtime is available yet
      return c.json([
        { name: "build", description: "Default agent", mode: "primary" },
      ])
    })
    .get("/command", async (c) => {
      try {
        return c.json(await listCommands())
      } catch {
        return c.json([])
      }
    })
    .get("/project", async (c) => {
      const all = await listProjects()
      return c.json(all)
    })
    .get("/project/current", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
        create: !!input.directory,
      })
      const current = ws ?? {
        id: input.workspaceId || input.directory || process.cwd(),
        directory: input.directory || process.cwd(),
        kind: "local" as const,
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      const project_id = "project_id" in current ? current.project_id ?? current.id : current.id
      const all = await listProjects()
      const hit = all.find((item) => item.id === project_id)
      return c.json(hit ?? dirProject(current.id, current.directory, current.created_at, current.updated_at))
    })
    .patch("/project/:id", (c) => c.json({ ok: true }))
    .post("/experimental/worktree", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      if (!ws) return c.json({ error: "Workspace not found" }, 404)
      if (ws.kind !== "local") return c.json({ error: "Worktrees are only supported for local workspaces" }, 400)
      const root = await getProjectWorkspace(ws.project_id ?? ws.id)
      if (!root) return c.json({ error: "Project workspace not found" }, 404)
      const body = await c.req.json().catch(() => ({})) as { name?: string; startCommand?: string }
      const info = await wtinfo(root.directory, root.project_id ?? root.id, body.name)
      if (!info) return c.json({ error: "Failed to generate a unique worktree name" }, 400)
      const created = await gitRun(root.directory, ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory])
      if (!created.ok) return c.json({ error: created.err || created.out || "Failed to create git worktree" }, 400)
      await ensureWorkspace({
        project_id: root.project_id ?? root.id,
        project_name: root.project_name,
        workspace_name: info.name,
        directory: info.directory,
      })
      setTimeout(() => {
        void (async () => {
          const reset = await gitRun(info.directory, ["reset", "--hard"])
          if (!reset.ok) {
            wtfail(info.directory, reset.err || reset.out || "Failed to populate worktree")
            return
          }
          wtready(info)
          const cmd = body.startCommand?.trim()
          if (!cmd) return
          const ran = await shell(info.directory, cmd)
          if (ran.ok) return
          wtfail(info.directory, ran.err || ran.out || "Failed to run worktree start command")
        })()
      }, 0)
      return c.json(info)
    })
    .get("/experimental/worktree", async (c) => {
      const input = workspaceInput(c)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      if (!ws) return c.json([])
      const project_id = ws.project_id ?? ws.id
      const root = await getProjectWorkspace(project_id)
      if (!root) return c.json([])
      const all = await listWorkspaces()
      return c.json(
        all
          .filter((item) => item.kind === "local" && item.project_id === project_id && item.directory !== root.directory)
          .map((item) => item.directory)
          .sort((a, b) => a.localeCompare(b)),
      )
    })
    .delete("/experimental/worktree", async (c) => {
      const input = workspaceInput(c)
      const body = await c.req.json().catch(() => ({})) as { directory?: string }
      const target = body.directory?.trim()
      if (!target) return c.json({ error: "directory is required" }, 400)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      if (!ws) return c.json({ error: "Workspace not found" }, 404)
      const root = await getProjectWorkspace(ws.project_id ?? ws.id)
      if (!root) return c.json({ error: "Project workspace not found" }, 404)
      if (path.resolve(target) === path.resolve(root.directory)) {
        return c.json({ error: "Cannot remove the primary workspace" }, 400)
      }
      const list = await gitRun(root.directory, ["worktree", "list", "--porcelain"])
      if (!list.ok) return c.json({ error: list.err || list.out || "Failed to read git worktrees" }, 400)
      const row = await locate(trees(list.out), target)
      const removed = row?.path
        ? await gitRun(root.directory, ["worktree", "remove", "--force", row.path])
        : { ok: true as const, out: "", err: "" }
      if (row?.path && !removed.ok) {
        const next = await gitRun(root.directory, ["worktree", "list", "--porcelain"])
        if (!next.ok) return c.json({ error: removed.err || removed.out || next.err || next.out || "Failed to remove git worktree" }, 400)
        const stale = await locate(trees(next.out), target)
        if (stale?.path) return c.json({ error: removed.err || removed.out || "Failed to remove git worktree" }, 400)
      }
      await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined)
      const branch = row?.branch?.replace(/^refs\/heads\//, "")
      if (branch && branch !== "HEAD" && branch.startsWith("opencode/")) {
        const deleted = await gitRun(root.directory, ["branch", "-D", branch])
        if (!deleted.ok) return c.json({ error: deleted.err || deleted.out || "Failed to delete worktree branch" }, 400)
      }
      await deleteWorkspaceByDirectory(target)
      return c.json(true)
    })
    .post("/experimental/worktree/reset", async (c) => {
      const input = workspaceInput(c)
      const body = await c.req.json().catch(() => ({})) as { directory?: string }
      const target = body.directory?.trim()
      if (!target) return c.json({ error: "directory is required" }, 400)
      const ws = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      if (!ws) return c.json({ error: "Workspace not found" }, 404)
      const root = await getProjectWorkspace(ws.project_id ?? ws.id)
      if (!root) return c.json({ error: "Project workspace not found" }, 404)
      if (path.resolve(target) === path.resolve(root.directory)) {
        return c.json({ error: "Cannot reset the primary workspace" }, 400)
      }
      const branch = await primary(root.directory)
      if (!branch) return c.json({ error: "Default branch not found" }, 400)
      if (branch.target !== branch.local) {
        const fetched = await gitRun(root.directory, ["fetch", branch.target.split("/")[0]!, branch.local])
        if (!fetched.ok) return c.json({ error: fetched.err || fetched.out || `Failed to fetch ${branch.target}` }, 400)
      }
      const reset = await gitRun(target, ["reset", "--hard", branch.target])
      if (!reset.ok) return c.json({ error: reset.err || reset.out || "Failed to reset worktree" }, 400)
      const clean = await gitRun(target, ["clean", "-ffdx"])
      if (!clean.ok) return c.json({ error: clean.err || clean.out || "Failed to clean worktree" }, 400)
      const update = await gitRun(target, ["submodule", "update", "--init", "--recursive", "--force"])
      if (!update.ok) return c.json({ error: update.err || update.out || "Failed to update submodules" }, 400)
      return c.json(true)
    })
    .get("/experimental/session", async (c) => {
      const input = workspaceInput(c)
      const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500)
      const cursor = Number(c.req.query("cursor") ?? "")
      const roots = c.req.query("roots") === "true" || c.req.query("roots") === "1"
      const archived = c.req.query("archived") as string | undefined
      const groupBy = c.req.query("groupBy") as string | undefined
      const perGroup = Math.min(Number(c.req.query("perGroup") ?? "5") || 5, 100)
      const filterStatus = c.req.query("filter.status")?.split(",").filter(Boolean) ?? []
      const filterEnvironment = c.req.query("filter.environment")?.split(",").filter(Boolean) ?? []
      const filterGit = c.req.query("filter.git")?.split(",").filter(Boolean) ?? []
      const target = await resolveWorkspace({
        workspaceId: input.workspaceId,
        directory: input.directory,
      })
      const merged = new Map<string, any>()
      const locals = target ? [target] : await listWorkspaces()
      const wsby = new Map(locals.map((ws) => [ws.id, ws]))
      await Promise.allSettled(locals.map(async (ws) => {
        const body = await listLocalSessions(ws).catch(() => [])
        if (!Array.isArray(body)) return
        for (const row of body) {
          if (!row || typeof row !== "object" || !(row as Record<string, unknown>).id) continue
          const item = row as Record<string, any>
          const normalized = item.time
            ? item
            : {
                id: item.id,
                title: item.title ?? null,
                time: {
                  created: item.created_at ?? Date.now(),
                  updated: item.updated_at ?? item.created_at ?? Date.now(),
                  ...(typeof item.archived_at === "number" ? { archived: item.archived_at } : {}),
                },
                directory: item.directory ?? ws.directory,
                ...(ws.project_id ? { projectID: ws.project_id } : {}),
                environment: {
                  kind: ws.kind,
                  ...(ws.provider ? { provider: ws.provider } : {}),
                },
                git: {
                  ...(ws.repo_name ? { repo: ws.repo_name } : {}),
                  ...(ws.git_branch ? { branch: ws.git_branch } : {}),
                  ...(ws.git_remote ? { remote: ws.git_remote } : {}),
                },
              }
          const prev = merged.get(normalized.id)
          if (!prev || (normalized.time?.updated ?? 0) > (prev.time?.updated ?? 0)) {
            merged.set(normalized.id, normalized)
          }
        }
      }))
      const remotes = target
        ? listWorkspaceRuntimes().filter((item) => item.workspaceId === target.id)
        : listWorkspaceRuntimes()
      await Promise.allSettled(remotes.map(async (item) => {
        const params = new URLSearchParams()
        params.set("directory", item.remoteDirectory)
        params.set("limit", String(limit))
        const res = await fetch(`${item.url}/experimental/session?${params}`, {
          signal: AbortSignal.timeout(3_000),
          headers: { "X-Daytona-Skip-Preview-Warning": "true" },
        })
        if (!res.ok) return
        const body = await res.json().catch(() => [])
        if (!Array.isArray(body)) return
        const ws = wsby.get(item.workspaceId)
        for (const row of body) {
          if (!row?.id) continue
          const next = {
            ...row,
            // Remap remote directory (e.g. /workspace) back to local workspace directory
            ...(ws ? { directory: ws.directory } : {}),
            ...(ws?.project_id && !row.projectID ? { projectID: ws.project_id } : {}),
            ...(ws
              ? {
                  environment: {
                    kind: ws.kind,
                    ...(ws.provider ? { provider: ws.provider } : {}),
                  },
                  git: {
                    ...(ws.repo_name ? { repo: ws.repo_name } : {}),
                    ...(ws.git_branch ? { branch: ws.git_branch } : {}),
                    ...(ws.git_remote ? { remote: ws.git_remote } : {}),
                  },
                }
              : {}),
          }
          const prev = merged.get(next.id)
          if (!prev || (next.time?.updated ?? 0) > (prev.time?.updated ?? 0)) {
            merged.set(next.id, next)
          }
        }
      }))
      const clouds = ClaxedoDB.use((db) => db.select().from(ClaxedoCloudSessionTable).all())
        .filter((item) => !item.deleted_at)
        .filter((item) => !target || (target.kind === "cloud" && item.workspace_id === target.id))
      for (const item of clouds) {
        const row = cloudSummary(item)
        const prev = merged.get(row.id)
        if (!prev || (row.time?.updated ?? 0) > (prev.time?.updated ?? 0)) {
          merged.set(row.id, row)
        }
      }
      const rows = await applySessionMeta([...merged.values()])
      const globals = target ? [] : await taggedSessionMetas([GLOBAL_TAG], { includeHidden: true })
      for (const item of globals) {
        if (!item.directory || merged.has(item.sessionID)) continue
        rows.push({
          id: item.sessionID,
          title: item.title ?? null,
          directory: item.directory,
          ...(item.parentID ? { parentID: item.parentID } : {}),
          ...(item.rootID ? { rootID: item.rootID } : {}),
          time: {
            created: item.createdAt,
            updated: item.updatedAt,
            ...(typeof item.archived === "number" ? { archived: item.archived } : {}),
          },
          tags: item.tags,
          attachments: item.attachments,
          environment: {
            kind: "global",
          },
        })
      }

      // --- Archive filter (tri-state: active | archived | all) ---
      // archived=true / 1 / all → show everything
      // archived=archived → only archived
      // otherwise → only active (non-archived)
      const archiveMode = (archived === "true" || archived === "1" || archived === "all") ? "all"
        : archived === "archived" ? "archived"
        : "active"

      // --- Helper fns matching frontend sidebar logic ---
      function sessionStatus(item: Record<string, unknown>) {
        const tags = Array.isArray(item.tags) ? (item.tags as string[]).filter((tag) => tag !== GLOBAL_TAG && tag !== GLOBAL_SHOW_TAG) : []
        const att = Array.isArray(item.attachments)
          ? (item.attachments as Array<{ kind?: string }>).map((a) => a.kind).filter(Boolean) as string[]
          : []
        const all = [...new Set([...tags, ...att])].sort()
        return all.length ? all : ["general"]
      }

      function sessionEnv(item: Record<string, unknown>) {
        const env = rec(item.environment)
        const parts = [
          typeof env?.kind === "string" ? env.kind : undefined,
          typeof env?.provider === "string" ? `provider:${env.provider}` : undefined,
        ].filter(Boolean) as string[]
        return [...new Set(parts)].sort()
      }

      function sessionGit(item: Record<string, unknown>) {
        const g = rec(item.git)
        const parts = [
          typeof g?.repo === "string" ? `repo:${g.repo}` : undefined,
          typeof g?.branch === "string" ? `branch:${g.branch}` : undefined,
        ].filter(Boolean) as string[]
        return [...new Set(parts)].sort()
      }

      function timeBucket(ts: number) {
        const day = 24 * 60 * 60 * 1000
        const diff = Date.now() - ts
        if (diff < day) return "Today"
        if (diff < day * 2) return "Yesterday"
        if (diff < day * 7) return "This Week"
        return "Older"
      }

      const filtered = rows.filter((item) => {
        if (target && hasTag(item.tags, GLOBAL_TAG)) return false
        // roots filter
        if (roots && typeof item.parentID === "string") return false
        if (Number.isFinite(cursor) && cursor > 0 && (num(rec(item.time)?.updated) ?? 0) >= cursor) return false
        // archive filter
        const isArchived = typeof rec(item.time)?.archived === "number"
        if (archiveMode === "active" && isArchived) return false
        if (archiveMode === "archived" && !isArchived) return false
        // status filter
        if (filterStatus.length) {
          const s = sessionStatus(item)
          if (!filterStatus.some((f) => s.includes(f))) return false
        }
        // environment filter
        if (filterEnvironment.length) {
          const e = sessionEnv(item)
          if (!filterEnvironment.some((f) => e.includes(f))) return false
        }
        // git filter
        if (filterGit.length) {
          const g = sessionGit(item)
          if (!filterGit.some((f) => g.includes(f))) return false
        }
        return true
      }).sort((a, b) => (num(rec(b.time)?.updated) ?? 0) - (num(rec(a.time)?.updated) ?? 0))

      // --- Grouped responses ---
      if (groupBy && groupBy !== "none") {
        function groupKey(item: Record<string, unknown>): string {
          switch (groupBy) {
            case "workspace":
              if (hasTag(item.tags, GLOBAL_TAG)) return ""
              return typeof item.directory === "string" ? item.directory : "unknown"
            case "updated":
              return timeBucket(num(rec(item.time)?.updated) ?? Date.now())
            case "status":
              return sessionStatus(item)[0] ?? "general"
            case "environment":
              return sessionEnv(item)[0] ?? "unknown"
            default:
              return "unknown"
          }
        }

        const byKey = new Map<string, any[]>()
        for (const row of filtered) {
          const key = groupKey(row)
          if (!key) continue
          const list = byKey.get(key)
          if (list) list.push(row)
          else byKey.set(key, [row])
        }

        const groups = [...byKey.entries()]
          .map(([key, items]) => ({
            key,
            ...(groupBy === "workspace" ? { directory: key, projectID: items[0]?.projectID } : {}),
            sessions: items.slice(0, perGroup),
            hasMore: items.length > perGroup,
            total: items.length,
            nextCursor:
              items.length > perGroup
                ? (num(rec(items[Math.min(perGroup, items.length) - 1]?.time)?.updated) ?? undefined)
                : undefined,
          }))
          .sort((a, b) => {
            if (groupBy === "updated") {
              const order = ["Today", "Yesterday", "This Week", "Older"]
              return (order.indexOf(a.key) === -1 ? 99 : order.indexOf(a.key)) -
                     (order.indexOf(b.key) === -1 ? 99 : order.indexOf(b.key))
            }
            if (groupBy === "status") {
              const order = ["review", "page", "planner", "general"]
              return (order.indexOf(a.key) === -1 ? 99 : order.indexOf(a.key)) -
                     (order.indexOf(b.key) === -1 ? 99 : order.indexOf(b.key))
            }
            if (groupBy === "environment") {
              const order = ["local", "cloud"]
              return (order.indexOf(a.key) === -1 ? 99 : order.indexOf(a.key)) -
                     (order.indexOf(b.key) === -1 ? 99 : order.indexOf(b.key))
            }
            // workspace: sort by most recent session
            const aTime = num(rec(a.sessions[0]?.time)?.updated) ?? 0
            const bTime = num(rec(b.sessions[0]?.time)?.updated) ?? 0
            return bTime - aTime
          })
        return c.json({ groups })
      }

      const page = filtered.slice(0, limit)
      const tail = page.at(-1)
      if (filtered.length > limit && tail) {
        const next = num(rec(tail.time)?.updated)
        if (typeof next === "number") c.header("x-next-cursor", String(next))
      }
      return c.json(page)
    })
}
