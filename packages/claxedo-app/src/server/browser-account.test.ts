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

function worker(options: { unauthorized?: boolean; malformed?: boolean } = {}) {
  const calls: { path: string; init?: RequestInit }[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push({ path: `${url.pathname}${url.search}`, init })
    if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap)
    if (url.pathname === "/api/workspace/shared-sessions") return Response.json({ sessions: [] })
    if (url.pathname === "/api/cp/events") {
      return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }) } }))
    }
    if (url.pathname === "/api/workspace") {
      if (options.unauthorized) return Response.json({ error: { code: "session_expired", message: "Sign in again" } }, { status: 401 })
      if (options.malformed) return Response.json({ workspaces: "wrong" })
      return Response.json({ workspaces: url.searchParams.get("host") === "machine" ? [machine] : [cloud] })
    }
    if (url.pathname === "/api/control/sessions/ses_1/outline") return Response.json({ session: { session_id: "ses_1", title: "Stored turn", created_at: 1, updated_at: 2 }, outline: { turns: [], complete: true }, page: { turns: [{ messages: stored }] } })
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
      const projects = await server.queryClient.fetchQuery(server.queries.projects.list())
      expect(projects.map((project) => [project.id, project.name])).toEqual([["prj_app", "App"]])
      expect(server.placements.list().map((placement) => [String(placement.id), placement.kind, placement.reachable])).toEqual([["ws_cloud", "cloud", false], ["ws_machine", "worktree", false]])
      const page = await server.sessions.list({ projectId: projectId("prj_app"), limit: 5 })
      expect(page.rows.map((row) => [row.ref.sessionId, row.ref.placementId, row.title])).toEqual([["ses_1", "ws_cloud", "Stored turn"]])
      const reads = server.sessions.read(page.rows[0]!.ref, shape)
      expect((await reads.first).transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
      await Promise.all([reads.status, reads.requests, reads.todos, reads.goal, reads.subagents])
      await expect(server.queryClient.fetchQuery(server.queries.projects.byId(projectId("missing")))).rejects.toMatchObject({ class: "not_found" })
      expect(calls.some((call) => call.path.startsWith("/api/claxedo/projects"))).toBe(false)
      expect(calls.filter((call) => call.path.startsWith("/api/control/session-list"))).toHaveLength(1)
      expect(calls.every((call) => call.init?.credentials === "include" && !new Headers(call.init?.headers).has("Authorization"))).toBe(true)
    } finally { server.dispose(); dispose() }
  })
})

for (const [options, failure] of [
  [{ unauthorized: true }, { class: "auth", code: "session_expired", status: 401 }],
  [{ malformed: true }, { class: "internal" }],
] as const) {
  test(`signed browser catalog surfaces ${failure.class} failures and recovers on the next read`, async () => {
    worker(options)
    await createRoot(async (dispose) => {
      const server = createServer({ serverUrl: "https://worker.test", cookies: true })
      const originalError = console.error
      console.error = () => undefined
      try {
        await server.ready
        await expect(server.queryClient.fetchQuery(server.queries.projects.list())).rejects.toMatchObject(failure)
        worker()
        await server.placements.load()
        expect((await server.queryClient.fetchQuery(server.queries.projects.list())).map((project) => String(project.id))).toEqual(["prj_app"])
      } finally { console.error = originalError; server.dispose(); dispose() }
    })
  })
}

for (const action of ["create", "update", "remove", "reclone"] as const) {
  test(`hosted project ${action} refuses daemon configuration without a request`, async () => {
    const calls = worker()
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      const id = projectId("prj_app")
      const result = action === "create" ? server.projects.create({ source: { kind: "repository", url: "https://github.com/owner/app" } })
        : action === "update" ? server.projects.update(id, { icon: { color: "pink" } })
        : server.projects[action](id)
      await expect(result).rejects.toMatchObject({ class: "invalid", code: "project_configuration_unavailable" })
      expect(calls.some((call) => call.path.startsWith("/api/claxedo/projects"))).toBe(false)
    } finally { server.dispose() }
  })
}
