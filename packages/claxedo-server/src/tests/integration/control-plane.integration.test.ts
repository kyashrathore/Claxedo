import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { defined } from "../../test-support/assert-helpers"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { execSync } from "child_process"
import { createServer } from "node:net"

async function port() {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") {
        srv.close()
        reject(new Error("failed to allocate port"))
        return
      }
      srv.close(() => resolve(addr.port))
    })
    srv.on("error", reject)
  })
}

async function wait<T>(fn: () => T | Promise<T>, ms = 10_000, step = 100): Promise<T> {
  const end = Date.now() + ms
  let err: unknown
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch (cause) {
      err = cause
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  throw err instanceof Error ? err : new Error("timed out")
}

// The default wait must cover a full in-process worktree operation on a
// loaded Windows runner, where sibling tests in this file run 10s+ (run 364:
// the 5s abort fired before the expected event arrived).
function sse(url: string, match: (event: any) => boolean, ms = 30_000) {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), ms)
  const readiness = Promise.withResolvers<void>()
  const event = (async () => {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      clearTimeout(timeout)
      const error = new Error(`SSE failed: ${res.status}`)
      readiness.reject(error)
      throw error
    }
    readiness.resolve()
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""

    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        buf += dec.decode(next.value, { stream: true })
        for (;;) {
          const end = buf.indexOf("\n\n")
          if (end === -1) break
          const block = buf.slice(0, end)
          buf = buf.slice(end + 2)
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data) continue
          const value = JSON.parse(data)
          if (match(value)) return value
        }
      }
    } finally {
      clearTimeout(timeout)
      ctrl.abort()
      await reader.cancel().catch(() => undefined)
    }

    throw new Error("SSE ended before matching event")
  })()
  return { ready: readiness.promise, event }
}

