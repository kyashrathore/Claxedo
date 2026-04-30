import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { defined } from "./fixtures/assert-helpers"
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

async function sse(url: string, match: (event: any) => boolean, ms = 5_000) {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), ms)
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: ctrl.signal,
  })
  if (!res.ok || !res.body) {
    clearTimeout(timeout)
    throw new Error(`SSE failed: ${res.status}`)
  }
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
        const event = JSON.parse(data)
        if (match(event)) return event
      }
    }
  } finally {
    clearTimeout(timeout)
    ctrl.abort()
    await reader.cancel().catch(() => undefined)
  }

  throw new Error("SSE ended before matching event")
}

async function ws(url: string, match: (data: string) => boolean, ms = 5_000) {
  return await new Promise<string>((resolve, reject) => {
    const sock = new WebSocket(url)
    const timeout = setTimeout(() => {
      sock.close()
      reject(new Error("timed out waiting for websocket data"))
    }, ms)

    sock.binaryType = "arraybuffer"
    sock.onmessage = (event) => {
      if (typeof event.data !== "string") return
      if (!match(event.data)) return
      clearTimeout(timeout)
      sock.close()
      resolve(event.data)
    }
    sock.onerror = () => {
      clearTimeout(timeout)
      reject(new Error("websocket error"))
    }
    sock.onclose = (event) => {
      if (event.code === 1000) return
      clearTimeout(timeout)
      reject(new Error(`websocket closed: ${event.code} ${event.reason}`))
    }
  })
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

const [serverMod, supervisor, store, agent, hooks, local, opauth] = await Promise.all([
  import("./server"),
  import("./workspace-supervisor"),
  import("./workspace-store"),
  import("./agent-config"),
  import("./agent-hooks"),
  import("./local-agent-engine"),
  import("./opencode-auth"),
])

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
  const ws = defined(await store.ensureWorkspace({
    workspaceId: `ws_${randomUUID()}`,
    directory,
    kind,
  }))
  if (kind === "cloud") {
    supervisor.injectRuntime(ws, `http://127.0.0.1:${upstreamPort}`)
  }
  return ws
}

