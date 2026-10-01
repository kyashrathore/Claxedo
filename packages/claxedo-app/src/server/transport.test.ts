import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { createTransport } from "./transport"
import { QueryClient } from "@tanstack/solid-query"
import { createPlacementStreams } from "./placement-streams"
import { placementId, projectId, sessionId } from "./ids"
import type { Workspaces } from "./workspaces"
import { createWorkspaceWakes } from "./workspace-wakes"

const fetcher = spyOn(globalThis, "fetch")
const link = { relayUrl: "https://relay.test", runtimeAccessToken: "session-rat", tokenExpiresAt: Date.now() + 3_600_000 }
const cloud = { kind: "cloud" as const, directory: "workspace:ws_cloud", workspaceId: "ws_cloud", remote: true }

afterEach(() => fetcher.mockReset())
afterAll(() => fetcher.mockRestore())

function signed(...answers: unknown[]) {
  const calls: { operation: string; input: unknown }[] = []
  const transport = createTransport({ serverUrl: "http://127.0.0.1:4444", auth: { kind: "none" }, account: async (operation, input) => {
    calls.push({ operation, input })
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return answer
  } })
  return { transport, calls }
}

test("signed desktop cloud wake uses the account and adopts the workspace link", async () => {
  const { transport, calls } = signed({ status: "provisioning", retryAfterMs: 500, bootMode: "resume" }, link)
  const progress: unknown[] = []
  fetcher.mockResolvedValue(Response.json({ ok: true }))
  await transport.startRuntime(cloud, { wait: async () => undefined, onProgress: (step) => progress.push(step) })
  await transport.runtime(cloud, "/api/wr/health")
  expect(calls).toEqual(Array(2).fill({ operation: "workspace.connection.mint", input: { id: "ws_cloud" } }))
  expect(progress).toEqual([{ kind: "provisioning", bootMode: "resume" }])
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://relay.test/workspaces/ws_cloud/api/wr/health"])
})

test("the public workspace wake owner sends a signed desktop cloud wake to the account instead of the daemon", async () => {
  const { transport, calls } = signed(link)
  fetcher.mockResolvedValue(Response.json(link))
  let running = false
  const workspaces = {
    locate: async () => cloud,
    refresh: async () => { running = true },
    byId: () => ({ kind: "cloud", reachable: running }),
  } as unknown as Workspaces
  const wakes = createWorkspaceWakes(transport, workspaces)
  const id = placementId("ws_cloud")
  await wakes.start(id)
  await transport.runtime(cloud, "/api/wr/health")
  expect(calls).toEqual([{ operation: "workspace.connection.mint", input: { id: "ws_cloud" } }])
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://relay.test/workspaces/ws_cloud/api/wr/health"])
  expect(wakes.runtime(id)).toEqual({ kind: "live" })
})

test("signed desktop cloud and remote machine session reads use a session connection and only its relay token", async () => {
  const machine = { kind: "worktree" as const, directory: "workspace:ws_machine", workspaceId: "ws_machine", remote: true }
  for (const route of [machine, cloud]) {
    fetcher.mockReset().mockResolvedValue(Response.json({ id: "ses_a" }))
    const { transport, calls } = signed(link)
    await transport.runtime(route, "/session/ses_a?view=open")
    expect(calls).toEqual([{ operation: "workspace.connection.read", input: { id: route.workspaceId, sessionId: "ses_a" } }])
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://relay.test/workspaces/${route.workspaceId}/session/ses_a?view=open`)
    const init = fetcher.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-rat")
    expect(init?.credentials).toBe("omit")
  }
})

test("signed desktop never spends one session's connection on another session or workspace stream", async () => {
  const { transport, calls } = signed(link, { ...link, runtimeAccessToken: "other-rat" }, { ...link, runtimeAccessToken: "workspace-rat" })
  fetcher.mockResolvedValue(Response.json({}))
  await transport.runtime(cloud, "/api/wr/events?sessionID=ses_a")
  await transport.runtime(cloud, "/session/ses_b")
  await transport.runtime(cloud, "/api/wr/health")
  expect(calls.map((call) => call.input)).toEqual([{ id: "ws_cloud", sessionId: "ses_a" }, { id: "ws_cloud", sessionId: "ses_b" }, { id: "ws_cloud" }])
  expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual(["Bearer session-rat", "Bearer other-rat", "Bearer workspace-rat"])
})

