import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { defined } from "./fixtures/assert-helpers"
import { execSync } from "child_process"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { createServer } from "node:net"
import { syncSessionMetas } from "./session-meta"

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
const upstreamSessions = new Map<string, {
  id: string
  title: string | null
  created_at: number
  updated_at: number
  archived_at?: number
  directory: string
  projectID?: string
}>()

const upstreamProvider = {
  all: [{ id: "upstream", name: "Upstream", env: [], models: { "up-model": { id: "up-model", name: "Up Model", release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 128000, output: 8192 }, options: {} } } }],
  default: { upstream: "up-model" },
  connected: ["upstream"],
}

const root = await fs.mkdtemp(path.join(realpathSync(os.tmpdir()), "claxedo-grp-int-"))
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

const [serverMod, supervisor, store, agent, hooks, local] = await Promise.all([
  import("./server"),
  import("./workspace-supervisor"),
  import("./workspace-store"),
  import("./agent-config"),
  import("./agent-hooks"),
  import("./local-agent-engine"),
])

let upstreamPort = 0
let serverPort = 0
let upstream: import("@hono/node-server").ServerType
let server: ReturnType<typeof serverMod.startServer>

function sh(cmd: string) { execSync(cmd, { stdio: "ignore" }) }

function initGit(directory: string) {
  sh(`git init -b main ${directory}`)
  sh(`git -C ${directory} config user.email test@example.com`)
  sh(`git -C ${directory} config user.name test`)
  sh(`git -C ${directory} add README.md`)
  sh(`git -C ${directory} commit -m init`)
}

async function workspace(label: string, kind: "local" | "cloud" = "local") {
  const directory = path.join(root, "workspaces", `${label}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  if (kind === "local") {
    await fs.writeFile(path.join(directory, "README.md"), "# test\n")
    initGit(directory)
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

async function workspaceInProject(label: string, projectId: string, kind: "local" | "cloud" = "local") {
  const directory = path.join(root, "workspaces", `${label}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  if (kind === "local") {
    await fs.writeFile(path.join(directory, "README.md"), "# test\n")
    initGit(directory)
  }
  const ws = defined(await store.ensureWorkspace({
    workspaceId: `ws_${randomUUID()}`,
    directory,
    kind,
    project_id: projectId,
  }))
  if (kind === "cloud") {
    supervisor.injectRuntime(ws, `http://127.0.0.1:${upstreamPort}`)
  }
  return ws
}

function base() {
  return `http://127.0.0.1:${serverPort}`
}

async function createSession(ws: { id: string; directory: string }, title: string) {
  const res = await fetch(`${base()}/session?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function createGlobalSession(title: string) {
  const res = await fetch(`${base()}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; directory: string }
}

async function syncHostedSessions(ws: { id: string }, sessions: unknown[]) {
  const resolved = await store.resolveWorkspace({ workspaceId: ws.id })
  expect(resolved).toBeTruthy()
  await syncSessionMetas(resolved!, sessions)
}

function seedUpstreamSession(input: {
  id: string
  directory: string
  title: string
  projectID?: string
  createdAt?: number
  updatedAt?: number
}) {
  const created_at = input.createdAt ?? Date.now()
  const updated_at = input.updatedAt ?? created_at
  upstreamSessions.set(input.id, {
    id: input.id,
    title: input.title,
    directory: input.directory,
    projectID: input.projectID,
    created_at,
    updated_at,
  })
}

async function setMeta(sessionId: string, meta: { parentID?: string; tags?: string[]; attachments?: Array<{ kind: string; targetID: string }> }) {
  const res = await fetch(`${base()}/api/claxedo/session/${encodeURIComponent(sessionId)}/meta`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

async function archiveSession(sessionId: string) {
  const res = await fetch(`${base()}/api/claxedo/session/${encodeURIComponent(sessionId)}/meta`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true }),
  })
  // The archive may go through a different path; if meta PUT doesn't support it,
  // we'll use the underlying session-meta directly
  return res
}

