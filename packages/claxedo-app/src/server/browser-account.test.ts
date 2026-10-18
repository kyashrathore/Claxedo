import { afterEach, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createServer } from "./server"
import { projectId } from "./ids"
import { stored, shape } from "./test-session-server"

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

const cloud = { workspace_id: "ws_cloud", project_id: "prj_app", project_name: "App", backing: "cloud-vm", reachable: false }
const machine = { workspace_id: "ws_machine", project_id: "prj_app", backing: "local-worktree", host_online: false, placement: { host_enrollment_id: "enr_1" } }
const bootstrap = {
  deployment: { serverKind: "hosted", issuesSessions: true },
  events: { hostAggregate: false },
}

function worker(options: { unauthorized?: boolean; malformed?: boolean; identityUnavailable?: boolean; databaseUnavailable?: number } = {}) {
  const calls: { path: string; init?: RequestInit }[] = []
  let unavailable = options.databaseUnavailable ?? 0
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push({ path: `${url.pathname}${url.search}`, init })
    if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap)
    if (url.pathname === "/api/workspace/shared-sessions") return Response.json({ sessions: [] })
    if (url.pathname === "/api/cp/events") {
      return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }) } }))
    }
    if (url.pathname === "/api/workspace/create") return Response.json({ workspaceId: "ws_cloud", directory: "workspace:ws_cloud" })
    if (url.pathname === "/api/workspace") {
      if (unavailable > 0 && url.searchParams.get("host") === "provisioner") {
        unavailable -= 1
        return Response.json({ error: { code: "database_unavailable", message: "The database did not answer. Try again.", retryable: true } }, { status: 503 })
      }
      if (options.identityUnavailable) return Response.json({ error: { code: "auth_verifier_unavailable", message: "Application identity mapping is unavailable", retryable: false } }, { status: 503 })
      if (options.unauthorized) return Response.json({ error: { code: "session_expired", message: "Sign in again" } }, { status: 401 })
      if (options.malformed) return Response.json({ workspaces: "wrong" })
      return Response.json({ workspaces: url.searchParams.get("host") === "machine" ? [machine] : [cloud, machine] })
    }
    if (url.pathname === "/api/control/sessions/ses_1/outline") return Response.json({ session: { session_id: "ses_1", title: "Stored turn", created_at: 1, updated_at: 2 }, outline: { turns: [], complete: true }, page: { turns: [{ messages: stored }] } })
    if (url.pathname === "/api/claxedo/remote-access/devices") return Response.json({ devices: [{ enrollment_id: "enr_1", display_name: "Studio", state: "online" }] })
    if (url.pathname === "/api/claxedo/agent-config/connections") return Response.json({ status: "supported", connections: [] })
    if (url.pathname === "/api/control/session-list") return Response.json({ items: [{ sessionId: "ses_1", workspaceId: "ws_cloud", directory: "workspace:ws_cloud", title: "Stored turn", sessionRef: "ws_cloud:ses_1", createdAt: 1, updatedAt: 2 }] })
    throw new Error(`Unexpected Worker request: ${url.pathname}`)
  }, { preconnect: originalFetch.preconnect })
  return calls
}

test("signed browser build lists account projects, placements and sessions with no daemon", async () => {
  const calls = worker()
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      expect(server.startup().kind).toBe("ready")
      const projects = await server.queryClient.fetchQuery(server.queries.projects.list())
      expect(projects.map((project) => [project.id, project.name])).toEqual([["prj_app", "App"]])
      expect(server.placements.list().map((placement) => [String(placement.id), placement.kind, placement.reachable])).toEqual([["ws_cloud", "cloud", false], ["ws_machine", "worktree", false]])
      const page = await server.sessions.list({ projectId: projectId("prj_app"), limit: 5, settled: "active" })
      expect(page.rows.map((row) => [row.ref.sessionId, row.ref.placementId, row.title])).toEqual([["ses_1", "ws_cloud", "Stored turn"]])
      const reads = server.sessions.read(page.rows[0].ref, shape)
      expect((await reads.first).transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
      await Promise.all([reads.status, reads.requests, reads.todos, reads.goal, reads.subagents])
      await expect(server.queryClient.fetchQuery(server.queries.projects.byId(projectId("missing")))).rejects.toMatchObject({ class: "not_found" })
      expect(calls.some((call) => call.path.startsWith("/api/claxedo/projects"))).toBe(false)
      expect(calls.filter((call) => call.path.startsWith("/api/control/session-list"))).toHaveLength(1)
      expect(calls.every((call) => call.init?.credentials === "include" && !new Headers(call.init?.headers).has("Authorization"))).toBe(true)
    } finally { server.dispose(); dispose() }
  })
})

test("a signed browser reads its machines and agent connections beside the account catalog, before any screen asks for them", async () => {
  const calls = worker()
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      const shellReads = ["/api/claxedo/remote-access/devices", "/api/claxedo/agent-config/connections"]
      const beforeAnyScreen = calls.map((call) => call.path)
      expect(shellReads.filter((path) => beforeAnyScreen.includes(path))).toEqual(shellReads)
      expect((await server.queryClient.fetchQuery(server.queries.machines.list())).map((machine) => [String(machine.id), machine.name, machine.online])).toEqual([["enr_1", "Studio", true]])
      expect(await server.queryClient.fetchQuery(server.queries.agentConnections.list())).toEqual({ status: "supported", connections: [] })
      expect(shellReads.map((path) => calls.filter((call) => call.path === path).length)).toEqual([1, 1])
    } finally { server.dispose(); dispose() }
  })
})

