import { afterEach, expect, test } from "bun:test"
import { onlineManager } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createServer, type ServerHandle } from "./server"

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

const bootstrap = { deployment: { serverKind: "hosted", issuesSessions: true }, events: { hostAggregate: false } }
const box = { host_id: "host_box", enrollment_id: "enr_box", display_name: "build-box", last_seen_at: 1_000, state: "online", workspace_ids: ["ws_box", "ws_unacked"], serving_workspace_ids: ["ws_box"] }

type World = {
  devices: Record<string, unknown>[]
  connection: { status: number; body: unknown }
  health: unknown
  calls: { method: string; path: string; body?: unknown }[]
}

function worker(world: World) {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? "GET"
    world.calls.push({ method, path: `${url.origin === "https://relay.test" ? "relay:" : ""}${url.pathname}`, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) })
    if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap)
    if (url.pathname === "/api/workspace/shared-sessions") return Response.json({ sessions: [] })
    if (url.pathname === "/api/cp/events") return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }) } }))
    if (url.pathname === "/api/workspace") return Response.json({ workspaces: [] })
    if (url.pathname === "/api/claxedo/agent-config/connections") return Response.json({ status: "supported", connections: [] })
    if (url.pathname === "/api/claxedo/remote-access/devices") return Response.json({ devices: world.devices })
    if (url.pathname === "/api/claxedo/host/enrollments/pause") {
      const paused = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { paused: boolean }).paused
      world.devices = world.devices.map((device) => ({ ...device, state: paused ? "paused" : "online" }))
      return Response.json({ paused })
    }
    if (url.pathname === "/api/claxedo/remote-access/devices/host_box" && method === "DELETE") {
      world.devices = []
      return Response.json({ revoked: true })
    }
    if (url.pathname === "/api/workspace/ws_box/connection") return Response.json(world.connection.body, { status: world.connection.status })
    if (url.href === "https://relay.test/workspaces/ws_box/global/health") return Response.json(world.health)
    throw new Error(`Unexpected request: ${method} ${url.href}`)
  }, { preconnect: originalFetch.preconnect })
}

function scenario(overrides: Partial<World> = {}): World {
  const world: World = {
    devices: [box],
    connection: { status: 200, body: { backing: "local-worktree", relayUrl: "https://relay.test", runtimeAccessToken: "rat", tokenExpiresAt: Date.now() + 600_000 } },
    health: { healthy: true, ok: true, status: "ready", service: "workspace-runtime", workspaceId: "ws_box" },
    calls: [],
    ...overrides,
  }
  worker(world)
  return world
}

async function signedBrowser(run: (server: ServerHandle) => Promise<void>) {
  await createRoot(async (dispose) => {
    const server = createServer({ serverUrl: "https://worker.test", cookies: true })
    try {
      await server.ready
      await run(server)
    } finally { server.dispose(); dispose() }
  })
}

test("a machine on the devices list carries its host id, last check-in and the folders it serves; an unreadable row is left out and logged", async () => {
  scenario({ devices: [box, { enrollment_id: "enr_old", display_name: "old", state: "online" }] })
  const logged: unknown[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    await signedBrowser(async (server) => {
      const machines = await server.queryClient.fetchQuery(server.queries.machines.list())
      expect(machines.map((machine) => [machine.name, machine.online, machine.enrollment])).toEqual([["build-box", true, { hostId: "host_box", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"] }]])
      expect(JSON.stringify(logged)).toContain("enr_old")
    })
  } finally { console.error = originalError }
})

test("pause, resume and remove each name one machine by its host id, and the list is read again after each", async () => {
  const world = scenario()
  await signedBrowser(async (server) => {
    const [machine] = await server.queryClient.fetchQuery(server.queries.machines.list())
    const enrollment = machine?.enrollment
    if (!enrollment) throw new Error("the listed machine has no enrollment")
    const listed = () => server.queryClient.fetchQuery(server.queries.machines.list())

    await server.machines.pause(enrollment)
    expect((await listed()).map((row) => row.paused === true)).toEqual([true])
    await server.machines.resume(enrollment)
    expect((await listed()).map((row) => [row.online, row.paused === true])).toEqual([[true, false]])
    await server.machines.remove(enrollment)
    expect(await listed()).toEqual([])

    const writes = world.calls.filter((call) => call.method !== "GET")
    expect(writes).toEqual([
      { method: "POST", path: "/api/claxedo/host/enrollments/pause", body: { hostId: "host_box", paused: true } },
      { method: "POST", path: "/api/claxedo/host/enrollments/pause", body: { hostId: "host_box", paused: false } },
      { method: "DELETE", path: "/api/claxedo/remote-access/devices/host_box" },
    ])
  })
})

test("recheck reads the devices list again past the cache and fails on the first refusal instead of retrying", async () => {
  const world = scenario()
  await signedBrowser(async (server) => {
    await server.queryClient.fetchQuery(server.queries.machines.list())
    world.devices = [{ ...box, state: "offline" }]
    expect((await server.machines.recheck()).map((machine) => machine.online)).toEqual([false])
    globalThis.fetch = Object.assign(async () => Response.json({ error: { code: "upstream_down", message: "down" } }, { status: 503 }), { preconnect: originalFetch.preconnect })
    await expect(server.machines.recheck()).rejects.toMatchObject({ class: "network", status: 503 })
  })
})

test("recheck on a device that is offline fails at once rather than waiting to come back online", async () => {
  scenario()
  await signedBrowser(async (server) => {
    await server.queryClient.fetchQuery(server.queries.machines.list())
    onlineManager.setOnline(false)
    try {
      globalThis.fetch = Object.assign(async () => { throw new TypeError("Failed to fetch") }, { preconnect: originalFetch.preconnect })
      void server.queryClient.invalidateQueries({ queryKey: server.queries.machines.list().queryKey })
      await expect(server.machines.recheck()).rejects.toMatchObject({ class: "network" })
    } finally { onlineManager.setOnline(true) }
  })
})

test("the runtime probe reads one served folder's health through the relay, says when nothing is served, and returns a refusal as a typed failure", async () => {
  const world = scenario()
  await signedBrowser(async (server) => {
    const served = { hostId: "host_box", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"] }
    expect(await server.machines.probe(served)).toEqual({ kind: "answered" })
    expect(world.calls.filter((call) => call.path.startsWith("relay:")).map((call) => call.path)).toEqual(["relay:/workspaces/ws_box/global/health"])
    expect(await server.machines.probe({ ...served, servingWorkspaceIds: [] })).toEqual({ kind: "servesNothing" })

    world.health = { healthy: false, ok: false, status: "starting" }
    expect(await server.machines.probe(served)).toEqual({ kind: "unhealthy", status: "starting" })
  })

  const offline = scenario({ connection: { status: 409, body: { error: { code: "workspace_host_offline", message: "The machine is offline" } } } })
  await signedBrowser(async (server) => {
    const probe = await server.machines.probe({ hostId: "host_box", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"] })
    expect(probe).toMatchObject({ kind: "unreachable", error: { class: "conflict", code: "workspace_host_offline" } })
    expect(offline.calls.some((call) => call.path.startsWith("relay:"))).toBe(false)
  })
})