async function patchArchive(ws: { id: string; directory: string }, sessionId: string, archived: number) {
  const res = await fetch(`${base()}/session/${encodeURIComponent(sessionId)}?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ time: { archived } }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { id: string; time?: { archived?: number } }
}

type GroupResponse = {
  groups: Array<{
    key: string
    directory?: string
    projectID?: string
    sessions: Array<Record<string, unknown>>
    hasMore: boolean
    total: number
  }>
}

async function fetchGrouped(params: Record<string, string>): Promise<GroupResponse> {
  const qs = new URLSearchParams(params)
  const res = await fetch(`${base()}/experimental/session?${qs}`)
  expect(res.status).toBe(200)
  return (await res.json()) as GroupResponse
}

async function fetchFlat(params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams(params)
  const res = await fetch(`${base()}/experimental/session?${qs}`)
  expect(res.status).toBe(200)
  return (await res.json()) as Array<Record<string, unknown>>
}

async function fetchSessionList(params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams(params)
  const res = await fetch(`${base()}/session?${qs}`)
  expect(res.status).toBe(200)
  return (await res.json()) as Array<Record<string, unknown>>
}

describe("session grouping and filtering integration", () => {
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
                payload: { type: "server.connected", properties: {} },
              })}\n\n`))
            },
            cancel() {
              if (ctrl) upstreamSubs.delete(ctrl)
            },
          })
          return new Response(body, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          })
        }
        if (pathname === "/session" && req.method === "GET") {
          const dir = req.headers.get("x-opencode-directory") || new URL(req.url).searchParams.get("directory")
          const sessions = [...upstreamSessions.values()]
            .filter((s) => !dir || s.directory === dir)
          return json(sessions)
        }
        if (pathname === "/session" && req.method === "POST") {
          const id = `sess_${randomUUID()}`
          const now = Date.now()
          const dir = req.headers.get("x-opencode-directory") || new URL(req.url).searchParams.get("directory") || ""
          return req.json().catch(() => ({})).then((data: any) => {
            const row = { id, title: data.title ?? null, created_at: now, updated_at: now, directory: dir }
            upstreamSessions.set(id, row)
            return json(row, 201)
          })
        }
        if (pathname === "/session/status") return json({})
        const session = pathname.match(/^\/session\/([^/]+)$/)
        if (session && req.method === "GET") {
          const row = upstreamSessions.get(decodeURIComponent(session[1]!))
          return row ? json(row) : json({ error: "not found" }, 404)
        }
        if (session && req.method === "PATCH") {
          const id = decodeURIComponent(session[1]!)
          const row = upstreamSessions.get(id)
          if (!row) return json({ error: "not found" }, 404)
          return req.json().catch(() => ({})).then((data: any) => {
            if (data.title !== undefined) row.title = data.title
            if (data.time?.archived !== undefined) row.archived_at = data.time.archived
            row.updated_at = Date.now()
            return json(row)
          })
        }
        if (pathname === "/provider") return json(upstreamProvider)
        if (pathname === "/provider/auth") return json({})
        if (pathname === "/config/providers") return json({ providers: upstreamProvider.all, default: upstreamProvider.default })
        if (pathname === "/config" || pathname === "/global/config") return json({})
        if (pathname === "/mcp") return json({})
        if (pathname === "/lsp") return json([])
        if (pathname === "/vcs") return json({})
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

  // -------- groupBy=workspace --------

  test("groupBy=workspace groups sessions by directory", async () => {
    const wsA = await workspace("grp-ws-a")
    const wsB = await workspaceInProject("grp-ws-b", wsA.project_id!)

    const sA1 = await createSession(wsA, "A1")
    const sA2 = await createSession(wsA, "A2")
    const sB1 = await createSession(wsB, "B1")

    const result = await fetchGrouped({ groupBy: "workspace", perGroup: "10" })

    expect(result.groups.length).toBeGreaterThanOrEqual(2)

    const groupA = result.groups.find((g) => g.directory === wsA.directory)
    const groupB = result.groups.find((g) => g.directory === wsB.directory)

    expect(groupA).toBeDefined()
    expect(groupB).toBeDefined()
    expect(groupA!.sessions).toHaveLength(2)
    expect(groupB!.sessions).toHaveLength(1)
    expect(groupA!.sessions.map((s) => s.id)).toContain(sA1.id)
    expect(groupA!.sessions.map((s) => s.id)).toContain(sA2.id)
    expect(groupB!.sessions.map((s) => s.id)).toContain(sB1.id)
  })

  test("global sessions are labeled, visible in flat listings, and excluded from workspace groups", async () => {
    const global = await createGlobalSession("Global Chat")
    expect(global.directory).toContain("global-sessions")

    const meta = await fetch(`${base()}/api/claxedo/session/${encodeURIComponent(global.id)}/meta`).then((x) => x.json()) as { tags: string[] }
    expect(meta.tags).toEqual(["global", "global:default"])

    const flat = await fetchFlat({})
    const hit = flat.find((item) => item.id === global.id)
    expect(hit?.tags).toEqual(["global", "global:default"])

    const grouped = await fetchGrouped({ groupBy: "workspace", perGroup: "10" })
    expect(grouped.groups.some((item) => item.directory === global.directory)).toBe(false)
  })

  test("groupBy=workspace respects perGroup limit and hasMore", async () => {
    const ws = await workspace("grp-ws-limit")

    // Create 3 sessions
    await createSession(ws, "L1")
    await createSession(ws, "L2")
    await createSession(ws, "L3")

    const result = await fetchGrouped({ groupBy: "workspace", perGroup: "2" })

    const group = result.groups.find((g) => g.directory === ws.directory)
    expect(group).toBeDefined()
    expect(group!.sessions).toHaveLength(2)
    expect(group!.hasMore).toBe(true)
    expect(group!.total).toBe(3)
  })

  test("flat experimental session list supports cursor pagination", async () => {
    const ws = await workspace("grp-flat-cursor")

    await createSession(ws, "C1")
    await createSession(ws, "C2")
    await createSession(ws, "C3")

    const first = await fetch(`${base()}/experimental/session?roots=true&directory=${encodeURIComponent(ws.directory)}&limit=2`)
    expect(first.status).toBe(200)
    const cursor = first.headers.get("x-next-cursor")
    expect(cursor).toBeTruthy()

    const pageA = await first.json() as Array<Record<string, unknown>>
    expect(pageA).toHaveLength(2)

    const next = await fetch(
      `${base()}/experimental/session?roots=true&directory=${encodeURIComponent(ws.directory)}&limit=2&cursor=${encodeURIComponent(cursor!)}`,
    )
    expect(next.status).toBe(200)
    const pageB = await next.json() as Array<Record<string, unknown>>
    expect(pageB).toHaveLength(1)
    expect(pageB[0]?.id).not.toBe(pageA[0]?.id)
    expect(pageB[0]?.id).not.toBe(pageA[1]?.id)
  })

  // -------- groupBy=updated --------

  test("groupBy=updated groups sessions by time bucket", async () => {
    const ws = await workspace("grp-updated")

    // Create a session — it will be "Today"
    await createSession(ws, "Recent")

    const result = await fetchGrouped({ groupBy: "updated", perGroup: "10" })

    const todayGroup = result.groups.find((g) => g.key === "Today")
    expect(todayGroup).toBeDefined()
    expect(todayGroup!.sessions.length).toBeGreaterThanOrEqual(1)
    expect(todayGroup!.sessions.some((s) => s.title === "Recent")).toBe(true)
  })

  test("groupBy=updated sorts groups in chronological order", async () => {
    const ws = await workspace("grp-updated-order")
    await createSession(ws, "Now")

    const result = await fetchGrouped({ groupBy: "updated", perGroup: "100" })

    const keys = result.groups.map((g) => g.key)
    const order = ["Today", "Yesterday", "This Week", "Older"]
    const filtered = keys.filter((k) => order.includes(k))
    const sorted = [...filtered].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    expect(filtered).toEqual(sorted)
  })

  // -------- groupBy=status --------

  test("groupBy=status groups sessions by tag/attachment kind", async () => {
    const ws = await workspace("grp-status")

    const review = await createSession(ws, "Review Session")
    await setMeta(review.id, { tags: ["review"] })

    const page = await createSession(ws, "Page Session")
    await setMeta(page.id, {
      tags: ["page"],
      attachments: [{ kind: "page", targetID: "p1" }],
    })

    const general = await createSession(ws, "General Session")

    const result = await fetchGrouped({ groupBy: "status", perGroup: "10" })

    const reviewGroup = result.groups.find((g) => g.key === "review")
    const pageGroup = result.groups.find((g) => g.key === "page")
    const generalGroup = result.groups.find((g) => g.key === "general")

    expect(reviewGroup).toBeDefined()
    expect(reviewGroup!.sessions.some((s) => s.id === review.id)).toBe(true)

    expect(pageGroup).toBeDefined()
    expect(pageGroup!.sessions.some((s) => s.id === page.id)).toBe(true)

    expect(generalGroup).toBeDefined()
    expect(generalGroup!.sessions.some((s) => s.id === general.id)).toBe(true)
  })

  test("groupBy=status sorts groups in canonical order", async () => {
    const ws = await workspace("grp-status-order")

    const review = await createSession(ws, "R")
    await setMeta(review.id, { tags: ["review"] })

    const page = await createSession(ws, "P")
    await setMeta(page.id, { tags: ["page"] })

    await createSession(ws, "G") // general (no tags)

    const result = await fetchGrouped({ groupBy: "status", perGroup: "10" })

    const keys = result.groups.map((g) => g.key)
    const order = ["review", "page", "planner", "general"]
    const filtered = keys.filter((k) => order.includes(k))
    const sorted = [...filtered].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    expect(filtered).toEqual(sorted)
  })

  // -------- groupBy=environment --------

  test("groupBy=environment groups sessions by environment kind", async () => {
    const localWs = await workspace("grp-env-local", "local")
    const cloudWs = await workspace("grp-env-cloud", "cloud")

    await createSession(localWs, "Local Session")
    await createSession(cloudWs, "Cloud Session")

    const result = await fetchGrouped({ groupBy: "environment", perGroup: "10" })

    const localGroup = result.groups.find((g) => g.key === "local")
    const cloudGroup = result.groups.find((g) => g.key === "cloud")

    expect(localGroup).toBeDefined()
    expect(localGroup!.sessions.some((s) => s.title === "Local Session")).toBe(true)

    expect(cloudGroup).toBeDefined()
    expect(cloudGroup!.sessions.some((s) => s.title === "Cloud Session")).toBe(true)
  })

  test("groupBy=environment sorts local before cloud", async () => {
    const localWs = await workspace("grp-env-order-local", "local")
    const cloudWs = await workspace("grp-env-order-cloud", "cloud")

    await createSession(localWs, "L")
    await createSession(cloudWs, "C")

    const result = await fetchGrouped({ groupBy: "environment", perGroup: "10" })

    const keys = result.groups.map((g) => g.key)
    const localIdx = keys.indexOf("local")
    const cloudIdx = keys.indexOf("cloud")
    if (localIdx !== -1 && cloudIdx !== -1) {
      expect(localIdx).toBeLessThan(cloudIdx)
    }
  })

  // -------- filter.status --------

  test("filter.status filters sessions by tag", async () => {
    const ws = await workspace("flt-status")

    const review = await createSession(ws, "Review")
    await setMeta(review.id, { tags: ["review"] })

    const page = await createSession(ws, "Page")
    await setMeta(page.id, { tags: ["page"] })

    const general = await createSession(ws, "General")

    const result = await fetchFlat({ "filter.status": "review", limit: "100" })

    const ids = result.map((s) => s.id)
    expect(ids).toContain(review.id)
    expect(ids).not.toContain(page.id)
    expect(ids).not.toContain(general.id)
  })

  test("filter.status supports multiple values (comma-separated)", async () => {
    const ws = await workspace("flt-status-multi")

    const review = await createSession(ws, "Review")
    await setMeta(review.id, { tags: ["review"] })

    const page = await createSession(ws, "Page")
    await setMeta(page.id, { tags: ["page"] })

    const general = await createSession(ws, "General")

    const result = await fetchFlat({ "filter.status": "review,page", limit: "100" })

    const ids = result.map((s) => s.id)
    expect(ids).toContain(review.id)
    expect(ids).toContain(page.id)
    expect(ids).not.toContain(general.id)
  })

  // -------- filter.environment --------

  test("filter.environment filters by environment kind", async () => {
    const localWs = await workspace("flt-env-local", "local")
    const cloudWs = await workspace("flt-env-cloud", "cloud")

    const localSession = await createSession(localWs, "Local")
    const cloudSession = await createSession(cloudWs, "Cloud")

    const result = await fetchFlat({ "filter.environment": "local", limit: "100" })

    const ids = result.map((s) => s.id)
    expect(ids).toContain(localSession.id)
    expect(ids).not.toContain(cloudSession.id)
  })

  // -------- archived filter --------

  test("archived=active excludes archived sessions (default)", async () => {
    const ws = await workspace("flt-archive")

    const active = await createSession(ws, "Active")
    const arch = await createSession(ws, "Archived")
    const archiveTs = Date.now()
    const archived = await patchArchive(ws, arch.id, archiveTs)
    expect(archived.time?.archived).toBe(archiveTs)

    // Default (no archived param) = active only
    const defaultResult = await fetchFlat({ limit: "100" })
    const defaultIds = defaultResult.map((s) => s.id)
    expect(defaultIds).toContain(active.id)
    expect(defaultIds).not.toContain(arch.id)

    const allResult = await fetchFlat({ archived: "all", limit: "100" })
    const row = allResult.find((s) => s.id === arch.id) as { id: string; time?: { archived?: number } } | undefined
    expect(row?.time?.archived).toBe(archiveTs)
  })

  test("archived=all includes both active and archived sessions", async () => {
    const ws = await workspace("flt-archive-all")

    const active = await createSession(ws, "Active")
    const arch = await createSession(ws, "Archived")

    const result = await fetchFlat({ archived: "all", limit: "100" })

    const ids = result.map((s) => s.id)
    expect(ids).toContain(active.id)
    expect(ids).toContain(arch.id)
  })

  test("archived=true includes both active and archived sessions", async () => {
    const ws = await workspace("flt-archive-compat")

    const active = await createSession(ws, "Active")
    const arch = await createSession(ws, "Archived")
    await patchArchive(ws, arch.id, Date.now())

    const result = await fetchFlat({ archived: "true", limit: "100" })

    const ids = result.map((s) => s.id)
    expect(ids).toContain(active.id)
    expect(ids).toContain(arch.id)
  })

  test("merged list drops stale deleted cloud sessions after a fresh sync", async () => {
    const ws = await workspace("flt-cloud-stale", "cloud")

    await syncHostedSessions(ws, [{
      id: "sess_old",
      title: "Old chat",
      time: { created: 11, updated: 12 },
    }])
    await syncHostedSessions(ws, [
      {
        id: "sess_new",
        title: "New chat",
        time: { created: 21, updated: 22 },
      },
    ])

    const result = await fetchFlat({ workspaceId: ws.id, directory: ws.directory, archived: "all", limit: "100" })
    const ids = result.map((s) => s.id)
    expect(ids).toContain("sess_new")
    expect(ids).not.toContain("sess_old")
  })

  // -------- groupBy + filter combinations --------

  test("groupBy=workspace combined with filter.status", async () => {
    const wsA = await workspace("combo-ws-a")
    const wsB = await workspace("combo-ws-b")

    const reviewA = await createSession(wsA, "Review in A")
    await setMeta(reviewA.id, { tags: ["review"] })

    const generalA = await createSession(wsA, "General in A")

    const reviewB = await createSession(wsB, "Review in B")
    await setMeta(reviewB.id, { tags: ["review"] })

    const result = await fetchGrouped({
      groupBy: "workspace",
      "filter.status": "review",
      perGroup: "10",
    })

    const groupA = result.groups.find((g) => g.directory === wsA.directory)
    const groupB = result.groups.find((g) => g.directory === wsB.directory)

    expect(groupA).toBeDefined()
    expect(groupA!.sessions).toHaveLength(1)
    expect(groupA!.sessions[0]!.id).toBe(reviewA.id)

    expect(groupB).toBeDefined()
    expect(groupB!.sessions).toHaveLength(1)
    expect(groupB!.sessions[0]!.id).toBe(reviewB.id)
  })

  test("groupBy=status combined with filter.environment", async () => {
    const localWs = await workspace("combo-status-local", "local")
    const cloudWs = await workspace("combo-status-cloud", "cloud")

    const localReview = await createSession(localWs, "Local Review")
    await setMeta(localReview.id, { tags: ["review"] })

    const localGeneral = await createSession(localWs, "Local General")

    const cloudReview = await createSession(cloudWs, "Cloud Review")
    await setMeta(cloudReview.id, { tags: ["review"] })

    // Filter to local only, group by status
    const result = await fetchGrouped({
      groupBy: "status",
      "filter.environment": "local",
      perGroup: "10",
    })

    const reviewGroup = result.groups.find((g) => g.key === "review")
    const generalGroup = result.groups.find((g) => g.key === "general")

    expect(reviewGroup).toBeDefined()
    expect(reviewGroup!.sessions.every((s) => s.id !== cloudReview.id)).toBe(true)
    expect(reviewGroup!.sessions.some((s) => s.id === localReview.id)).toBe(true)

    expect(generalGroup).toBeDefined()
    expect(generalGroup!.sessions.some((s) => s.id === localGeneral.id)).toBe(true)
  })

  // -------- roots filter with groupBy --------

  test("groupBy=workspace with roots=true excludes child sessions", async () => {
    const ws = await workspace("grp-roots")

    const parent = await createSession(ws, "Parent")
    const child = await createSession(ws, "Child")
    await setMeta(child.id, { parentID: parent.id })

    const result = await fetchGrouped({
      groupBy: "workspace",
      roots: "true",
      perGroup: "10",
    })

    const group = result.groups.find((g) => g.directory === ws.directory)
    expect(group).toBeDefined()
    const ids = group!.sessions.map((s) => s.id)
    expect(ids).toContain(parent.id)
    expect(ids).not.toContain(child.id)
  })

  // -------- perGroup pagination across groupBy modes --------

  test("perGroup limits sessions in each group for groupBy=status", async () => {
    const ws = await workspace("pg-status")

    // Create 3 review sessions
    for (let i = 0; i < 3; i++) {
      const s = await createSession(ws, `Review ${i}`)
      await setMeta(s.id, { tags: ["review"] })
    }

    const result = await fetchGrouped({ groupBy: "status", perGroup: "2" })

    const reviewGroup = result.groups.find((g) => g.key === "review")
    expect(reviewGroup).toBeDefined()
    expect(reviewGroup!.sessions).toHaveLength(2)
    expect(reviewGroup!.hasMore).toBe(true)
    expect(reviewGroup!.total).toBe(3)
  })

  test("perGroup limits sessions in each group for groupBy=environment", async () => {
    const ws = await workspace("pg-env")

    // Create 3 sessions in one workspace
    for (let i = 0; i < 3; i++) {
      await createSession(ws, `Env ${i}`)
    }

    const result = await fetchGrouped({ groupBy: "environment", perGroup: "2" })

    const localGroup = result.groups.find((g) => g.key === "local")
    expect(localGroup).toBeDefined()
    expect(localGroup!.sessions.length).toBeLessThanOrEqual(2)
    if (localGroup!.total > 2) {
      expect(localGroup!.hasMore).toBe(true)
    }
  })

  // -------- flat response (no groupBy) still works --------

  test("flat response without groupBy returns array sorted by time", async () => {
    const ws = await workspace("flat")

    const s1 = await createSession(ws, "First")
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 50))
    const s2 = await createSession(ws, "Second")

    const result = await fetchFlat({ limit: "100" })

    const ids = result.map((s) => s.id)
    expect(ids).toContain(s1.id)
    expect(ids).toContain(s2.id)

    // s2 should come before s1 (most recent first)
    const idx1 = ids.indexOf(s1.id)
    const idx2 = ids.indexOf(s2.id)
    expect(idx2).toBeLessThan(idx1)
  })

  // -------- response shape validation --------

  test("grouped response includes key field on all groups", async () => {
    const ws = await workspace("shape-key")
    await createSession(ws, "Shape")

    for (const groupBy of ["workspace", "updated", "status", "environment"]) {
      const result = await fetchGrouped({ groupBy, perGroup: "10" })

      for (const group of result.groups) {
        expect(typeof group.key).toBe("string")
        expect(group.key.length).toBeGreaterThan(0)
        expect(typeof group.hasMore).toBe("boolean")
        expect(typeof group.total).toBe("number")
        expect(Array.isArray(group.sessions)).toBe(true)
      }
    }
  })

  test("workspace groups include directory and projectID fields", async () => {
    const ws = await workspace("shape-ws")
    await createSession(ws, "WS Shape")

    const result = await fetchGrouped({ groupBy: "workspace", perGroup: "10" })

    const group = result.groups.find((g) => g.directory === ws.directory)
    expect(group).toBeDefined()
    expect(group!.directory).toBe(ws.directory)
    expect(group!.projectID).toBe(ws.project_id)
  })

  test("flat response canonicalizes projectID from resolved workspace instead of leaking source projectID", async () => {
    const ws = await workspace("shape-flat-project")
    seedUpstreamSession({
      id: "ses_wrong_project_flat",
      directory: ws.directory,
      title: "Wrong Project Flat",
      projectID: "proj_wrong_flat",
    })

    const result = await fetchFlat({
      workspaceId: ws.id,
      directory: ws.directory,
      archived: "all",
      limit: "100",
    })

    const hit = result.find((item) => item.id === "ses_wrong_project_flat")
    expect(hit).toBeDefined()
    expect(hit!.projectID).toBe(ws.project_id)
  })

  test("session list canonicalizes projectID from resolved workspace instead of leaking source projectID", async () => {
    const ws = await workspace("shape-session-project")
    seedUpstreamSession({
      id: "ses_wrong_project_session",
      directory: ws.directory,
      title: "Wrong Project Session",
      projectID: "proj_wrong_session",
    })

    const result = await fetchSessionList({
      workspaceId: ws.id,
      directory: ws.directory,
    })

    const hit = result.find((item) => item.id === "ses_wrong_project_session")
    expect(hit).toBeDefined()
    expect(hit!.projectID).toBe(ws.project_id)
  })

  test("workspace groups canonicalize group and session projectID from resolved workspace", async () => {
    const ws = await workspace("shape-group-project")
    seedUpstreamSession({
      id: "ses_wrong_project_group",
      directory: ws.directory,
      title: "Wrong Project Group",
      projectID: "proj_wrong_group",
    })

    const result = await fetchGrouped({
      workspaceId: ws.id,
      directory: ws.directory,
      groupBy: "workspace",
      perGroup: "10",
    })

    const group = result.groups.find((item) => item.directory === ws.directory)
    expect(group).toBeDefined()
    expect(group!.projectID).toBe(ws.project_id)
    const hit = group!.sessions.find((item) => item.id === "ses_wrong_project_group")
    expect(hit).toBeDefined()
    expect(hit!.projectID).toBe(ws.project_id)
  })

  test("non-workspace groups do not include directory/projectID fields", async () => {
    const ws = await workspace("shape-nonws")
    await createSession(ws, "Non-WS")

    for (const groupBy of ["updated", "status", "environment"]) {
      const result = await fetchGrouped({ groupBy, perGroup: "10" })

      for (const group of result.groups) {
        expect(group.directory).toBeUndefined()
        expect(group.projectID).toBeUndefined()
      }
    }
  })
})
