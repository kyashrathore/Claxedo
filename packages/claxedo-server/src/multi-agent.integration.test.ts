/**
 * Multi-Agent Integration Tests
 *
 * These tests verify the full HTTP contract of the runner/auth/provider/config
 * subsystem, exercising the real claxedo-server over HTTP. No mocking of
 * internal modules — we hit real endpoints and assert the response shape and
 * persistence behavior.
 *
 * Regression targets:
 *  - Runner type validation
 *  - Auth store/remove round-trips and connected provider list
 *  - Provider endpoint switches between upstream proxy and ACP-local mode
 *  - MCP server CRUD with validation
 *  - Command CRUD with sanitization
 *  - Config persistence format stability
 *  - Bootstrap response shape for both opencode and ACP modes
 *  - Runner model setting at global and session level
 *  - Global dispose shim returns true
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { defined } from "./fixtures/assert-helpers"
import { execSync } from "child_process"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const enc = new TextEncoder()
const upstreamSubs = new Set<ReadableStreamDefaultController<Uint8Array>>()

const root = await fs.mkdtemp(path.join(realpathSync(os.tmpdir()), "claxedo-ma-int-"))
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
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
}

process.env.HOME = home
process.env.CLAXEDO_DATA_DIR = data
process.env.CLAXEDO_STATE_DIR = path.join(data, "state")
process.env.CLAXEDO_WORKGRAPH_REPOSITORY = path.resolve(import.meta.dirname, "../../..")
process.env.POSTHOG_KEY = ""
// Clear env keys so tests control the connected state
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.CURSOR_API_KEY

const [serverMod, supervisor, store, agent, embedded] = await Promise.all([
  import("./server"),
  import("./workspace-supervisor"),
  import("./workspace-store"),
  import("./agent-config"),
  import("./embedded-workspace-runtime"),
])

const upstreamProvider = {
  all: [{ id: "upstream", name: "Upstream", env: [], models: { "up-model": { id: "up-model", name: "Up Model" } } }],
  default: { upstream: "up-model" },
  connected: ["upstream"],
}

const upstreamConfig = { model: "upstream/up-model", provider: {}, mcp: {} }

let upstreamPort = 0
let serverPort = 0
let upstream: import("@hono/node-server").ServerType
let server: ReturnType<typeof serverMod.startServer>

function sh(cmd: string) {
  execSync(cmd, { stdio: "ignore" })
}

async function workspace(label: string) {
  const directory = path.join(root, "workspaces", `${label}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "README.md"), "# test\n")
  sh(`git init -b main ${directory}`)
  sh(`git -C ${directory} config user.email test@example.com`)
  sh(`git -C ${directory} config user.name test`)
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
  return path.join(data, "user-agent-config.json")
}

async function savedConfig() {
  return JSON.parse(await fs.readFile(cfgFile(), "utf-8")) as {
    mcp: Record<string, unknown>
    harness?: { id: string; access: string; connection?: { kind: string; binary?: string } }
    model?: string
    auth?: Record<string, string>
    sandbox?: unknown
  }
}

describe("multi-agent integration", () => {
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
          return new Response(
            new ReadableStream<Uint8Array>({
              start(next) {
                ctrl = next
                upstreamSubs.add(next)
                next.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`,
                  ),
                )
              },
              cancel() {
                if (ctrl) upstreamSubs.delete(ctrl)
              },
            }),
            { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
          )
        }
        if (pathname === "/provider") return json(upstreamProvider)
        if (pathname === "/provider/auth") return json({ upstream: [{ type: "oauth", label: "Login" }] })
        if (pathname === "/config/providers")
          return json({ providers: upstreamProvider.all, default: upstreamProvider.default })
        if (pathname === "/config" || pathname === "/global/config") return json(upstreamConfig)
        return json({ error: "not found" }, 404)
      },
    })

    server = serverMod.startServer(serverPort, `http://127.0.0.1:${upstreamPort}`)
  })

  beforeEach(async () => {
    embedded.shutdownEmbeddedWorkspaceRuntimes()
    await supervisor.shutdownWorkspaceSupervisor()
    await new Promise((resolve) => setTimeout(resolve, 100))
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.CURSOR_API_KEY
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
    for (const [k, v] of Object.entries(prev)) {
      if (v !== undefined) (process.env as any)[k] = v
      else delete (process.env as any)[k]
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  // ── Runner type validation ──────────────────────────────────────────

  test("POST /runner rejects missing type", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        code: "agent_config_harness_required",
      },
    })
  })

  test("POST /runner rejects invalid type", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "gpt-acp" }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        code: "agent_config_harness_required",
      },
    })
  })

  test("POST /runner accepts all valid runner types", async () => {
    for (const type of ["claude-acp", "codex-acp", "cursor-acp", "claude-sdk", "codex-app-server", "cursor-sdk", "opencode", "pi"]) {
      const res = await fetch(`${base()}/api/claxedo/agent-config/harness`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
  })

  test("POST /runner persists chosen runner to disk", async () => {
    await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "claude-acp" }),
    })

    const cfg = await savedConfig()
    expect(cfg.harness).toMatchObject({ id: "claude", access: "acp" })
  })

  test("POST /runner preserves model when switching to same type", async () => {
    // Set claude-acp with a model first
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp", model: "claude-opus-4-6" },
    })

    // Switch to claude-acp again (same type)
    await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "claude-acp" }),
    })

    const cfg = await savedConfig()
    expect(cfg.harness).toMatchObject({ id: "claude", access: "acp" })
    expect(cfg.model).toBe("claude-opus-4-6")
  })

  test("POST /runner drops model when switching to different type", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp", model: "claude-opus-4-6" },
    })

    await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "codex-acp" }),
    })

    const cfg = await savedConfig()
    expect(cfg.harness).toMatchObject({ id: "codex", access: "acp" })
    expect(cfg.model).toBeUndefined()
  })

  // ── Runner GET ─────────────────────────────────────────────────────

  test("GET /runner returns configured runner state without workspace", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/harness`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; activeType: string; status: string }
    expect(body.id).toBe("opencode")
    expect(body.activeType).toBe("opencode")
    expect(body.status).toBe("configured")
  })

  // ── Runner model ───────────────────────────────────────────────────

  test("POST /runner/model rejects missing model", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/harness/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        code: "agent_config_harness_model_required",
      },
    })
  })

  test("POST /runner/model sets model on global runner", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    const res = await fetch(`${base()}/api/claxedo/agent-config/harness/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6" }),
    })
    expect(res.status).toBe(200)

    const cfg = await savedConfig()
    expect(cfg.model).toBe("claude-opus-4-6")
  })

  test("POST /runner/model rejects runners without runner model configuration", async () => {
    for (const type of ["opencode", "pi"] as const) {
      await agent.saveUserConfig({
        mcp: {},
        auth: {},
        runner: { type },
      })

      const res = await fetch(`${base()}/api/claxedo/agent-config/harness/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "anything" }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        error: {
          code: "agent_config_harness_model_unsupported",
        },
      })
    }
  })

  // ── Auth store / remove ────────────────────────────────────────────

  test("PUT /auth stores API key and keeps the local harness catalog available", async () => {
    // Switch to ACP mode so provider endpoint uses local ACP response
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    const put = await fetch(`${base()}/auth/claude-acp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { key: "sk-ant-test-key" } }),
    })
    expect(put.status).toBe(200)

    // Verify persisted via credential registry (not config file —
    // PUT /auth stores through putCredential, not plaintext config)
    const { resolveSecret } = await import("./credentials/registry")
    const secret = await resolveSecret("claude-acp")
    expect(secret).toBe("sk-ant-test-key")

    const provider = await fetch(`${base()}/provider`)
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({
      all: expect.arrayContaining([expect.objectContaining({ id: "claude-acp", models: {} })]),
      default: {},
    })
  })

  test("DELETE /auth removes API key and updates connected list", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: { "claude-acp": "sk-ant-to-remove" },
      runner: { type: "claude-acp" },
    })

    const del = await fetch(`${base()}/auth/claude-acp`, { method: "DELETE" })
    expect(del.status).toBe(200)

    const cfg = await savedConfig()
    expect(cfg.auth?.["claude-acp"]).toBeUndefined()

    const provider = await fetch(`${base()}/provider`)
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({
      all: expect.arrayContaining([expect.objectContaining({ id: "claude-acp", models: {} })]),
      default: {},
    })
  })

  test("PUT /auth rejects missing key", async () => {
    const res = await fetch(`${base()}/auth/claude-acp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test("env var ANTHROPIC_API_KEY auto-connects claude-acp provider", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-test"
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    const provider = await fetch(`${base()}/provider`)
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({
      connected: expect.arrayContaining(["claude-acp", "claude-sdk"]),
    })
    delete process.env.ANTHROPIC_API_KEY
  })

  // ── Provider endpoint mode switching ──────────────────────────────

  test("provider endpoint returns upstream data in opencode mode", async () => {
    const res = await fetch(`${base()}/provider`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { all: Array<{ id: string }> }
    expect(body.all.some((p) => p.id === "upstream")).toBe(true)
  })

  test("provider endpoint returns the local harness catalog in ACP mode", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    const res = await fetch(`${base()}/provider`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      all: expect.arrayContaining([expect.objectContaining({ id: "claude-acp", models: {} })]),
      connected: [],
      default: {},
    })
  })

  test("provider/auth returns ACP auth methods in ACP mode", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    const res = await fetch(`${base()}/provider/auth`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, Array<{ type: string; label: string }>>
    expect(body["claude-acp"]).toBeDefined()
    expect(body["claude-acp"][0].type).toBe("api")
    expect(body["codex-acp"]).toBeDefined()
    expect(body["cursor-acp"]).toBeDefined()
  })

  // ── MCP server CRUD ────────────────────────────────────────────────

  test("MCP CRUD: create, list, delete a stdio server", async () => {
    // Create
    const create = await fetch(`${base()}/api/claxedo/agent-config/mcp/my-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stdio",
        command: "npx",
        args: ["-y", "mcp-tool"],
        env: { TOOL_MODE: "test" },
      }),
    })
    expect(create.status).toBe(200)
    expect(await create.json()).toEqual({ ok: true, name: "my-tool" })

    // List
    const list = await fetch(`${base()}/api/claxedo/agent-config/mcp`)
    expect(list.status).toBe(200)
    const servers = (await list.json()) as Record<string, { type: string; command: string }>
    expect(servers["my-tool"]).toBeDefined()
    expect(servers["my-tool"].type).toBe("stdio")
    expect(servers["my-tool"].command).toBe("npx")

    // Delete
    const del = await fetch(`${base()}/api/claxedo/agent-config/mcp/my-tool`, {
      method: "DELETE",
    })
    expect(del.status).toBe(200)

    // Verify deleted
    const after = await fetch(`${base()}/api/claxedo/agent-config/mcp`)
    const afterServers = (await after.json()) as Record<string, unknown>
    expect(afterServers["my-tool"]).toBeUndefined()
  })

  test("MCP create validates server name format", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/mcp/bad name!`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stdio", command: "node" }),
    })
    expect(res.status).toBe(400)
  })

  test("MCP create validates type field", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/mcp/valid-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "grpc", command: "node" }),
    })
    expect(res.status).toBe(400)
  })

  test("MCP stdio requires command", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/mcp/valid-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stdio" }),
    })
    expect(res.status).toBe(400)
  })

  test("MCP remote requires url", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/mcp/valid-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "remote" }),
    })
    expect(res.status).toBe(400)
  })

  test("MCP create remote server with headers", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/mcp/remote-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "remote",
        url: "https://mcp.example.com/sse",
        headers: { Authorization: "Bearer token" },
      }),
    })
    expect(res.status).toBe(200)

    const cfg = await savedConfig()
    const mcpServer = cfg.mcp["remote-tool"] as { type: string; url: string; headers: Record<string, string> }
    expect(mcpServer.type).toBe("remote")
    expect(mcpServer.url).toBe("https://mcp.example.com/sse")
    expect(mcpServer.headers.Authorization).toBe("Bearer token")
  })

  test("MCP delete of nonexistent server returns 404", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/mcp/nonexistent`, {
      method: "DELETE",
    })
    expect(res.status).toBe(404)
  })

  // ── Command CRUD ───────────────────────────────────────────────────

  test("command CRUD: create, get, list, delete", async () => {
    // Create
    const create = await fetch(`${base()}/api/claxedo/agent-config/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "deploy", content: "Run deployment" }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { ok: boolean; name: string }
    expect(created.ok).toBe(true)
    expect(created.name).toBe("deploy")

    // Get
    const get = await fetch(`${base()}/api/claxedo/agent-config/commands/deploy`)
    expect(get.status).toBe(200)
    const cmd = (await get.json()) as { name: string; content: string }
    expect(cmd.name).toBe("deploy")
    expect(cmd.content).toBe("Run deployment")

    // List
    const list = await fetch(`${base()}/api/claxedo/agent-config/commands`)
    expect(list.status).toBe(200)
    const cmds = (await list.json()) as Array<{ name: string }>
    expect(cmds.some((c) => c.name === "deploy")).toBe(true)

    // Delete
    const del = await fetch(`${base()}/api/claxedo/agent-config/commands/deploy`, {
      method: "DELETE",
    })
    expect(del.status).toBe(200)

    // Verify deleted
    const after = await fetch(`${base()}/api/claxedo/agent-config/commands/deploy`)
    expect(after.status).toBe(404)
  })

  test("central commands appear in slash command list", async () => {
    const create = await fetch(`${base()}/api/claxedo/agent-config/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "triage", content: "Triage $ARGUMENTS" }),
    })
    expect(create.status).toBe(201)

    const res = await fetch(`${base()}/command`)
    expect(res.status).toBe(200)
    const commands = (await res.json()) as Array<{ name: string; content: string }>
    expect(commands).toContainEqual({
      name: "triage",
      content: "Triage $ARGUMENTS",
    })
  })

  test("command create requires name and content", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "only-name" }),
    })
    expect(res.status).toBe(400)
  })

  // ── Effective config ───────────────────────────────────────────────

  test("GET /api/claxedo/agent-config returns effective config with active MCP servers", async () => {
    await agent.saveUserConfig({
      mcp: {
        active: { type: "stdio", command: "node", args: ["s.js"] },
        disabled: { type: "stdio", command: "node", args: [], disabled: true },
      },
      auth: {},
    })

    const res = await fetch(`${base()}/api/claxedo/agent-config`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mcp: Record<string, unknown> }
    expect(body.mcp).toBeDefined()
    expect(body.mcp["active"]).toBeDefined()
    expect(body.mcp["disabled"]).toBeUndefined()
  })

  // ── Bootstrap in ACP mode ──────────────────────────────────────────

  test("bootstrap response includes the local harness catalog in ACP mode", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: { "claude-acp": "sk-ant-test" },
      runner: { type: "claude-acp" },
    })

    const res = await fetch(`${base()}/api/claxedo/bootstrap`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      healthy: boolean
      provider: { all: Array<{ id: string }>; connected: string[]; default: Record<string, string> }
      provider_auth: Record<string, unknown>
      config: { model: string }
    }

    expect(body.healthy).toBe(true)
    expect(body.provider).toMatchObject({
      all: expect.arrayContaining([expect.objectContaining({ id: "claude-acp" })]),
      connected: [],
      default: {},
    })

    // Auth should be ACP-style
    expect(body.provider_auth["claude-acp"]).toBeDefined()

    expect(body.config.model).toBe("")
  })

  // ── Global dispose shim ────────────────────────────────────────────

  test("POST /global/dispose returns true (no-op shim)", async () => {
    const res = await fetch(`${base()}/global/dispose`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toBe(true)
  })

  // ── /global/health ─────────────────────────────────────────────────

  test("GET /global/health returns healthy status", async () => {
    const res = await fetch(`${base()}/global/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { healthy: boolean; version: string }
    expect(body.healthy).toBe(true)
    expect(typeof body.version).toBe("string")
  })

  // ── Config endpoints in ACP mode ──────────────────────────────────

  test("GET /config returns ACP-style config body in ACP mode", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp", model: "claude-opus-4-6" },
    })

    const res = await fetch(`${base()}/config`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { model: string; mcp: Record<string, unknown> }
    expect(body.model).toBe("claude/claude-opus-4-6")
    expect(body.mcp).toEqual({})
  })

  test("GET /config proxies to upstream in opencode mode", async () => {
    const res = await fetch(`${base()}/config`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { model: string }
    expect(body.model).toBe("upstream/up-model")
  })

  // ── Workspace routes ──────────────────────────────────────────────

  test("workspace resolve returns stored workspace details", async () => {
    const ws = await workspace("resolve-test")
    const res = await fetch(`${base()}/api/workspace/resolve?workspaceId=${encodeURIComponent(ws.id)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workspaceId: string; directory: string; kind: string }
    expect(body.workspaceId).toBe(ws.id)
    expect(body.directory).toBe(ws.directory)
    expect(body.kind).toBe("local")
  })

  test("workspace resolve returns 404 for unknown workspace", async () => {
    const res = await fetch(`${base()}/api/workspace/resolve?workspaceId=ws_nonexistent`)
    expect(res.status).toBe(404)
  })

  test("workspace resolve can create a local workspace by directory", async () => {
    const directory = path.join(root, "workspaces", `resolve-create-${randomUUID()}`)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, "README.md"), "# test\n")
    sh(`git init -b main ${directory}`)
    sh(`git -C ${directory} config user.email test@example.com`)
    sh(`git -C ${directory} config user.name test`)
    sh(`git -C ${directory} add README.md`)
    sh(`git -C ${directory} commit -m init`)
    const res = await fetch(`${base()}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { directory: string; kind: string; workspaceId: string }
    expect(body.directory).toBe(await fs.realpath(directory))
    expect(body.kind).toBe("local")
    expect(body.workspaceId).toBeTruthy()
  })

  // ── Project listing ───────────────────────────────────────────────

  test("project list groups workspaces by project", async () => {
    const ws = await workspace("project-list")
    const res = await fetch(`${base()}/project`)
    expect(res.status).toBe(200)
    const projects = (await res.json()) as Array<{ id: string; worktree: string }>
    const found = projects.find((p) => p.worktree === ws.directory)
    expect(found).toBeDefined()
  })

  // ── Agent modes (ACP mode) ────────────────────────────────────────

  test("GET /agent returns agent modes in ACP mode", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    const res = await fetch(`${base()}/agent`)
    expect(res.status).toBe(200)
    const agents = (await res.json()) as Array<{ name: string; mode: string }>
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((a) => typeof a.name === "string")).toBe(true)
  })

  // ── Config patch ──────────────────────────────────────────────────

  test("PATCH /config updates MCP config in ACP mode", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    const res = await fetch(`${base()}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mcp: {
          "patched-tool": { type: "stdio", command: "node", args: ["patched.js"] },
        },
      }),
    })
    expect(res.status).toBe(200)

    const cfg = await savedConfig()
    expect(cfg.mcp["patched-tool"]).toBeDefined()
  })

  // ── Runner options endpoint ───────────────────────────────────────

  test("GET /runner/options requires directory or workspaceId", async () => {
    const res = await fetch(`${base()}/api/claxedo/agent-config/harness/options`)
    expect(res.status).toBe(400)
  })

  test("GET /runner/options reports unavailable for opencode runner", async () => {
    const ws = await workspace("options-opencode")
    const res = await fetch(
      `${base()}/api/claxedo/agent-config/harness/options?directory=${encodeURIComponent(ws.directory)}&type=opencode`,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: {
        code: "harness_config_options_unavailable",
      },
    })
  })

  test("GET /runner/options reports unavailable for pi runner", async () => {
    const ws = await workspace("options-pi")
    const res = await fetch(
      `${base()}/api/claxedo/agent-config/harness/options?directory=${encodeURIComponent(ws.directory)}&type=pi`,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: {
        code: "harness_config_options_unavailable",
      },
    })
  })

  test("GET /runner/options resolves workspace ids", async () => {
    const ws = await workspace("options-workspace-id")
    const res = await fetch(
      `${base()}/api/claxedo/agent-config/harness/options?workspaceId=${encodeURIComponent(ws.id)}&type=codex-acp`,
    )
    const body = await res.json() as { source?: string; options?: unknown[]; error?: { code?: string; message?: string } }
    if (res.status === 200) {
      expect(body.source).toBe("harness")
      expect(body.options?.length).toBeGreaterThan(0)
      return
    }
    expect(res.status).toBe(502)
    expect(body.error?.code).toBe("harness_config_options_unavailable")
    expect(body.error?.message).not.toContain("codex-app-server")
  })

  test("GET /runner/options uses catalog for SDK runners and no static placeholder ACP options", async () => {
    const ws = await workspace("options-placeholder-models")
    const byRunner = await Promise.all(["codex-acp", "cursor-acp"].map(async (type) => {
      const res = await fetch(
        `${base()}/api/claxedo/agent-config/harness/options?directory=${encodeURIComponent(ws.directory)}&type=${type}`,
      )
      return [type, res.status, await res.json()] as const
    }))

    for (const [, status, body] of byRunner) {
      if (status === 200) {
        expect(body).toMatchObject({ source: "harness", stale: false })
        expect(body.options.length).toBeGreaterThan(0)
        continue
      }
      expect(status).toBe(502)
      expect(body).toMatchObject({ error: { code: "harness_config_options_unavailable" } })
    }
    const sdk = await fetch(
      `${base()}/api/claxedo/agent-config/harness/options?directory=${encodeURIComponent(ws.directory)}&type=codex-app-server`,
    )
    expect(sdk.status).toBe(200)
    expect(await sdk.json()).toMatchObject({
      source: "catalog",
      stale: false,
    })
  })

  test("GET /runner/options only returns live ACP options or an unavailable error", async () => {
    const ws = await workspace("options-claude")
    const res = await fetch(
      `${base()}/api/claxedo/agent-config/harness/options?directory=${encodeURIComponent(ws.directory)}&type=claude-acp`,
    )
    const body = await res.json()
    if (res.status === 200) {
      expect(body.source).toBe("harness")
      expect(body.options.length).toBeGreaterThan(0)
      return
    }
    expect(res.status).toBe(502)
    expect(body).toMatchObject({
      error: { code: "harness_config_options_unavailable" },
    })
  })

  // ── Multiple auth keys coexist ─────────────────────────────────────

  test("storing auth for multiple providers creates independent entries", async () => {
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })

    await fetch(`${base()}/auth/claude-acp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { key: "sk-ant-key" } }),
    })
    await fetch(`${base()}/auth/codex-acp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { key: "sk-oai-key" } }),
    })

    // Verify via credential registry (PUT /auth stores through putCredential)
    const { resolveSecret } = await import("./credentials/registry")
    expect(await resolveSecret("claude-acp")).toBe("sk-ant-key")
    expect(await resolveSecret("codex-acp")).toBe("sk-oai-key")

    // Delete one, other remains
    await fetch(`${base()}/auth/claude-acp`, { method: "DELETE" })
    expect(await resolveSecret("claude-acp")).toBeNull()
    expect(await resolveSecret("codex-acp")).toBe("sk-oai-key")
  })

  // ── Config format stability ────────────────────────────────────────

  test("config file has stable JSON structure after multiple mutations", async () => {
    // Runner switch
    await fetch(`${base()}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "claude-acp" }),
    })
    // Auth (stored in credential registry, not config file)
    await fetch(`${base()}/auth/claude-acp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { key: "sk-test" } }),
    })
    // MCP
    await fetch(`${base()}/api/claxedo/agent-config/mcp/toolx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stdio", command: "node" }),
    })

    const cfg = await savedConfig()

    // Runner and MCP persist in config file
    expect(cfg.harness).toMatchObject({ id: "claude", access: "acp" })
    expect(cfg.mcp["toolx"]).toBeDefined()

    // Auth is stored in credential registry, verify there
    const { resolveSecret } = await import("./credentials/registry")
    expect(await resolveSecret("claude-acp")).toBe("sk-test")

    // Top-level keys should include at least mcp and harness.
    const keys = Object.keys(cfg).sort()
    expect(keys).toEqual(expect.arrayContaining(["mcp", "harness"]))
  })
})