function portablePath(value: string) {
  return value.replaceAll("\\", "/")
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const enc = new TextEncoder()
const upstreamSubs = new Set<ReadableStreamDefaultController<Uint8Array>>()
const upstreamSessions = new Map<string, { id: string; title: string | null; created_at: number; updated_at: number }>()
let statusAuth: string | null = null
let statusDir: string | null = null
let statusWs: string | null = null

function emit(event: unknown) {
  const chunk = enc.encode(`data: ${JSON.stringify(event)}\n\n`)
  upstreamSubs.forEach((ctrl) => ctrl.enqueue(chunk))
}

const root = await fs.mkdtemp(path.join(realpathSync(os.tmpdir()), "claxedo-cp-int-"))
const home = path.join(root, "home")
const data = path.join(home, ".claxedo")

await fs.mkdir(home, { recursive: true })
await fs.mkdir(data, { recursive: true })
await fs.mkdir(path.join(data, "state"), { recursive: true })

const prev = {
  HOME: process.env.HOME,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  POSTHOG_KEY: process.env.POSTHOG_KEY,
}

process.env.HOME = home
process.env.CLAXEDO_DATA_DIR = data
process.env.CLAXEDO_STATE_DIR = path.join(data, "state")
process.env.POSTHOG_KEY = ""

// Vitest can deadlock resolving this graph when these top-level imports run concurrently.
const serverMod = await import("../../deployments/self-hosted-node/app")
const supervisor = await import("../../workspace/supervisor")
const store = await import("@claxedo/server-core/workspace/store/index")
const agent = await import("@claxedo/server-core/agent-config/index")
const embedded = await import("@claxedo/local-server/deployments/local/embedded-workspace-runtime")
const opauth = await import("@claxedo/server-core/opencode/auth")

const upstreamProvider = {
  all: [
    {
      id: "upstream",
      name: "Upstream",
      env: [],
      models: {
        "up-model": {
          id: "up-model",
          name: "Up Model",
          release_date: "2026-01-01",
          attachment: true,
          reasoning: true,
          temperature: true,
          tool_call: true,
          limit: { context: 128000, output: 8192 },
          options: {},
        },
      },
    },
  ],
  default: { upstream: "up-model" },
  connected: ["upstream"],
}

const indexedUpstreamProvider = {
  all: [
    {
      id: "upstream",
      name: "Upstream",
      models: { "up-model": upstreamProvider.all[0]!.models["up-model"] },
    },
  ],
  default: upstreamProvider.default,
  connected: upstreamProvider.connected,
}

const upstreamConfigProviders = {
  providers: upstreamProvider.all,
  default: upstreamProvider.default,
}

const upstreamConfig = {
  model: "upstream/up-model",
  provider: {},
  mcp: {},
}

let upstreamPort = 0
let serverPort = 0
let upstream: import("@hono/node-server").ServerType
let server: ReturnType<typeof serverMod.startServer>

async function workspace(label: string, kind: "local" | "cloud" = "local") {
  const directory = path.join(root, "workspaces", `${label}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  if (kind === "local") {
    await fs.writeFile(path.join(directory, "README.md"), "# test\n")
    sh(`git init -b main ${directory}`)
    sh(`git -C ${directory} config user.email test@example.com`)
    sh(`git -C ${directory} config user.name test`)
    sh(`git -C ${directory} add README.md`)
    sh(`git -C ${directory} commit -m init`)
  }
  const ws = defined(
    await store.ensureWorkspace({
      workspaceId: `ws_${randomUUID()}`,
      directory,
      kind,
    }),
  )
  if (kind === "cloud") {
    supervisor.injectRuntime(ws, `http://127.0.0.1:${upstreamPort}`)
  }
  return ws
}

function sh(cmd: string) {
  execSync(cmd, { stdio: "ignore" })
}

async function repo(label: string) {
  const directory = path.join(root, "repos", `${label}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "README.md"), "# test\n")
  sh(`git init -b main ${directory}`)
  sh(`git -C ${directory} config user.email test@example.com`)
  sh(`git -C ${directory} config user.name test`)
  sh(`git -C ${directory} remote add origin https://github.com/foo/${label}.git`)
  sh(`git -C ${directory} add README.md`)
  sh(`git -C ${directory} commit -m init`)
  return defined(
    await store.ensureWorkspace({
      workspaceId: `ws_${randomUUID()}`,
      directory,
    }),
  )
}

function base() {
  return `http://127.0.0.1:${serverPort}`
}

function cfgFile() {
  return path.join(home, ".claxedo", "user-agent-config.json")
}

describe("control plane integration", () => {
  beforeAll(async () => {
    upstreamPort = await port()
    serverPort = await port()

    const { serve } = await import("@hono/node-server")
    upstream = serve({
      port: upstreamPort,
      hostname: "127.0.0.1",
      fetch(req) {
        const pathname = new URL(req.url).pathname
        if (pathname === "/global/event") {
          let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
          const body = new ReadableStream<Uint8Array>({
            start(next) {
              ctrl = next
              upstreamSubs.add(next)
              next.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    directory: "global",
                    payload: {
                      type: "server.connected",
                      properties: {},
                    },
                  })}\n\n`,
                ),
              )
            },
            cancel() {
              if (ctrl) upstreamSubs.delete(ctrl)
            },
          })
          return new Response(body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          })
        }
        if (pathname === "/session" && req.method === "GET") {
          return json([...upstreamSessions.values()])
        }
        if (pathname === "/session" && req.method === "POST") {
          const id = `sess_${randomUUID()}`
          const now = Date.now()
          const body = req.json().catch(() => ({})) as Promise<{ title?: string }>
          return body.then((data) => {
            const row = {
              id,
              title: data.title ?? null,
              created_at: now,
              updated_at: now,
            }
            upstreamSessions.set(id, row)
            return json(row, 201)
          })
        }
        if (pathname === "/session/status") {
          statusAuth = req.headers.get("authorization")
          statusDir = req.headers.get("x-opencode-directory")
          statusWs = req.headers.get("x-workspace-id")
          return json({ active: { type: "busy" } })
        }
        const session = pathname.match(/^\/session\/([^/]+)$/)
        if (session && req.method === "GET") {
          const row = upstreamSessions.get(decodeURIComponent(session[1]!))
          return row ? json(row) : json({ error: "not found" }, 404)
        }
        if (pathname === "/provider") return json(upstreamProvider)
        if (pathname === "/provider/auth") return json({ upstream: [{ type: "oauth", label: "Login" }] })
        if (pathname === "/config/providers") return json(upstreamConfigProviders)
        if (pathname === "/config" || pathname === "/global/config") return json(upstreamConfig)
        if (pathname === "/mcp") return json({ local: { status: "connected" } })
        if (pathname === "/question")
          return json([{ id: "q1", sessionID: "sess_1", questions: [{ text: "Continue?" }] }])
        if (pathname === "/lsp") return json([{ id: "ts", name: "typescript", root: ".", status: "connected" }])
        if (pathname === "/vcs") return json({ branch: "main" })
        return json({ error: "not found" }, 404)
      },
    })

    server = serverMod.startServer(serverPort, `http://127.0.0.1:${upstreamPort}`)
  })

  beforeEach(async () => {
    embedded.shutdownEmbeddedWorkspaceRuntimes()
    await supervisor.shutdownWorkspaceSupervisor()
    await new Promise((resolve) => setTimeout(resolve, 250))
    upstreamSessions.clear()
    statusAuth = null
    statusDir = null
    statusWs = null
    opauth.configureOpenCodeAuth(null)
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      harness: { id: "opencode", access: "native" },
    })
  })

  afterAll(async () => {
    embedded.shutdownEmbeddedWorkspaceRuntimes()
    await supervisor.shutdownWorkspaceSupervisor()
    server?.close()
    upstream?.close()
    process.env.HOME = prev.HOME
    process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
    process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
    process.env.POSTHOG_KEY = prev.POSTHOG_KEY
    // Close every sqlite handle the composition opened before deleting its
    // data dir: Windows answers an unlink of an open file with EBUSY, and
    // keeps a brief lock even after close (the retries absorb it).
    const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
    const { closeAuthorityDatabases } = await import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store")
    ClaxedoDB.close()
    closeAuthorityDatabases()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  test("serves startup routes without requiring workspace context", async () => {
    const health = await fetch(`${base()}/global/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({
      healthy: true,
      version: "1.0.0",
    })

    const info = await fetch(`${base()}/path`)
    expect(info.status).toBe(200)
    expect(await info.json()).toEqual({
      home: os.homedir(),
      state: path.join(data, "state"),
      config: data,
      worktree: "",
      directory: "",
    })

    const boot = await fetch(`${base()}/api/claxedo/bootstrap`)
    expect(boot.status).toBe(200)
    const body = (await boot.json()) as {
      healthy: boolean
      version: string
      path: Record<string, string>
      project: unknown[]
      provider: unknown
      provider_auth: unknown
      config: unknown
    }
    expect(body.healthy).toBe(true)
    expect(body.version).toBe("1.0.0")
    expect(body.path).toEqual({
      home: os.homedir(),
      state: path.join(data, "state"),
      config: data,
      worktree: "",
      directory: "",
    })
    expect(body.project).toEqual([])
    expect(body.provider).toEqual(indexedUpstreamProvider)
    expect(body.provider_auth).toMatchObject({
      "claude-acp": [{ type: "api", label: "API Key" }],
      "codex-acp": [
        { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
        { type: "api", label: "API Key" },
      ],
    })
    expect(body.config).toEqual(upstreamConfig)
  })

  test("handles local workspace extras in-process without spawning a runtime", async () => {
    const ws = await workspace("spawn")
    await fs.mkdir(path.join(ws.directory, ".claxedo"), { recursive: true })
    await fs.writeFile(
      path.join(ws.directory, ".claxedo", "processes.jsonc"),
      JSON.stringify({
        $schema: "./processes.schema.json",
        processes: [
          {
            id: "proc_test",
            name: "Dev server",
            command: "bun",
            args: ["run", "dev"],
            autoStart: false,
            restartPolicy: "never",
            maxRestarts: 3,
          },
        ],
      }),
    )
    const url = `${base()}/api/wr/process?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`

    const firstRes = await fetch(url)
    expect(firstRes.status).toBe(200)
    expect(await firstRes.json()).toEqual({
      configs: [
        {
          id: "proc_test",
          name: "Dev server",
          command: "bun",
          args: ["run", "dev"],
          autoStart: false,
          restartPolicy: "never",
          maxRestarts: 3,
        },
      ],
      processes: [
        {
          configId: "proc_test",
          status: "idle",
          restartCount: 0,
        },
      ],
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(supervisor.listSupervisorSandboxs().find((item) => item.workspaceId === ws.id)).toBeUndefined()

    const secondRes = await fetch(url)
    expect(secondRes.status).toBe(200)
    expect(await secondRes.json()).toEqual({
      configs: [
        {
          id: "proc_test",
          name: "Dev server",
          command: "bun",
          args: ["run", "dev"],
          autoStart: false,
          restartPolicy: "never",
          maxRestarts: 3,
        },
      ],
      processes: [
        {
          configId: "proc_test",
          status: "idle",
          restartCount: 0,
        },
      ],
    })
    expect(supervisor.listSupervisorSandboxs().find((item) => item.workspaceId === ws.id)).toBeUndefined()
  })

  test("bootstrap returns grouped projects instead of raw workspaces", async () => {
    const root = await workspace("boot-project")
    // Create a separate git repo for the sandbox so listProjects doesn't
    // filter it out as a subdirectory of the same repo root.
    const child = await workspace("boot-sandbox")
    await store.ensureWorkspace({
      workspaceId: child.id,
      directory: child.directory,
      project_id: root.project_id,
      workspace_name: "sandbox",
      kind: "local",
    })

    const res = await fetch(`${base()}/api/claxedo/bootstrap`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      project: Array<{
        id: string
        worktree: string
        sandboxes: string[]
      }>
    }

    const hit = body.project.find((item) => item.id === root.project_id)
    expect(hit).toBeDefined()
    expect(hit?.worktree).toBe(root.directory)
    expect(hit?.sandboxes).toContain(child.id)
    expect(body.project.filter((item) => item.id === root.project_id)).toHaveLength(1)
  })

  test("find file lookup does not create a workspace for arbitrary directories", async () => {
    const before = await store.listWorkspaces()
    const homeDir = os.homedir()

    const res = await fetch(
      `${base()}/find/file?directory=${encodeURIComponent(homeDir)}&query=opencode&type=directory&limit=20`,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.any(Array))

    const after = await store.listWorkspaces()
    expect(after).toHaveLength(before.length)
    expect(after.find((item) => item.directory === homeDir)).toBeUndefined()
  })

  test("exposes opencode bootstrap status routes locally", async () => {
    const status = await fetch(`${base()}/session/status`)
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({})

    const mcp = await fetch(`${base()}/mcp`)
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toEqual({})

    const question = await fetch(`${base()}/question`)
    expect(question.status).toBe(200)
    expect(await question.json()).toEqual([])

    const lsp = await fetch(`${base()}/lsp`)
    expect(lsp.status).toBe(200)
    expect(await lsp.json()).toEqual([])

    const vcs = await fetch(`${base()}/vcs`)
    expect(vcs.status).toBe(200)
    expect(await vcs.json()).toEqual({})
  })

  test("manages local worktrees in-process and keeps them in the project catalog", async () => {
    const ws = await repo("worktree-local")

    const stream = sse(
      `${base()}/api/claxedo/events`,
      (event) => event.type === "worktree.ready" && portablePath(event.directory ?? "").includes("/worktree/"),
    )
    await stream.ready

    const create = await fetch(
      `${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
    expect(create.status).toBe(200)
    const created = (await create.json()) as { name: string; branch: string; directory: string }
    expect(portablePath(created.directory)).toContain("/worktree/")
    expect(created.branch.startsWith("opencode/")).toBe(true)

    const event = await stream.event
    expect(event).toEqual({
      type: "worktree.ready",
      directory: created.directory,
      name: created.name,
      branch: created.branch,
    })

    const list = await fetch(
      `${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as string[]
    const ckey = await fs.realpath(created.directory).catch(() => path.resolve(created.directory))
    const lkeys = await Promise.all(listed.map((item) => fs.realpath(item).catch(() => path.resolve(item))))
    expect(lkeys).toContain(ckey)

    const stored = await store.getWorkspaceByDirectory(created.directory)
    expect(stored?.project_id).toBe(ws.project_id)

    const removed = await fetch(
      `${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(created.directory)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toBe(true)
    expect(await store.getWorkspaceByDirectory(created.directory)).toBeUndefined()
  })

  test("removes stale worktrees after the directory was deleted outside claxedo", async () => {
    const ws = await repo("worktree-missing")

    const create = await fetch(
      `${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
    expect(create.status).toBe(200)
    const created = (await create.json()) as { directory: string }

    // ENOTEMPTY-retry: the runtime's config watcher can drop a file into the
    // worktree mid-recursive-delete on loaded runners; fs.rm retries that class.
    await fs.rm(created.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

    const removed = await fetch(
      `${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(created.directory)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toBe(true)
    expect(await store.getWorkspaceByDirectory(created.directory)).toBeUndefined()
  })

  test("file status returns quickly for a deleted worktree directory", async () => {
    const ws = await repo("worktree-status-missing")

    const create = await fetch(
      `${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
    expect(create.status).toBe(200)
    const created = (await create.json()) as { directory: string }

    // ENOTEMPTY-retry: the runtime's config watcher can drop a file into the
    // worktree mid-recursive-delete on loaded runners; fs.rm retries that class.
    await fs.rm(created.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

    const res = await fetch(`${base()}/file/status?directory=${encodeURIComponent(created.directory)}`, {
      signal: AbortSignal.timeout(1_000),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("proxies cloud session routes through workspace-runtime", async () => {
    const ws = await workspace("cloud-session", "cloud")
    const res = await fetch(
      `${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])

    const runtime = await wait(() => supervisor.listSupervisorSandboxs().find((item) => item.workspaceId === ws.id))
    expect(runtime?.workspaceId).toBe(ws.id)
  })

  test("proxies cloud bootstrap status routes through workspace-runtime", async () => {
    const ws = await workspace("cloud-status", "cloud")

    const status = await fetch(
      `${base()}/session/status?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ active: { type: "busy" } })

    const mcp = await fetch(
      `${base()}/mcp?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toEqual({ local: { status: "connected" } })

    const question = await fetch(
      `${base()}/question?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )
    expect(question.status).toBe(200)
    expect(await question.json()).toEqual([{ id: "q1", sessionID: "sess_1", questions: [{ text: "Continue?" }] }])

    const lsp = await fetch(
      `${base()}/lsp?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )
    expect(lsp.status).toBe(200)
    expect(await lsp.json()).toEqual([{ id: "ts", name: "typescript", root: ".", status: "connected" }])

    const vcs = await fetch(
      `${base()}/vcs?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )
    expect(vcs.status).toBe(200)
    expect(await vcs.json()).toEqual({ branch: "main" })
  })

  test("cloud status forwarding uses shared opencode auth headers", async () => {
    const ws = await workspace("cloud-status-auth", "cloud")
    opauth.configureOpenCodeAuth("desk-secret")

    const status = await fetch(
      `${base()}/session/status?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ active: { type: "busy" } })
    expect(statusAuth).toBe(`Basic ${Buffer.from("opencode:desk-secret").toString("base64")}`)
    expect(statusDir).toBe("/workspace")
    expect(statusWs).toBe(ws.id)
  })

  test("local workspace relay forwards runtime access authorization", async () => {
    const ws = await workspace("local-relay-auth", "cloud")

    const status = await fetch(`${base()}/workspaces/${encodeURIComponent(ws.id)}/session/status`, {
      headers: { Authorization: "Bearer runtime-access-token" },
    })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ active: { type: "busy" } })
    expect(statusAuth).toBe("Bearer runtime-access-token")
    expect(statusDir).toBe("/workspace")
    expect(statusWs).toBe(ws.id)
  })

  test("keeps persisted MCP config raw while fan-out runs against a live runtime", async () => {
    const ws = await workspace("config")
    await fetch(
      `${base()}/api/wr/process?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
    )

    const res = await fetch(`${base()}/api/claxedo/agent-config/mcp/local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { A: "1" },
        disabled: true,
      }),
    })

    expect(res.status).toBe(200)

    const saved = JSON.parse(await fs.readFile(cfgFile(), "utf-8")) as {
      mcp: Record<string, unknown>
      harness: { id: string; access: string }
      auth: Record<string, string>
    }

    expect(saved.harness).toEqual({ id: "opencode", access: "native" })
    expect(saved.auth).toEqual({})
    expect(saved.mcp.local).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { A: "1" },
      disabled: true,
    })
  })

  test("streams workspace runtime events from the sandbox", async () => {
    const wsx = await workspace("events")
    await fetch(
      `${base()}/api/wr/process?workspaceId=${encodeURIComponent(wsx.id)}&directory=${encodeURIComponent(wsx.directory)}`,
    )

    const stream = sse(
      `${base()}/workspaces/${encodeURIComponent(wsx.id)}/api/wr/events`,
      (event) => event.type === "agent.lifecycle" && event.workspaceId === wsx.id,
    )
    await stream.ready

    const params = new URLSearchParams({
      tabId: "tab-1",
      terminalId: "term-1",
      workspaceId: wsx.id,
      eventType: "Start",
    })

    const res = await fetch(`${base()}/api/wr/hook/agent-lifecycle?${params}`)
    expect(res.status).toBe(200)

    const event = await stream.event
    expect(event).toMatchObject({
      type: "agent.lifecycle",
      workspaceId: wsx.id,
      terminalId: "term-1",
      eventType: "Busy",
    })

    const post = await fetch(`${base()}/api/wr/hook/agent-lifecycle?workspaceId=${encodeURIComponent(wsx.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tabId: "tab-1",
        terminalId: "term-1",
        workspaceId: wsx.id,
        provider: "claude",
        sessionId: "session-1",
        prompt: "hello",
        lastAssistantMessage: "done",
        eventType: "Idle",
      }),
    })
    expect(post.status).toBe(200)

    const session = await fetch(
      `${base()}/api/wr/hook/terminal-session?workspaceId=${encodeURIComponent(wsx.id)}&terminalId=term-1`,
    )
    expect(session.status).toBe(200)
    await expect(session.json()).resolves.toMatchObject({
      session: {
        eventType: "Idle",
        provider: "claude",
        sessionId: "session-1",
        lastAssistantMessage: "done",
      },
    })
  })

  test("streams workspace global events from the sandbox", async () => {
    const wsx = await workspace("global")
    await fetch(
      `${base()}/api/wr/process?workspaceId=${encodeURIComponent(wsx.id)}&directory=${encodeURIComponent(wsx.directory)}`,
    )

    const stream = sse(
      `${base()}/workspaces/${encodeURIComponent(wsx.id)}/global/event`,
      (event) => event.directory === wsx.directory && event.payload?.type === "session.updated",
    )
    await stream.ready

    emit({
      directory: wsx.directory,
      payload: {
        type: "session.updated",
        properties: { sessionID: "sess-1" },
      },
    })

    expect(await stream.event).toEqual({
      directory: wsx.directory,
      payload: {
        type: "session.updated",
        properties: { sessionID: "sess-1" },
      },
    })
  })

  test("rejects switching an existing session to a different runner", async () => {
    const ws = await workspace("runner-guard")
    const create = await fetch(
      `${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Guard" }),
      },
    )
    expect(create.status).toBe(201)
    const session = (await create.json()) as { id: string }

    const res = await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "claude-acp",
        sessionId: session.id,
        workspaceId: ws.id,
        directory: ws.directory,
      }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: {
        code: "agent_config_harness_change_locked",
        message: "Harness changes are only supported before a session is created",
      },
    })
  })

  test("rejects setting a model for a missing session", async () => {
    const ws = await workspace("model-guard")

    const res = await fetch(`${base()}/api/claxedo/agent-config/harness/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        sessionId: "ses_missing",
        workspaceId: ws.id,
        directory: ws.directory,
      }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: {
        code: "agent_config_session_model_locked",
        message: "Session model changes require an existing session",
      },
    })
  })

  test("lists experimental sessions through the sandbox", async () => {
    const ws = await workspace("session/meta")
    const rootRes = await fetch(
      `${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Root" }),
      },
    )
    expect(rootRes.status).toBe(201)
    const root = (await rootRes.json()) as { id: string }

    const childRes = await fetch(
      `${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Child" }),
      },
    )
    expect(childRes.status).toBe(201)
    const child = (await childRes.json()) as { id: string }

    const all = await fetch(
      `${base()}/experimental/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}&limit=10`,
    )
    expect(all.status).toBe(200)
    expect(
      (await all.json()).map((item: { id: string; title: string | null }) => ({
        id: item.id,
        title: item.title,
      })),
    ).toEqual([
      { id: child.id, title: "Child" },
      { id: root.id, title: "Root" },
    ])

    const roots = await fetch(
      `${base()}/experimental/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}&roots=true&limit=10`,
    )
    expect(roots.status).toBe(200)
    expect(
      (await roots.json()).map((item: { id: string; title: string | null }) => ({
        id: item.id,
        title: item.title,
      })),
    ).toEqual([
      { id: child.id, title: "Child" },
      { id: root.id, title: "Root" },
    ])
  })

  test("proxies PTY create and delete through the embedded sandbox", async () => {
    const wsx = await workspace("pty")

    const create = await fetch(`${base()}/api/wr/pty`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-workspace-id": wsx.id,
      },
      body: JSON.stringify({
        title: "integration",
        initialCommand: "printf integration-pty",
      }),
    })

    expect(create.status).toBe(200)
    const pty = (await create.json()) as { id: string }
    expect(pty.id).toBeTruthy()

    const del = await fetch(`${base()}/api/wr/pty/${encodeURIComponent(pty.id)}`, {
      method: "DELETE",
      headers: {
        "x-workspace-id": wsx.id,
      },
    })
    expect(del.status).toBe(200)
  })

  test("proxies opencode compat routes upstream and rejects removed legacy paths", async () => {
    const runner = await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "opencode" }),
    })
    expect(runner.status).toBe(200)

    const provider = await fetch(`${base()}/provider`)
    expect(provider.status).toBe(200)
    expect(await provider.json()).toEqual(indexedUpstreamProvider)

    // The default OpenCode harness proxies its engine provider catalog.
    const providers = await fetch(`${base()}/config/providers`)
    expect(providers.status).toBe(200)
    expect(await providers.json()).toEqual(upstreamConfigProviders)

    const oldDiff = await fetch(`${base()}/api/diff/targets`)
    expect(oldDiff.status).toBe(404)

    const oldHook = await fetch(`${base()}/hook/agent-lifecycle?tabId=t1&eventType=Start`)
    expect(oldHook.status).toBe(404)
  })
})