test("signed desktop stopped connection fails without daemon reads, relay reads or wake", async () => {
  const { transport, calls } = signed({ status: "stopped" })
  await expect(transport.runtime(cloud, "/api/wr/health")).rejects.toMatchObject({ code: "workspace_stopped" })
  expect(calls).toEqual([{ operation: "workspace.connection.read", input: { id: "ws_cloud" } }])
  expect(fetcher).not.toHaveBeenCalled()
})

test("signed desktop a revoked session connection fails closed", async () => {
  const { transport, calls } = signed(new Error('HOSTED_HTTP 403 {"body":{"error":{"code":"session_access_denied","message":"No share"}}}'))
  await expect(transport.runtime(cloud, "/session/ses_revoked")).rejects.toMatchObject({ class: "auth", code: "session_access_denied" })
  expect(calls).toHaveLength(1)
  expect(fetcher).not.toHaveBeenCalled()
})

test("signed desktop local placements keep using the daemon with no account call", async () => {
  const { transport, calls } = signed()
  fetcher.mockResolvedValue(Response.json({}))
  await transport.runtime({ kind: "folder", directory: "/repo", workspaceId: "ws_local", remote: false }, "/session/ses_local")
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4444/session/ses_local?directory=%2Frepo")
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull()
  expect(calls).toEqual([])
})

test("web session routing uses the same read-only session connection", async () => {
  const transport = createTransport({ serverUrl: "https://account.test", auth: { kind: "bearer", token: async () => "account-bearer" } })
  fetcher.mockResolvedValueOnce(Response.json(link)).mockResolvedValueOnce(Response.json({}))
  await transport.runtime(cloud, "/session/ses_a")
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://account.test/api/workspace/ws_cloud/connection?sessionId=ses_a")
  expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined()
  expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer session-rat")
})

test("renewing a rejected runtime token cannot wake compute", async () => {
  const { transport, calls } = signed(link, { ...link, runtimeAccessToken: "fresh-rat" })
  fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 })).mockResolvedValueOnce(Response.json({}))
  await transport.runtime(cloud, "/session/ses_a")
  expect(calls).toEqual(Array(2).fill({ operation: "workspace.connection.read", input: { id: "ws_cloud", sessionId: "ses_a" } }))
})

test("session question replies take the scope named by their sessionId query", async () => {
  const { transport, calls } = signed(link)
  fetcher.mockResolvedValue(Response.json({}))
  await transport.runtime(cloud, "/question/que_1/reply?sessionId=ses_a", { method: "POST", body: "{}" })
  expect(calls).toEqual([{ operation: "workspace.connection.read", input: { id: "ws_cloud", sessionId: "ses_a" } }])
})

test("relay connections evict the oldest session scope after 128 entries", async () => {
  const { transport, calls } = signed(...Array(130).fill(link))
  fetcher.mockImplementation(Object.assign(async () => Response.json({}), { preconnect: () => undefined }))
  for (let index = 0; index < 129; index++) await transport.runtime(cloud, `/session/ses_${index}`)
  await transport.runtime(cloud, "/session/ses_0")
  expect(calls).toHaveLength(130)
})

test("signed desktop placement streams deliver live relay frames with the attached session's token", async () => {
  const { transport, calls } = signed(link)
  const queryClient = new QueryClient()
  const ref = { placementId: placementId("ws_cloud"), projectId: projectId("prj"), sessionId: sessionId("ses_a") }
  const frame = { directory: "workspace:ws_cloud", payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } } }
  const frames: unknown[] = []
  fetcher.mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0]) => String(url).startsWith("https://relay.test/")
    ? new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify(frame)}\n\n`)) }), { headers: { "content-type": "text/event-stream" } })
    : Response.json({}), { preconnect: () => undefined }))
  const workspaces = { catalog: () => ({ placements: [{ route: cloud, placement: { id: ref.placementId, kind: "cloud", reachable: true } }] }) } as unknown as Workspaces
  const streams = createPlacementStreams({ transport, workspaces, queryClient, onFrame: (frame) => frames.push(frame), onGap: () => undefined })
  const detach = streams.attach(ref)
  try {
    for (let tick = 0; tick < 40; tick++) await Promise.resolve()
    expect(frames).toEqual([frame])
    expect(calls).toEqual([{ operation: "workspace.connection.read", input: { id: "ws_cloud", sessionId: "ses_a" } }])
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://relay.test/workspaces/ws_cloud/api/wr/events?sessionID=ses_a")
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer session-rat")
  } finally {
    detach()
    streams.close()
    queryClient.clear()
  }
})