test("a browser scope with nobody signed in reads the public bootstrap and opens no event stream on a server that issues sessions", async () => {
  const calls = worker()
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test" })
    try {
      await server.ready
      expect(server.startup().kind).toBe("ready")
      expect(server.capabilities()).toMatchObject({ issuesSessions: true, hostedAccount: false })
      expect(calls.map((call) => call.path)).toEqual(["/api/claxedo/bootstrap"])
    } finally { server.dispose(); dispose() }
  })
})

test("a signed browser scope opens the control plane's event stream once", async () => {
  const calls = worker()
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      expect(calls.filter((call) => call.path === "/api/cp/events")).toHaveLength(1)
    } finally { server.dispose(); dispose() }
  })
})

for (const [options, failure] of [
  [{ unauthorized: true }, { class: "auth", code: "session_expired", status: 401 }],
  [{ malformed: true }, { class: "internal" }],
  [{ identityUnavailable: true }, { class: "network", code: "auth_verifier_unavailable", status: 503, retryable: false }],
] as const) {
  test(`signed browser catalog surfaces ${failure.class} failures and recovers on the next read`, async () => {
    worker(options)
    await createRoot(async (dispose) => {
      const server = createServer({ serverUrl: "https://worker.test", cookies: true })
      const originalError = console.error
      console.error = () => undefined
      try {
        await server.ready
        expect(server.startup()).toMatchObject({ kind: "failed", failure })
        await expect(server.queryClient.fetchQuery(server.queries.projects.list())).rejects.toMatchObject(failure)
        worker()
        await server.retryConnection()
        expect(server.startup().kind).toBe("ready")
        expect(server.capabilities()).toMatchObject({ issuesSessions: true, hostedAccount: true, features: { cloud: true } })
        expect((await server.queryClient.fetchQuery(server.queries.projects.list())).map((project) => String(project.id))).toEqual(["prj_app"])
      } finally { console.error = originalError; server.dispose(); dispose() }
    })
  })
}

test("a transient database failure on the account catalog is retried before the shell opens", async () => {
  const calls = worker({ databaseUnavailable: 1 })
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      expect(server.startup().kind).toBe("ready")
      expect(server.placements.list().map((placement) => String(placement.id))).toEqual(["ws_cloud", "ws_machine"])
      expect(calls.filter((call) => call.path === "/api/workspace?host=provisioner")).toHaveLength(2)
    } finally { server.dispose(); dispose() }
  })
}, 10_000)

test("an account catalog that stays unavailable opens the shell and fails only the sections that read it, which recover on retry", async () => {
  const calls = worker({ databaseUnavailable: Number.POSITIVE_INFINITY })
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    const originalError = console.error
    console.error = () => undefined
    try {
      await server.ready
      expect(server.startup().kind).toBe("ready")
      expect(server.capabilities()).toMatchObject({ issuesSessions: true, hostedAccount: true, features: { cloud: true } })
      expect(server.placements.complete()).toBe(false)
      await expect(server.queryClient.fetchQuery(server.queries.projects.list())).rejects.toMatchObject({ class: "network", code: "database_unavailable", retryable: true })
      expect(calls.filter((call) => call.path === "/api/workspace?host=provisioner").length).toBeGreaterThan(3)
      worker()
      expect((await server.queryClient.fetchQuery(server.queries.projects.list())).map((project) => String(project.id))).toEqual(["prj_app"])
      expect(server.placements.complete()).toBe(true)
    } finally { console.error = originalError; server.dispose(); dispose() }
  })
}, 20_000)

for (const action of ["update", "remove", "reclone"] as const) {
  test(`hosted project ${action} refuses daemon configuration without a request`, async () => {
    const calls = worker()
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      const id = projectId("prj_app")
      const result = action === "update" ? server.projects.update(id, { icon: { color: "pink" } }) : server.projects[action](id)
      await expect(result).rejects.toMatchObject({ class: "invalid", code: "project_configuration_unavailable" })
      expect(calls.some((call) => call.path.startsWith("/api/claxedo/projects"))).toBe(false)
    } finally { server.dispose() }
  })
}

test("a hosted project create from a repository URL is that repository's first cloud workspace, named after it, answered as the account project the catalog lists, with no daemon request", async () => {
  const calls = worker()
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      const project = await server.projects.create({ source: { kind: "repository", url: "https://github.com/owner/app.git" } })
      expect([String(project.id), project.name]).toEqual(["prj_app", "App"])
      const request = calls.find((call) => call.path === "/api/workspace/create")
      const body = request?.init?.body
      expect(typeof body === "string" ? JSON.parse(body) : body).toEqual({ workspaceName: "app", repoUrl: "https://github.com/owner/app.git" })
      expect(calls.some((call) => call.path.startsWith("/api/claxedo/projects"))).toBe(false)
    } finally { server.dispose(); dispose() }
  })
})

test("a signed browser creates a cloud workspace from a connected repository through its own session, with no project created first", async () => {
  const calls = worker()
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      const workspace = await server.cloud.create({ source: { kind: "connectedRepository", connectionId: "github_1", fullName: "owner/app" }, name: "App" })
      expect([String(workspace.id), String(workspace.projectId)]).toEqual(["ws_cloud", "prj_app"])
      const request = calls.find((call) => call.path === "/api/workspace/create")
      expect(request?.init?.credentials).toBe("include")
      const body = request?.init?.body
      expect(typeof body === "string" ? JSON.parse(body) : body).toEqual({ workspaceName: "App", connectionId: "github_1", repo: { fullName: "owner/app" } })
      expect(calls.some((call) => call.path.startsWith("/api/claxedo/projects"))).toBe(false)
    } finally { server.dispose(); dispose() }
  })
})