function sh(cmd: string) { execSync(cmd, { stdio: "ignore" }) }

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
  return defined(await store.ensureWorkspace({
    workspaceId: `ws_${randomUUID()}`,
    directory,
  }))
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
              next.enqueue(enc.encode(`data: ${JSON.stringify({
                directory: "global",
                payload: {
                  type: "server.connected",
                  properties: {},
                },
              })}\n\n`))
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
        if (pathname === "/question") return json([{ id: "q1", sessionID: "sess_1", questions: [{ text: "Continue?" }] }])
        if (pathname === "/lsp") return json([{ id: "ts", name: "typescript", root: ".", status: "connected" }])
        if (pathname === "/vcs") return json({ branch: "main" })
        return json({ error: "not found" }, 404)
      },
    })

    server = serverMod.startServer(serverPort, `http://127.0.0.1:${upstreamPort}`)
  })

  beforeEach(async () => {
    await local.shutdownLocalAgentEngine()
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
      runner: { type: "opencode" },
    })
    await hooks.rebuildOpencodeJsonc()
  })

  afterAll(async () => {
    await local.shutdownLocalAgentEngine()
    await supervisor.shutdownWorkspaceSupervisor()
    server?.close()
    upstream?.close()
    process.env.HOME = prev.HOME
    process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
    process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
    process.env.POSTHOG_KEY = prev.POSTHOG_KEY
    await fs.rm(root, { recursive: true, force: true })
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

    const event = await sse(
      `${base()}/global/event`,
      (item) => item.directory === "global" && item.payload?.type === "server.connected",
    )
    expect(event).toEqual({
      directory: "global",
      payload: {
        type: "server.connected",
        properties: {},
      },
    })

    const boot = await fetch(`${base()}/api/claxedo/bootstrap`)
    expect(boot.status).toBe(200)
    const body = await boot.json() as {
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
    expect(body.provider).toEqual(upstreamProvider)
    expect(body.provider_auth).toEqual({ upstream: [{ type: "oauth", label: "Login" }] })
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
    const url = `${base()}/api/claxedo/process?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`

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
    expect(supervisor.listWorkspaceRuntimes().find((item) => item.workspaceId === ws.id)).toBeUndefined()

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
    expect(supervisor.listWorkspaceRuntimes().find((item) => item.workspaceId === ws.id)).toBeUndefined()
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
    const body = await res.json() as {
      project: Array<{
        id: string
        worktree: string
        sandboxes: string[]
      }>
    }

    const hit = body.project.find((item) => item.id === root.project_id)
    expect(hit).toBeDefined()
    expect(hit?.worktree).toBe(root.directory)
    expect(hit?.sandboxes).toContain(child.directory)
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
    expect(await status.json()).toEqual({ active: { type: "busy" } })

    const mcp = await fetch(`${base()}/mcp`)
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toEqual({ local: { status: "connected" } })

    const question = await fetch(`${base()}/question`)
    expect(question.status).toBe(200)
    expect(await question.json()).toEqual([{ id: "q1", sessionID: "sess_1", questions: [{ text: "Continue?" }] }])

    const lsp = await fetch(`${base()}/lsp`)
    expect(lsp.status).toBe(200)
    expect(await lsp.json()).toEqual([{ id: "ts", name: "typescript", root: ".", status: "connected" }])

    const vcs = await fetch(`${base()}/vcs`)
    expect(vcs.status).toBe(200)
    expect(await vcs.json()).toEqual({ branch: "main" })
  })

  test("manages local worktrees in-process and keeps them in the project catalog", async () => {
    const ws = await repo("worktree-local")

    const pending = sse(
      `${base()}/global/event`,
      (event) => event.directory?.includes("/worktree/") && event.payload?.type === "worktree.ready",
    )

    const create = await fetch(`${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(create.status).toBe(200)
    const created = await create.json() as { name: string; branch: string; directory: string }
    expect(created.directory).toContain("/worktree/")
    expect(created.branch.startsWith("opencode/")).toBe(true)

    const event = await pending
    expect(event).toEqual({
      directory: created.directory,
      payload: {
        type: "worktree.ready",
        properties: {
          name: created.name,
          branch: created.branch,
        },
      },
    })

    const list = await fetch(`${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)
    expect(list.status).toBe(200)
    const listed = await list.json() as string[]
    const ckey = await fs.realpath(created.directory).catch(() => path.resolve(created.directory))
    const lkeys = await Promise.all(listed.map((item) => fs.realpath(item).catch(() => path.resolve(item))))
    expect(lkeys).toContain(ckey)

    const stored = await store.getWorkspaceByDirectory(created.directory)
    expect(stored?.project_id).toBe(ws.project_id)

    const removed = await fetch(`${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: created.directory }),
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toBe(true)
    expect(await store.getWorkspaceByDirectory(created.directory)).toBeUndefined()
  })

  test("removes stale worktrees after the directory was deleted outside claxedo", async () => {
    const ws = await repo("worktree-missing")

    const create = await fetch(`${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(create.status).toBe(200)
    const created = await create.json() as { directory: string }

    await fs.rm(created.directory, { recursive: true, force: true })

    const removed = await fetch(`${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: created.directory }),
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toBe(true)
    expect(await store.getWorkspaceByDirectory(created.directory)).toBeUndefined()
  })

  test("file status returns quickly for a deleted worktree directory", async () => {
    const ws = await repo("worktree-status-missing")

    const create = await fetch(`${base()}/experimental/worktree?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(create.status).toBe(200)
    const created = await create.json() as { directory: string }

    await fs.rm(created.directory, { recursive: true, force: true })

    const res = await fetch(`${base()}/file/status?directory=${encodeURIComponent(created.directory)}`, {
      signal: AbortSignal.timeout(1_000),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("proxies cloud session routes through workspace-runtime", async () => {
    const ws = await workspace("cloud-session", "cloud")
    const res = await fetch(`${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])

    const runtime = await wait(() => supervisor.listWorkspaceRuntimes().find((item) => item.workspaceId === ws.id))
    expect(runtime?.workspaceId).toBe(ws.id)
  })

  test("proxies cloud bootstrap status routes through workspace-runtime", async () => {
    const ws = await workspace("cloud-status", "cloud")

    const status = await fetch(`${base()}/session/status?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ active: { type: "busy" } })

    const mcp = await fetch(`${base()}/mcp?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toEqual({ local: { status: "connected" } })

    const question = await fetch(`${base()}/question?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)
    expect(question.status).toBe(200)
    expect(await question.json()).toEqual([{ id: "q1", sessionID: "sess_1", questions: [{ text: "Continue?" }] }])

    const lsp = await fetch(`${base()}/lsp?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)
    expect(lsp.status).toBe(200)
    expect(await lsp.json()).toEqual([{ id: "ts", name: "typescript", root: ".", status: "connected" }])

    const vcs = await fetch(`${base()}/vcs?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)
    expect(vcs.status).toBe(200)
    expect(await vcs.json()).toEqual({ branch: "main" })
  })

  test("cloud status forwarding uses shared opencode auth headers", async () => {
    const ws = await workspace("cloud-status-auth", "cloud")
    opauth.configureOpenCodeAuth("desk-secret")

    const status = await fetch(`${base()}/session/status?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ active: { type: "busy" } })
    expect(statusAuth).toBe(`Basic ${Buffer.from("opencode:desk-secret").toString("base64")}`)
    expect(statusDir).toBe(ws.directory)
    expect(statusWs).toBe(ws.id)
  })

  test("keeps persisted MCP config raw while fan-out runs against a live runtime", async () => {
    const ws = await workspace("config")
    await fetch(`${base()}/api/claxedo/process?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`)

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

    await new Promise((resolve) => setTimeout(resolve, 500))

    const saved = JSON.parse(await fs.readFile(cfgFile(), "utf-8")) as {
      mcp: Record<string, unknown>
      runner: { type: string }
      auth: Record<string, string>
    }

    expect(saved.runner.type).toBe("opencode")
    expect(saved.auth).toEqual({})
    expect(saved.mcp.local).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { A: "1" },
      disabled: true,
    })
  })

  test("aggregates workspace runtime events through the control-plane SSE stream", async () => {
    const wsx = await workspace("events")
    await fetch(`${base()}/api/claxedo/process?workspaceId=${encodeURIComponent(wsx.id)}&directory=${encodeURIComponent(wsx.directory)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))

    const pending = sse(
      `${base()}/api/claxedo/events`,
      (event) => event.type === "agent.lifecycle" && event.workspaceId === wsx.id,
    )

    const params = new URLSearchParams({
      tabId: "tab-1",
      terminalId: "term-1",
      workspaceId: wsx.id,
      eventType: "Start",
    })

    const res = await fetch(`${base()}/api/claxedo/hook/agent-lifecycle?${params}`)
    expect(res.status).toBe(200)

    const event = await pending
    expect(event).toMatchObject({
      type: "agent.lifecycle",
      workspaceId: wsx.id,
      terminalId: "term-1",
      eventType: "Busy",
    })
  })

  test("fans workspace global events into the control-plane global stream", async () => {
    const wsx = await workspace("global")
    await fetch(`${base()}/api/claxedo/process?workspaceId=${encodeURIComponent(wsx.id)}&directory=${encodeURIComponent(wsx.directory)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))

    const pending = sse(
      `${base()}/global/event`,
      (event) => event.directory === wsx.directory && event.payload?.type === "session.updated",
    )

    emit({
      directory: wsx.directory,
      payload: {
        type: "session.updated",
        properties: { sessionID: "sess-1" },
      },
    })

    expect(await pending).toEqual({
      directory: wsx.directory,
      payload: {
        type: "session.updated",
        properties: { sessionID: "sess-1" },
      },
    })
  })

  test("rejects switching an existing session to a different runner", async () => {
    const ws = await workspace("runner-guard")
    const create = await fetch(`${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Guard" }),
    })
    expect(create.status).toBe(201)
    const session = await create.json() as { id: string }

    const res = await fetch(`${base()}/api/claxedo/agent-config/runner`, {
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
      error: "Runner changes are only supported before a session is created",
    })
  })

  test("enriches experimental session list with claxedo tags and lineage", async () => {
    const ws = await workspace("session-meta")
    const rootRes = await fetch(`${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Root" }),
    })
    expect(rootRes.status).toBe(201)
    const root = await rootRes.json() as { id: string }

    const childRes = await fetch(`${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child" }),
    })
    expect(childRes.status).toBe(201)
    const child = await childRes.json() as { id: string }

    const meta = await fetch(`${base()}/api/claxedo/session/${encodeURIComponent(child.id)}/meta`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentID: root.id,
        tags: ["review", "page"],
        attachments: [
          { kind: "review", targetID: "rev_1" },
          { kind: "page", targetID: "page_1" },
        ],
      }),
    })
    expect(meta.status).toBe(200)
    expect(await meta.json()).toMatchObject({
      sessionID: child.id,
      parentID: root.id,
      rootID: root.id,
      tags: ["page", "review"],
    })

    const all = await fetch(`${base()}/experimental/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}&limit=10`)
    expect(all.status).toBe(200)
    expect(await all.json()).toMatchObject([
      {
        id: child.id,
        title: "Child",
        directory: ws.directory,
        time: {
          created: expect.any(Number),
          updated: expect.any(Number),
        },
        projectID: ws.project_id,
        parentID: root.id,
        rootID: root.id,
        tags: ["page", "review"],
        attachments: [
          { kind: "page", targetID: "page_1" },
          { kind: "review", targetID: "rev_1" },
        ],
        environment: { kind: "local" },
        git: {},
      },
      {
        id: root.id,
        title: "Root",
        directory: ws.directory,
        time: {
          created: expect.any(Number),
          updated: expect.any(Number),
        },
        projectID: ws.project_id,
        rootID: root.id,
        tags: [],
        attachments: [],
        environment: { kind: "local" },
        git: {},
      },
    ])

    const roots = await fetch(`${base()}/experimental/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}&roots=true&limit=10`)
    expect(roots.status).toBe(200)
    expect(await roots.json()).toMatchObject([
      {
        id: root.id,
        title: "Root",
        directory: ws.directory,
        time: {
          created: expect.any(Number),
          updated: expect.any(Number),
        },
        projectID: ws.project_id,
        rootID: root.id,
        tags: [],
        attachments: [],
        environment: { kind: "local" },
        git: {},
      },
    ])
  })

  test("proxies PTY create and websocket attach through the control plane", async () => {
    const wsx = await workspace("pty")

    const create = await fetch(`${base()}/api/claxedo/pty`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-workspace-id": wsx.id,
      },
      body: JSON.stringify({
        command: "/bin/sh",
        args: ["-lc", "printf integration-pty"],
        cwd: wsx.directory,
      }),
    })

    expect(create.status).toBe(200)
    const pty = await create.json() as { id: string }
    expect(pty.id).toBeTruthy()

    const text = await ws(
      `ws://127.0.0.1:${serverPort}/api/claxedo/pty/${encodeURIComponent(pty.id)}/connect`,
      (data) => data.includes("integration-pty"),
    )

    expect(text).toContain("integration-pty")

    const del = await fetch(`${base()}/api/claxedo/pty/${encodeURIComponent(pty.id)}`, {
      method: "DELETE",
    })
    expect(del.status).toBe(200)
  })

  test("proxies opencode compat routes upstream and rejects removed legacy paths", async () => {
    const runner = await fetch(`${base()}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "opencode" }),
    })
    expect(runner.status).toBe(200)

    const provider = await fetch(`${base()}/provider`)
    expect(provider.status).toBe(200)
    expect(await provider.json()).toEqual(upstreamProvider)

    const providers = await fetch(`${base()}/config/providers`)
    expect(providers.status).toBe(200)
    expect(await providers.json()).toEqual(upstreamConfigProviders)

    const oldDiff = await fetch(`${base()}/api/diff/targets`)
    expect(oldDiff.status).toBe(404)

    const oldHook = await fetch(`${base()}/hook/agent-lifecycle?tabId=t1&eventType=Start`)
    expect(oldHook.status).toBe(404)
  })
})
