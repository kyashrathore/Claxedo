import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { execSync } from "child_process"
import { createServer } from "node:net"

vi.mock("../../workspace/supervisor", async () => {
  const ensureMockSandbox = async (workspaceId: string) => {
    const bus = await import("../../platform/runtime/lib/bus")
    const store = await import("../../workspace/store")
    bus.claxedoBus.publish({
      type: "provision",
      workspaceId,
      step: "acquiring_sandbox",
      ts: Date.now(),
    })

    const ws = await store.getWorkspace(workspaceId)
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`)

    if (ws.workspace_name?.startsWith("fail")) {
      bus.claxedoBus.publish({
        type: "provision",
        workspaceId,
        step: "error",
        message: "mock provision failure",
        ts: Date.now(),
      })
      throw new Error("mock provision failure")
    }

    const next = await store.updateWorkspace(workspaceId, {
      status: "ready",
    })

    bus.claxedoBus.publish({
      type: "provision",
      workspaceId,
      step: "ready",
      ts: Date.now(),
    })

    return {
      status: "ready" as const,
      workspaceId,
      sandboxId: `sb-${workspaceId}`,
      hostId: `sb-${workspaceId}`,
      url: `http://runtime/${next?.id ?? workspaceId}`,
      homeRegion: "us-east" as const,
      epoch: 1,
    }
  }

  return {
    configureWorkspaceSupervisor: () => {},
    shutdownWorkspaceSupervisor: async () => {},
    workspaceSupervisorServerUrl: () => "http://127.0.0.1:3001",
    broadcastRuntimeConfig: async () => {},
    listSupervisorSandboxs: () => [],
    getSupervisorSandboxStatus: () => undefined,
    verifyWorkspaceRuntimeControlToken: () => false,
    holdSupervisorSandbox: () => {},
    releaseSupervisorSandbox: () => {},
    markSupervisorSandboxUse: () => {},
    touchSupervisorSandbox: () => {},
    getSupervisorSandboxTarget: () => undefined,
    getSandbox: () => undefined,
    getSandboxLease: () => undefined,
    listSandboxLeases: () => [],
    createWorkspaceSupervisorSandboxManager: () => ({
      ensure: ensureMockSandbox,
      target: async () => ({ status: "unavailable", reason: "runtime_lease_missing" }),
      touch: async () => ({ touched: false, status: "missing" }),
      stop: async () => ({ ok: true, status: "stopped" }),
      destroy: async () => ({ ok: true, status: "destroyed" }),
      release: async () => ({ released: false }),
      snapshot: async () => ({ ok: false, reason: "snapshot_unsupported" }),
      garbageCollect: async () => ({ destroyed: [], kept: [], skipped: [], failed: [] }),
      list: async () => [],
    }),
    syncWorkspaceRuntimeAgentExtensions: async () => {},
    injectRuntime: (ws: { id: string }, url: string) => ({ ws, url, status: "ready" }),
    discardSupervisorSandbox: async () => {},
    ensureSupervisorSandbox: ensureMockSandbox,
  }
})

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function sh(cmd: string) {
  execSync(cmd, { stdio: "ignore" })
}

const root = await fs.mkdtemp(path.join(realpathSync(os.tmpdir()), "claxedo-ui-create-"))
const home = path.join(root, "home")
const data = path.join(home, ".claxedo")

await fs.mkdir(home, { recursive: true })
await fs.mkdir(data, { recursive: true })
await fs.mkdir(path.join(data, "state"), { recursive: true })

const prev = {
  HOME: process.env.HOME,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  CLAXEDO_WORKGRAPH_REPOSITORY: process.env.CLAXEDO_WORKGRAPH_REPOSITORY,
  POSTHOG_KEY: process.env.POSTHOG_KEY,
}

process.env.HOME = home
process.env.CLAXEDO_DATA_DIR = data
process.env.CLAXEDO_STATE_DIR = path.join(data, "state")
process.env.CLAXEDO_WORKGRAPH_REPOSITORY = path.resolve(import.meta.dirname, "../../../../..")
process.env.POSTHOG_KEY = ""

