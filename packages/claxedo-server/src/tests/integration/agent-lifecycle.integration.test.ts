/**
 * Agent Lifecycle Integration Tests
 *
 * Exercises the full HTTP path through claxedo-server for session CRUD and
 * message streaming across all four runner types (opencode, claude-acp,
 * codex-acp, cursor-acp) on local workspaces.
 *
 * ACP runners are driven by a fake ACP binary (test-support/fake-acp.ts) that
 * implements the ndjson JSON-RPC protocol without requiring real API keys.
 * The opencode runner proxies to a lightweight Node HTTP upstream mock.
 *
 * Cloud workspace lifecycle is out of scope here — it requires a multi-process
 * supervisor chain. See control-plane.integration.test.ts for cloud proxy tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { defined } from "../../test-support/assert-helpers"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { randomUUID } from "crypto"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { execFileSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Helpers ──────────────────────────────────────────────────────────────────

async function freePort() {
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

function sse(url: string, match: (event: any) => boolean, ms = 8_000) {
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

// ── Environment setup ────────────────────────────────────────────────────────

const upstreamSessions = new Map<string, { id: string; title: string | null; created_at: number; updated_at: number }>()
const upstreamMessages = new Map<string, unknown[]>()

const root = await fs.mkdtemp(path.join(realpathSync(os.tmpdir()), "claxedo-lifecycle-"))
const home = path.join(root, "home")
const data = path.join(home, ".claxedo")

await fs.mkdir(home, { recursive: true })
await fs.mkdir(data, { recursive: true })
await fs.mkdir(path.join(data, "state"), { recursive: true })

const prev: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  POSTHOG_KEY: process.env.POSTHOG_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  CLAXEDO_ACP_IDLE_TIMEOUT_MS: process.env.CLAXEDO_ACP_IDLE_TIMEOUT_MS,
  CLAXEDO_ACP_PROMPT_TIMEOUT_MS: process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS,
}

process.env.HOME = home
process.env.CLAXEDO_DATA_DIR = data
process.env.CLAXEDO_STATE_DIR = path.join(data, "state")
process.env.POSTHOG_KEY = ""
process.env.CLAXEDO_ACP_IDLE_TIMEOUT_MS = "60000"
process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = "15000"
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.CURSOR_API_KEY

const [serverMod, supervisor, store, agent, embedded] = await Promise.all([
  import("../../deployments/local/server.js"),
  import("../../workspace/supervisor/index.js"),
  import("../../workspace/store/index.js"),
  import("../../agent-config/index.js"),
  import("../../deployments/local/embedded-workspace-runtime.js"),
])

const fakeBinaryPath = path.resolve(__dirname, "../../test-support/fake-acp.ts")

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

const upstreamConfig = { model: "upstream/up-model", provider: {}, mcp: {} }

let upstreamPort = 0
let serverPort = 0
let upstream: Server
let server: ReturnType<typeof serverMod.startServer>

// ── Upstream mock (plain Node http) ──────────────────────────────────────────

function startUpstreamMock(port: number): Server {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
    const pathname = url.pathname
    const method = req.method ?? "GET"

    const sendJson = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }

    const readBody = (): Promise<any> =>
      new Promise((resolve) => {
        let buf = ""
        req.on("data", (chunk: Buffer) => { buf += chunk.toString() })
        req.on("end", () => {
          try { resolve(JSON.parse(buf)) } catch { resolve({}) }
        })
      })

    // SSE event stream
    if (pathname === "/global/event") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      res.write(`data: ${JSON.stringify({
        directory: "global",
        payload: { type: "server.connected", properties: {} },
      })}\n\n`)
      // Keep connection open
      req.on("close", () => res.end())
      return
    }

    // Session list
    if (pathname === "/session" && method === "GET") {
      return sendJson([...upstreamSessions.values()])
    }

    // Session create
    if (pathname === "/session" && method === "POST") {
      return readBody().then((body: any) => {
        const id = `sess_${randomUUID()}`
        const now = Date.now()
        const row = { id, title: body.title ?? null, created_at: now, updated_at: now }
        upstreamSessions.set(id, row)
        upstreamMessages.set(id, [])
        sendJson(row, 201)
      })
    }

    // Session get / patch / delete
    const sessionMatch = pathname.match(/^\/session\/([^/]+)$/)
    if (sessionMatch && method === "GET") {
      const row = upstreamSessions.get(decodeURIComponent(sessionMatch[1]!))
      return row ? sendJson(row) : sendJson({ error: "not found" }, 404)
    }
    if (sessionMatch && method === "PATCH") {
      const id = decodeURIComponent(sessionMatch[1]!)
      const row = upstreamSessions.get(id)
      if (!row) return sendJson({ error: "not found" }, 404)
      return readBody().then((body: any) => {
        if (body.title !== undefined) row.title = body.title
        if (body.time?.archived !== undefined) (row as any).archived_at = body.time.archived
        row.updated_at = Date.now()
        sendJson(row)
      })
    }
    if (sessionMatch && method === "DELETE") {
      upstreamSessions.delete(decodeURIComponent(sessionMatch[1]!))
      return sendJson({ ok: true })
    }

    // Session message
    const msgMatch = pathname.match(/^\/session\/([^/]+)\/message$/)
    if (msgMatch && method === "POST") {
      const sessionId = decodeURIComponent(msgMatch[1]!)
      const assistantMsg = {
        info: {
          id: `msg_${randomUUID()}`,
          sessionID: sessionId,
          role: "assistant",
          created: Date.now(),
          updated: Date.now(),
        },
        parts: [{
          type: "text",
          id: `p_${randomUUID()}`,
          sessionID: sessionId,
          messageID: `msg_resp`,
          text: "Hello from upstream",
        }],
      }
      const msgs = upstreamMessages.get(sessionId) ?? []
      msgs.push(assistantMsg)
      upstreamMessages.set(sessionId, msgs)

      // Drain request body before responding
      return readBody().then(() => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        })
        res.write(`data: ${JSON.stringify({
          type: "session.idle",
          properties: { sessionID: sessionId },
        })}\n\n`)
        res.end()
      })
    }
    if (msgMatch && method === "GET") {
      const sessionId = decodeURIComponent(msgMatch[1]!)
      return sendJson(upstreamMessages.get(sessionId) ?? [])
    }

    // Provider / config
    if (pathname === "/provider") return sendJson(upstreamProvider)
    if (pathname === "/provider/auth") return sendJson({ upstream: [{ type: "oauth", label: "Login" }] })
    if (pathname === "/config/providers") return sendJson({ providers: upstreamProvider.all, default: upstreamProvider.default })
    if (pathname === "/config" || pathname === "/global/config") return sendJson(upstreamConfig)

    // Status routes
    if (pathname === "/session/status") return sendJson({ active: { type: "idle" } })
    if (pathname === "/mcp") return sendJson({})
    if (pathname === "/question") return sendJson([])
    if (pathname === "/lsp") return sendJson([])
    if (pathname === "/vcs") return sendJson({})

    sendJson({ error: "not found" }, 404)
  })

  srv.listen(port, "127.0.0.1")
  return srv
}

// ── Workspace + query helpers ────────────────────────────────────────────────

async function workspace(label: string) {
  const directory = path.join(root, "workspaces", `${label}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  execFileSync("git", ["init", directory])
  // HOME is redirected to a temp dir above, so no global gitconfig (and no
  // committer identity) is visible; on CI runners git then refuses to commit.
  execFileSync("git", ["-C", directory, "config", "user.email", "lifecycle-test@claxedo.invalid"])
  execFileSync("git", ["-C", directory, "config", "user.name", "Lifecycle Test"])
  execFileSync("git", ["-C", directory, "commit", "--allow-empty", "-m", "init"])
  return defined(await store.ensureWorkspace({
    workspaceId: `ws_${randomUUID()}`,
    directory,
  }))
}

function base() {
  return `http://127.0.0.1:${serverPort}`
}

function q(ws: { id: string; directory: string }) {
  return `workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`
}

async function setAcpRunner(type: "claude-acp" | "codex-acp" | "cursor-acp") {
  const id = type === "claude-acp" ? "claude" : type === "codex-acp" ? "codex" : "cursor"
  await agent.saveUserConfig({
    mcp: {},
    auth: { [type]: "sk-fake-key" },
    harness: { id, access: "acp", connection: { kind: "process", binary: fakeBinaryPath } },
  })
}

// ── Test lifecycle ───────────────────────────────────────────────────────────

describe("agent lifecycle integration", () => {
  beforeAll(async () => {
    upstreamPort = await freePort()
    serverPort = await freePort()

    upstream = startUpstreamMock(upstreamPort)
    await new Promise<void>((resolve) => upstream.once("listening", resolve))

    server = serverMod.startServer(serverPort, `http://127.0.0.1:${upstreamPort}`)
  })

  beforeEach(async () => {
    embedded.shutdownEmbeddedWorkspaceRuntimes()
    await supervisor.shutdownWorkspaceSupervisor()
    upstreamSessions.clear()
    upstreamMessages.clear()
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

  // ── opencode runner ────────────────────────────────────────────────────────

  describe("opencode runner lifecycle", () => {
    it("full session CRUD and message send", async () => {
      const ws = await workspace("oc-lifecycle")

      // Create session
      const createRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "OpenCode Test" }),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as { id: string; title: string | null; time: { created: number; updated: number } }
      expect(typeof session.id).toBe("string")
      expect(session.title).toBe("OpenCode Test")
      expect(typeof session.time.created).toBe("number")

      // List sessions
      const listRes = await fetch(`${base()}/session?${q(ws)}`)
      expect(listRes.status).toBe(200)
      const sessions = await listRes.json() as Array<{ id: string }>
      expect(sessions.some((s) => s.id === session.id)).toBe(true)

      // Get session
      const getRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`)
      expect(getRes.status).toBe(200)
      const got = await getRes.json() as { id: string }
      expect(got.id).toBe(session.id)

      // Update session title
      const updateRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed Session" }),
      })
      expect(updateRes.status).toBe(200)
      const updated = await updateRes.json() as { id: string; title: string | null }
      expect(updated.id).toBe(session.id)
      expect(updated.title).toBe("Renamed Session")

      // Archive session
      const archiveTs = Date.now()
      const archiveRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: { archived: archiveTs } }),
      })
      expect(archiveRes.status).toBe(200)
      const archived = await archiveRes.json() as { id: string; title: string | null }
      expect(archived.id).toBe(session.id)
      // Title should be preserved after archive
      expect(archived.title).toBe("Renamed Session")

      // Send message
      const msgRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}/message?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "Hello" }],
        }),
      })
      expect(msgRes.status).toBe(200)
      const msg = await msgRes.json() as { info: { role: string }; parts: unknown[] }
      expect(msg.info.role).toBe("assistant")

      // Get messages
      const msgsRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}/message?${q(ws)}`)
      expect(msgsRes.status).toBe(200)
      const msgs = await msgsRes.json() as unknown[]
      expect(msgs.length).toBeGreaterThan(0)

      // Delete session
      const delRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "DELETE",
      })
      expect(delRes.status).toBe(200)
      expect(await delRes.json()).toEqual({ ok: true })
    })
  })

  // ── claude-acp runner ──────────────────────────────────────────────────────

  describe("claude-acp runner lifecycle", () => {
    it("full session CRUD and message send through fake ACP binary", async () => {
      await setAcpRunner("claude-acp")
      const ws = await workspace("claude-lifecycle")

      // Create session (spawns fake-acp, runs initialize + session/new)
      const createRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Claude ACP Test" }),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as { id: string; time: { created: number; updated: number } }
      expect(typeof session.id).toBe("string")
      expect(typeof session.time.created).toBe("number")

      // List sessions
      const listRes = await fetch(`${base()}/session?${q(ws)}`)
      expect(listRes.status).toBe(200)
      const sessions = await listRes.json() as Array<{ id: string }>
      expect(sessions.some((s) => s.id === session.id)).toBe(true)

      // Get session
      const getRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`)
      expect(getRes.status).toBe(200)
      const got = await getRes.json() as { id: string }
      expect(got.id).toBe(session.id)

      // Update session title
      const updateRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed ACP Session" }),
      })
      expect(updateRes.status).toBe(200)
      const updated = await updateRes.json() as { id: string; title: string | null }
      expect(updated.id).toBe(session.id)
      expect(updated.title).toBe("Renamed ACP Session")

      // Archive session
      const archiveTs = Date.now()
      const archiveRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: { archived: archiveTs } }),
      })
      expect(archiveRes.status).toBe(200)
      const archived = await archiveRes.json() as { id: string; time?: { archived?: number } }
      expect(archived.id).toBe(session.id)
      // ACP sessions get normalized — verify archived timestamp is in the response
      expect(archived.time?.archived).toBe(archiveTs)

      // Send message (fake-acp emits agent_message_chunk, responds with end_turn)
      const msgRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}/message?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "Hello" }],
        }),
      })
      expect(msgRes.status).toBe(200)
      const msg = await msgRes.json() as { info: { role: string; id: string }; parts: Array<{ type: string; text?: string }> }
      expect(msg.info.role).toBe("assistant")
      // Verify the fake-acp message content made it through the full pipeline
      const textParts = msg.parts.filter((p) => p.type === "text" && p.text?.includes("Hello from fake-acp"))
      expect(textParts.length).toBeGreaterThan(0)

      // Delete session
      const delRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "DELETE",
      })
      expect(delRes.status).toBe(200)
      expect(await delRes.json()).toEqual({ ok: true })
    })
  })

  // ── codex-acp runner ───────────────────────────────────────────────────────

  describe("codex-acp runner lifecycle", () => {
    it("full session CRUD and message send through fake ACP binary", async () => {
      await setAcpRunner("codex-acp")
      const ws = await workspace("codex-lifecycle")

      // Create session
      const createRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Codex ACP Test" }),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as { id: string }
      expect(typeof session.id).toBe("string")

      // Send message
      const msgRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}/message?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "Hello" }],
        }),
      })
      expect(msgRes.status).toBe(200)
      const msg = await msgRes.json() as { info: { role: string } }
      expect(msg.info.role).toBe("assistant")

      // Delete session
      const delRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "DELETE",
      })
      expect(delRes.status).toBe(200)
    })
  })

  // ── cursor-acp runner ──────────────────────────────────────────────────────

  describe("cursor-acp runner lifecycle", () => {
    it("full session CRUD and message send through fake ACP binary (with acp arg)", async () => {
      await setAcpRunner("cursor-acp")
      const ws = await workspace("cursor-lifecycle")

      // Create session (AcpHarnessAdapter.spawnArgs() adds ["acp"] for cursor — fake binary ignores it)
      const createRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Cursor ACP Test" }),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as { id: string }
      expect(typeof session.id).toBe("string")

      // Send message
      const msgRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}/message?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "Hello" }],
        }),
      })
      expect(msgRes.status).toBe(200)
      const msg = await msgRes.json() as { info: { role: string } }
      expect(msg.info.role).toBe("assistant")

      // Delete session
      const delRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`, {
        method: "DELETE",
      })
      expect(delRes.status).toBe(200)
    })
  })

  describe.each([
    { label: "opencode native", runner: undefined },
    { label: "claude ACP", runner: "claude-acp" as const },
    { label: "codex ACP", runner: "codex-acp" as const },
    { label: "cursor ACP", runner: "cursor-acp" as const },
  ])("$label first-turn title", ({ label, runner }) => {
    it("generates, projects, and restores the title after the first turn", async () => {
      if (runner) await setAcpRunner(runner)
      const ws = await workspace(`first-turn-title-${label.replaceAll(" ", "-")}`)
      const prompt = `Please fix ${label} first-turn title`
      const expectedTitle = `fix ${label} first-turn title`

      const createRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as { id: string }

      const messageRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}/message?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      })
      expect(messageRes.status).toBe(200)

      await expect.poll(async () => {
        const response = await fetch(`${base()}/session/${encodeURIComponent(session.id)}?${q(ws)}`)
        return ((await response.json()) as { title?: string }).title
      }, { timeout: 10_000 }).toBe(expectedTitle)

      await expect.poll(async () => {
        const response = await fetch(
          `${base()}/api/control/session-list?scope=workspace&workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}&limit=20`,
        )
        const body = await response.json() as { items?: Array<{ sessionId: string; title?: string }> }
        return body.items?.find((item) => item.sessionId === session.id)?.title
      }, { timeout: 10_000 }).toBe(expectedTitle)

      embedded.shutdownEmbeddedWorkspaceRuntimes()
      const afterRestart = await fetch(
        `${base()}/api/control/session-list?scope=workspace&workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}&limit=20`,
      )
      const body = await afterRestart.json() as { items?: Array<{ sessionId: string; title?: string }> }
      expect(body.items?.find((item) => item.sessionId === session.id)?.title).toBe(expectedTitle)
    })
  })

  // ── Cross-runner session isolation ─────────────────────────────────────────

  describe("cross-runner session isolation", () => {
    it("sessions from different runners merge in list", async () => {
      const ws = await workspace("cross-runner")

      // Create an opencode session
      const ocRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "OC Session" }),
      })
      expect(ocRes.status).toBe(201)
      const ocSession = await ocRes.json() as { id: string }

      // Switch to claude-acp and create another session
      await setAcpRunner("claude-acp")
      const acpRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "ACP Session" }),
      })
      expect(acpRes.status).toBe(201)
      const acpSession = await acpRes.json() as { id: string }

      // List all sessions (listLocalSessions merges across runners)
      const listRes = await fetch(`${base()}/session?${q(ws)}`)
      expect(listRes.status).toBe(200)
      const all = await listRes.json() as Array<{ id: string }>
      const ids = all.map((s) => s.id)

      // Both sessions should be present
      expect(ids).toContain(ocSession.id)
      expect(ids).toContain(acpSession.id)
    })

    it("binds discovered sessions to the runner that listed them so all session APIs keep working", async () => {
      const ws = await workspace("cross-runner-discovered")

      const ocRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Bound OpenCode Session" }),
      })
      expect(ocRes.status).toBe(201)

      upstreamSessions.set("ses_discovered", {
        id: "ses_discovered",
        title: "Discovered Upstream Session",
        created_at: Date.now() - 2_000,
        updated_at: Date.now() - 1_000,
      })

      await setAcpRunner("claude-acp")

      // A plain list is store-only once the directory has been imported, so a
      // session that appeared upstream afterwards arrives through the explicit
      // selected-harness refresh. Name the harness that owns it...
      const refreshRes = await fetch(`${base()}/session?${q(ws)}&harness=opencode`)
      expect(refreshRes.status).toBe(200)
      expect((await refreshRes.json() as Array<{ id: string }>).some((s) => s.id === "ses_discovered")).toBe(true)

      // ...and it is then part of this directory's durable inventory.
      const listRes = await fetch(`${base()}/session?${q(ws)}`)
      expect(listRes.status).toBe(200)
      const sessions = await listRes.json() as Array<{ id: string }>
      expect(sessions.some((s) => s.id === "ses_discovered")).toBe(true)

      const getRes = await fetch(`${base()}/session/${encodeURIComponent("ses_discovered")}?${q(ws)}`)
      expect(getRes.status).toBe(200)
      const got = await getRes.json() as { id: string; title: string | null }
      expect(got.id).toBe("ses_discovered")
      expect(got.title).toBe("Discovered Upstream Session")

      const titleRes = await fetch(`${base()}/session/${encodeURIComponent("ses_discovered")}?${q(ws)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Discovered Rename" }),
      })
      expect(titleRes.status).toBe(200)
      const titled = await titleRes.json() as { id: string; title: string | null }
      expect(titled.id).toBe("ses_discovered")
      expect(titled.title).toBe("Discovered Rename")

      const archiveTs = Date.now()
      const archiveRes = await fetch(`${base()}/session/${encodeURIComponent("ses_discovered")}?${q(ws)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: { archived: archiveTs } }),
      })
      expect(archiveRes.status).toBe(200)
      const archived = await archiveRes.json() as { id: string; time?: { archived?: number } }
      expect(archived.id).toBe("ses_discovered")
      expect(archived.time?.archived).toBe(archiveTs)

      const delRes = await fetch(`${base()}/session/${encodeURIComponent("ses_discovered")}?${q(ws)}`, {
        method: "DELETE",
      })
      expect(delRes.status).toBe(200)
      expect(await delRes.json()).toEqual({ ok: true })
    })

    it("keeps the binding aligned with the freshest discovered runner when duplicate session ids appear across runners", async () => {
      const ws = await workspace("cross-runner-duplicate-id")

      upstreamSessions.set("ses_duplicate", {
        id: "ses_duplicate",
        title: "Fresh Upstream Session",
        created_at: Date.now() - 2_000,
        updated_at: Date.now(),
      })

      const runner = await import("../../session/harness/index.js")
      runner.setSessionHarness(ws.id, "ses_duplicate", {
        id: "claude",
        access: "acp",
        connection: { kind: "process", binary: fakeBinaryPath },
      })

      const listRes = await fetch(`${base()}/session?${q(ws)}`)
      expect(listRes.status).toBe(200)
      const sessions = await listRes.json() as Array<{ id: string; title: string | null }>
      const hit = sessions.find((s) => s.id === "ses_duplicate")
      expect(hit?.title).toBe("Fresh Upstream Session")

      const getRes = await fetch(`${base()}/session/${encodeURIComponent("ses_duplicate")}?${q(ws)}`)
      expect(getRes.status).toBe(200)
      const got = await getRes.json() as { id: string; title: string | null }
      expect(got.title).toBe("Fresh Upstream Session")
    })

    it("updates workspace harness status after ACP binary config changes", async () => {
      const ws = await workspace("runner-status")

      await agent.saveUserConfig({
        mcp: {},
        auth: { "claude-acp": "sk-fake-key" },
        harness: { id: "claude", access: "acp", connection: { kind: "process", binary: path.join(root, "missing-acp") } },
      })

      const fail = await fetch(`${base()}/api/claxedo/agent-config/harness?${q(ws)}`)
      expect(fail.status).toBe(200)
      const bad = await fail.json() as {
        workspaceId: string
        status: string
        ready: boolean
        activeType: string
        error?: string
      }
      expect(bad.workspaceId).toBe(ws.id)
      expect(bad.status).toBe("ready")
      expect(bad.ready).toBe(true)
      expect(bad.activeType).toBe("claude-acp")
      expect(bad.error).toBeUndefined()

      await setAcpRunner("claude-acp")

      const pass = await fetch(`${base()}/api/claxedo/agent-config/harness?${q(ws)}`)
      expect(pass.status).toBe(200)
      const ok = await pass.json() as {
        workspaceId: string
        status: string
        ready: boolean
        activeType: string
        activeBinary?: string | null
        error?: string
      }
      expect(ok.workspaceId).toBe(ws.id)
      expect(ok.status).toBe("ready")
      expect(ok.ready).toBe(true)
      expect(ok.activeType).toBe("claude-acp")
      expect(ok.activeBinary).toBe(fakeBinaryPath)
      expect(ok.error).toBeUndefined()
    })
  })

  // ── Lifecycle events ───────────────────────────────────────────────────────

  describe("lifecycle events fire through SSE", () => {
    it("agent.lifecycle Start event is normalized to Busy (terminal hook path)", async () => {
      const ws = await workspace("lifecycle-events")

      // Ensure workspace is initialized
      await fetch(`${base()}/api/wr/process?${q(ws)}`)

      // Subscribe to SSE and fire lifecycle event
      const stream = sse(
        `${base()}/workspaces/${encodeURIComponent(ws.id)}/api/wr/events`,
        (event) => event.type === "agent.lifecycle" && event.workspaceId === ws.id,
      )
      await stream.ready

      const params = new URLSearchParams({
        tabId: "tab-1",
        terminalId: "term-1",
        workspaceId: ws.id,
        eventType: "Start",
      })

      const res = await fetch(`${base()}/api/wr/hook/agent-lifecycle?${params}`)
      expect(res.status).toBe(200)

      const event = await stream.event
      expect(event).toMatchObject({
        type: "agent.lifecycle",
        workspaceId: ws.id,
        terminalId: "term-1",
        eventType: "Busy",
      })
    })

    it("ACP message send emits Busy and Idle lifecycle events on claxedo bus", async () => {
      await setAcpRunner("claude-acp")
      const ws = await workspace("acp-lifecycle-events")

      // Create session
      const createRes = await fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "ACP Lifecycle" }),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as { id: string }

      // Collect lifecycle events from the claxedo SSE bus
      const lifecycleEvents: Array<{ type: string; eventType: string; sessionId?: string; workspaceId?: string }> = []
      const stream = sse(
        `${base()}/workspaces/${encodeURIComponent(ws.id)}/api/wr/events`,
        (event) => {
          if (event.type !== "agent.lifecycle") return false
          lifecycleEvents.push(event)
          return lifecycleEvents.some((item) => item.eventType === "Busy")
            && lifecycleEvents.some((item) => item.eventType === "Idle")
        },
      )
      await stream.ready

      // Send message — should produce Busy then Idle lifecycle events
      const msgRes = await fetch(`${base()}/session/${encodeURIComponent(session.id)}/message?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "Hello" }],
        }),
      })
      expect(msgRes.status).toBe(200)

      await stream.event

      // Verify Busy and Idle events were emitted
      const busyEvents = lifecycleEvents.filter((e) => e.eventType === "Busy")
      const idleEvents = lifecycleEvents.filter((e) => e.eventType === "Idle")
      expect(busyEvents.length).toBeGreaterThanOrEqual(1)
      expect(idleEvents.length).toBeGreaterThanOrEqual(1)

      // Verify workspaceId is set
      const withWs = lifecycleEvents.filter((e) => e.workspaceId === ws.id)
      expect(withWs.length).toBeGreaterThanOrEqual(1)
    })
  })
})
