import { afterEach, expect, test } from "bun:test"
import { onlineManager } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createServer, type ServerHandle } from "./server"

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

const bootstrap = { deployment: { serverKind: "hosted", issuesSessions: true }, events: { hostAggregate: false } }
const box = { host_id: "host_box", enrollment_id: "enr_box", display_name: "build-box", last_seen_at: 1_000, state: "online", workspace_ids: ["ws_box", "ws_unacked"], serving_workspace_ids: ["ws_box"] }

const asking = {
  pairing_id: "pair_1",
  expires_at: 9_000,
  asked_at: 8_000,
  request: "machine",
  stage: "awaiting_approval",
  machine: { hostname: "studio", os: "Ubuntu 24.04", arch: "x64", folder: "/home/ubuntu", folder_kind: "home", country: "IN" },
  host_id: "host_studio",
}

type World = {
  devices: Record<string, unknown>[]
  connection: { status: number; body: unknown }
  health: unknown
  invitation?: unknown
  calls: { method: string; path: string; body?: unknown }[]
}

function pairingAnswer(url: URL, method: string, world: World): Response | undefined {
  if (url.pathname === "/api/claxedo/host/pairings" && method === "POST") return Response.json({ pairing_id: "pair_1", code: "K7QM4PXD9R2TWB6HJ3NF", expires_at: 9_000, commands: { posix: "curl posix", windows: "irm windows" } })
  if (url.pathname === "/api/claxedo/host/pairings" && method === "GET") return Response.json({ requests: [asking, { pairing_id: "pair_broken" }] })
  if (url.pathname === "/api/claxedo/host/pairings" && method === "DELETE") return Response.json({ cancelled: 2 })
  if (url.pathname === "/api/claxedo/host/pairings/pair_1") return Response.json({ pairing: asking })
  if (url.pathname.startsWith("/api/claxedo/host/pairings/pair_1/")) return Response.json({ pairing: { ...asking, stage: "approved" } })
  if (url.pathname === "/api/claxedo/host/invitations" && method === "POST") return Response.json(world.invitation)
  return undefined
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
    const pairing = pairingAnswer(url, method, world)
    if (pairing) return pairing
    if (url.pathname === "/api/claxedo/remote-access/devices/host_box" && method === "PATCH") {
      const name = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { display_name: string }).display_name
      world.devices = world.devices.map((device) => ({ ...device, display_name: name }))
      return Response.json({ display_name: name })
    }
    if (url.pathname === "/api/claxedo/host/enrollments/enr_box/scope" && method === "PATCH") {
      const roots = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { allowed_roots: string[] }).allowed_roots
      world.devices = world.devices.map((device) => ({ ...device, roots: roots.map((path) => ({ path, retires: [] })) }))
      return Response.json({ host_id: "host_box", scope: { allowed_roots: roots, revision: 3 }, retired_workspace_ids: [] })
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
      expect(machines.map((machine) => [machine.name, machine.online, machine.enrollment])).toEqual([["build-box", true, { hostId: "host_box", enrollmentId: "enr_box", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"] }]])
      expect(JSON.stringify(logged)).toContain("enr_old")
    })
  } finally { console.error = originalError }
})