const [serverMod, store, agent] = await Promise.all([
  import("../../deployments/local/server"),
  import("../../workspace/store"),
  import("../../agent-config"),
])

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
  return await store.ensureWorkspace({
    workspaceId: `ws_${randomUUID()}`,
    directory,
  })
}

describe("cloud create UI integration", () => {
  let upstreamPort = 0
  let serverPort = 0
  let upstream: import("@hono/node-server").ServerType
  let server: ReturnType<typeof serverMod.startServer>
  let upstreamClosed = false

  beforeAll(async () => {
    upstreamPort = await port()
    serverPort = await port()
    const { serve } = await import("@hono/node-server")
    upstream = serve({
      port: upstreamPort,
      hostname: "127.0.0.1",
      fetch(req) {
        const pathname = new URL(req.url).pathname
        if (pathname === "/provider") {
          return json({
            all: [{ id: "upstream", name: "Upstream", env: [], models: {} }],
            default: {},
            connected: ["upstream"],
          })
        }
        if (pathname === "/provider/auth") return json({ upstream: [{ type: "oauth", label: "Login" }] })
        if (pathname === "/config/providers") return json({ providers: [], default: {} })
        if (pathname === "/global/config") return json({ model: "upstream/mock", provider: {}, mcp: {} })
        if (pathname === "/global/event") {
          return new Response("data: " + JSON.stringify({
            directory: "global",
            payload: { type: "server.connected", properties: {} },
          }) + "\n\n", {
            headers: { "Content-Type": "text/event-stream" },
          })
        }
        return json({ error: "not found" }, 404)
      },
    })
    server = serverMod.startServer(serverPort, `http://127.0.0.1:${upstreamPort}`)
  })

  beforeEach(async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "opencode" },
      sandbox_driver: {
        auth: {
          daytona: {
            api_key: "test-daytona-key",
          },
        },
      },
    })
  })

  afterAll(async () => {
    server?.close()
    if (!upstreamClosed) upstream?.close()
    process.env.HOME = prev.HOME
    process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
    process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
    if (prev.CLAXEDO_WORKGRAPH_REPOSITORY === undefined) delete process.env.CLAXEDO_WORKGRAPH_REPOSITORY
    else process.env.CLAXEDO_WORKGRAPH_REPOSITORY = prev.CLAXEDO_WORKGRAPH_REPOSITORY
    process.env.POSTHOG_KEY = prev.POSTHOG_KEY
    await fs.rm(root, { recursive: true, force: true })
  })

  test("UI cloud create flow provisions a workspace and exposes it via bootstrap", async () => {
    const project = await repo("ui-cloud")
    const pending = sse(
      `http://127.0.0.1:${serverPort}/api/claxedo/events`,
      (event) => event.type === "provision" && event.step === "ready",
    )

    const res = await fetch(`http://127.0.0.1:${serverPort}/api/workspace/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project?.project_id,
        repoUrl: "https://github.com/foo/ui-cloud.git",
        workspaceName: "kind-island",
      }),
    })

    expect(res.status).toBe(200)
    const created = await res.json() as { workspaceId: string; directory: string; projectId: string }

    const event = await pending
    expect(event.workspaceId).toBe(created.workspaceId)

    const boot = await wait(async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/claxedo/bootstrap`)
      if (!res.ok) return
      return await res.json() as {
        healthy: boolean
        project: Array<{
          id: string
          workspaces: Record<string, { id: string; kind: string; status?: string; workspace_name?: string; directory?: string }>
        }>
      }
    })
    if (!boot) throw new Error("bootstrap unavailable")

    expect(boot.healthy).toBe(true)
    const hit = boot.project.find((item) => item.id === created.projectId)
    expect(hit).toBeDefined()
    const workspace = Object.values(hit?.workspaces ?? {}).find((item) => item.id === created.workspaceId)
    expect(workspace).toMatchObject({
      kind: "cloud",
      status: "ready",
      workspace_name: "kind-island",
      directory: created.directory,
    })

    const resolved = await fetch(
      `http://127.0.0.1:${serverPort}/api/workspace/resolve?workspaceId=${encodeURIComponent(created.workspaceId)}`,
    )
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toMatchObject({
      workspaceId: created.workspaceId,
      status: "ready",
      kind: "cloud",
    })
  })

  test("failed cloud create emits an error and does not survive bootstrap", async () => {
    const project = await repo("ui-cloud-fail")
    const pending = sse(
      `http://127.0.0.1:${serverPort}/api/claxedo/events`,
      (event) => event.type === "provision" && event.step === "error",
    )

    const res = await fetch(`http://127.0.0.1:${serverPort}/api/workspace/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project?.project_id,
        repoUrl: "https://github.com/foo/ui-cloud-fail.git",
        workspaceName: "fail-wolf",
      }),
    })

    expect(res.status).toBe(200)
    const created = await res.json() as { workspaceId: string; directory: string; projectId: string }

    const event = await pending
    expect(event.workspaceId).toBe(created.workspaceId)
    expect(event.message).toBe("mock provision failure")

    await wait(async () => {
      const gone = await fetch(
        `http://127.0.0.1:${serverPort}/api/workspace/resolve?workspaceId=${encodeURIComponent(created.workspaceId)}`,
      )
      if (gone.status === 404) return true
    })

    const boot = await fetch(`http://127.0.0.1:${serverPort}/api/claxedo/bootstrap`)
    expect(boot.status).toBe(200)
    const body = await boot.json() as {
      project: Array<{
        id: string
        workspaces: Record<string, unknown>
      }>
    }
    const hit = body.project.find((item) => item.id === created.projectId)
    expect(hit?.workspaces[created.directory]).toBeUndefined()
  })

  test("cloud workspace delete stops exposing the workspace", async () => {
    const pending = sse(
      `http://127.0.0.1:${serverPort}/api/claxedo/events`,
      (item) => item.type === "provision" && item.step === "ready",
    )

    const res = await fetch(`http://127.0.0.1:${serverPort}/api/workspace/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/kyashrathore/formlink.git",
        workspaceName: "trim-fox",
      }),
    })

    expect(res.status).toBe(200)
    const created = await res.json() as { workspaceId: string; directory: string; projectId: string }
    const event = await pending
    expect(event.workspaceId).toBe(created.workspaceId)

    const gone = await fetch(`http://127.0.0.1:${serverPort}/api/workspace/${encodeURIComponent(created.workspaceId)}`, {
      method: "DELETE",
    })
    expect(gone.status).toBe(200)

    await wait(async () => {
      const res = await fetch(
        `http://127.0.0.1:${serverPort}/api/workspace/resolve?workspaceId=${encodeURIComponent(created.workspaceId)}`,
      )
      if (res.status === 404) return true
    })
  })

  test("bootstrap stays healthy when upstream opencode is unavailable", async () => {
    const project = await repo("ui-cloud-bootstrap-fallback")
    upstream.close()
    upstreamClosed = true

    const res = await fetch(`http://127.0.0.1:${serverPort}/api/claxedo/bootstrap`)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      healthy: boolean
      provider: { all: unknown[]; default: Record<string, unknown>; connected: unknown[] }
      provider_auth: Record<string, unknown>
      config: { model: string; provider: Record<string, unknown>; mcp: Record<string, unknown> }
      config_providers: { providers: unknown[]; default: Record<string, unknown> }
      project: Array<{ id: string }>
    }

    expect(body.healthy).toBe(true)
    expect(body.provider).toEqual({
      all: [],
      default: {},
      connected: [],
    })
    expect(body.provider_auth["codex-acp"]).toEqual([
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ])
    expect(body.provider_auth["claude-acp"]).toEqual([{ type: "api", label: "API Key" }])
    expect(body.provider_auth["claude-sdk"]).toEqual([{ type: "api", label: "API Key" }])
    expect(body.provider_auth["codex-app-server"]).toEqual([{ type: "api", label: "API Key" }])
    expect(body.config).toEqual({
      model: "",
      provider: {},
      mcp: {},
    })
    expect(body.config_providers).toEqual({
      providers: [],
      default: {},
    })
    expect(body.project.some((item) => item.id === project?.project_id)).toBe(true)
  })
})