test("what a machine reported reaches the app in its own names, and a part it cannot read is left out", async () => {
  const reported = {
    ...box,
    cli_version: "0.2.1", os: "Ubuntu 24.04", arch: "x64",
    roots: [{ path: "/srv", retires: [{ workspace_id: "ws_box", display_name: "app", directory: "/srv/app" }, { display_name: "no id" }] }, { retires: [] }],
    blocked: { reason: "linger_off", fix: "sudo loginctl enable-linger u && claxedo connect --install-service", reported_at: 900 },
    update: { version: "0.2.2", command: "curl -fsSL https://cp.test/api/claxedo/connect | sh && claxedo connect --install-service" },
  }
  scenario({ devices: [reported, { ...box, host_id: "host_odd", enrollment_id: "enr_odd", blocked: { reason: "disk_full", fix: "x", reported_at: 1 }, update: { version: "" } }] })
  await signedBrowser(async (server) => {
    const [machine, odd] = await server.queryClient.fetchQuery(server.queries.machines.list())
    expect(machine?.enrollment).toEqual({
      hostId: "host_box", enrollmentId: "enr_box", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"],
      cliVersion: "0.2.1", os: "Ubuntu 24.04", arch: "x64",
      roots: [{ path: "/srv", retires: [{ workspaceId: "ws_box", name: "app", directory: "/srv/app" }] }],
      blocked: { reason: "lingerOff", fix: "sudo loginctl enable-linger u && claxedo connect --install-service", reportedAt: 900 },
      update: { version: "0.2.2", command: "curl -fsSL https://cp.test/api/claxedo/connect | sh && claxedo connect --install-service" },
    })
    expect(odd?.enrollment, "an unknown reason and an empty update are not shown").toEqual({ hostId: "host_odd", enrollmentId: "enr_odd", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"] })
  })
})

test("renaming names the machine by its host id and changing its roots names its enrollment, and the list is read again after each", async () => {
  const world = scenario()
  await signedBrowser(async (server) => {
    const listed = () => server.queryClient.fetchQuery(server.queries.machines.list())
    const enrollment = (await listed())[0]?.enrollment
    if (!enrollment) throw new Error("the listed machine has no enrollment")
    await server.machines.rename(enrollment, "studio")
    expect((await listed()).map((machine) => machine.name)).toEqual(["studio"])
    await server.machines.setRoots(enrollment, ["/srv/app"])
    expect((await listed()).map((machine) => machine.enrollment?.roots)).toEqual([[{ path: "/srv/app", retires: [] }]])
    expect(world.calls.filter((call) => call.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/claxedo/remote-access/devices/host_box", body: { display_name: "studio" } },
      { method: "PATCH", path: "/api/claxedo/host/enrollments/enr_box/scope", body: { allowed_roots: ["/srv/app"] } },
    ])
  })
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
    const served = { hostId: "host_box", enrollmentId: "enr_box", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"] }
    expect(await server.machines.probe(served)).toEqual({ kind: "answered" })
    expect(world.calls.filter((call) => call.path.startsWith("relay:")).map((call) => call.path)).toEqual(["relay:/workspaces/ws_box/global/health"])
    expect(await server.machines.probe({ ...served, servingWorkspaceIds: [] })).toEqual({ kind: "servesNothing" })

    world.health = { healthy: false, ok: false, status: "starting" }
    expect(await server.machines.probe(served)).toEqual({ kind: "unhealthy", status: "starting" })
  })

  const offline = scenario({ connection: { status: 409, body: { error: { code: "workspace_host_offline", message: "The machine is offline" } } } })
  await signedBrowser(async (server) => {
    const probe = await server.machines.probe({ hostId: "host_box", enrollmentId: "enr_box", lastSeenAt: 1_000, servingWorkspaceIds: ["ws_box"] })
    expect(probe).toMatchObject({ kind: "unreachable", error: { class: "conflict", code: "workspace_host_offline" } })
    expect(offline.calls.some((call) => call.path.startsWith("relay:"))).toBe(false)
  })
})

test("a pairing is minted with the commands the control plane answers, read back in the app's terms, and answered by its id", async () => {
  const world = scenario()
  const logged: unknown[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    await signedBrowser(async (server) => {
      expect(await server.machines.pair()).toEqual({ id: "pair_1", code: "K7QM4PXD9R2TWB6HJ3NF", expiresAt: 9_000, commands: { posix: "curl posix", windows: "irm windows" } })
      const pairing = await server.queryClient.fetchQuery(server.queries.machines.pairing("pair_1"))
      expect(pairing).toEqual({
        id: "pair_1",
        stage: "awaitingApproval",
        expiresAt: 9_000,
        askedAt: 8_000,
        request: "machine",
        machine: { hostname: "studio", os: "Ubuntu 24.04", arch: "x64", folder: "/home/ubuntu", folderKind: "home", country: "IN" },
        hostId: "host_studio",
      })
      expect((await server.queryClient.fetchQuery(server.queries.machines.pairingRequests())).map((request) => request.id)).toEqual(["pair_1"])
      expect(JSON.stringify(logged)).toContain("pair_broken")
      await server.machines.approve("pair_1", "studio-box")
      await server.machines.deny("pair_1")
      await server.machines.cancelPairings()
      expect(world.calls.filter((call) => call.method !== "GET")).toEqual([
        { method: "POST", path: "/api/claxedo/host/pairings", body: {} },
        { method: "POST", path: "/api/claxedo/host/pairings/pair_1/approve", body: { displayName: "studio-box" } },
        { method: "POST", path: "/api/claxedo/host/pairings/pair_1/deny", body: {} },
        { method: "DELETE", path: "/api/claxedo/host/pairings" },
      ])
    })
  } finally { console.error = originalError }
})

test("invite mints a pre-approved invitation sharing the one folder named, with the commands the control plane wrote; an answer without them is an internal failure", async () => {
  const commands = { posix: "curl -fsSL https://worker.test/api/claxedo/connect | sh -s -- --invitation chx_inv_2.x.y.z --root '/srv/app'", windows: "& … -Root '/srv/app'", cloudInit: "#cloud-config\nruncmd:\n  - \"curl …\"" }
  const world = scenario({ invitation: { invitation_id: "invitation_1", token: "chx_inv_2.x.y.z", expires_at: 9_999, commands } })
  await signedBrowser(async (server) => {
    expect(await server.machines.invite({ name: "build-box", folder: "/srv/app" })).toEqual({ id: "invitation_1", expiresAt: 9_999, commands })
    await server.machines.invite({ name: "", folder: "/srv/app" })
    expect(world.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/api/claxedo/host/invitations", body: { scope: { allowed_roots: ["/srv/app"] }, sharesRoot: true, displayName: "build-box" } },
      { method: "POST", path: "/api/claxedo/host/invitations", body: { scope: { allowed_roots: ["/srv/app"] }, sharesRoot: true } },
    ])
    world.invitation = { invitation_id: "invitation_2", token: "chx_inv_2.x.y.z", expires_at: 9_999 }
    await expect(server.machines.invite({ name: "", folder: "/srv/app" })).rejects.toMatchObject({ class: "internal" })
  })
})
