/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { placementId } from "./ids"
import { createPlacementStreams } from "./placement-streams"
import { home, openBody, placement, record, ref, settle, streamTransport, workspaces } from "./test-support/placement-streams"
import { queryKeys } from "./query-keys"
import type { Workspaces } from "./workspaces"

function stoppingWorkspaces(queryClient: QueryClient, serverUrl: string) {
  let reachable = true
  let refreshed = 0
  const refresh = Promise.withResolvers<void>()
  const workspaces = {
    streamRoute: () => reachable ? record.route : undefined,
    home,
    onSessionHostLearned: () => () => undefined,
    refresh: async () => {
      refreshed += 1
      reachable = false
      queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: refreshed })
      refresh.resolve()
    },
  } as unknown as Workspaces
  return { workspaces, refreshed: () => refreshed, refresh: refresh.promise }
}

test("a refused owned runtime rereads the catalog, and the stopped placement's stream stays closed without a start", async () => {
  const queryClient = new QueryClient()
  const serverUrl = "https://account.test"
  const catalog = stoppingWorkspaces(queryClient, serverUrl)
  let opened = 0
  const transport = streamTransport({ serverUrl, runtime: async () => {
    opened += 1
    return Response.json({ error: { code: "runtime_access_token_invalid" } }, { status: 401 })
  } })
  const streams = createPlacementStreams({ transport, workspaces: catalog.workspaces, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_idle"))
  try {
    await catalog.refresh
    await settle()
    expect(catalog.refreshed()).toBe(1)
    expect(opened).toBe(1)
    expect(streams.streams(ref("ses_idle"))).toBe(false)
  } finally { detach(); streams.close(); queryClient.clear() }
})

test("a dropped stream rereads the catalog before it reconnects, so a stopped sandbox is not reopened", async () => {
  const queryClient = new QueryClient()
  const serverUrl = "https://account.test"
  const catalog = stoppingWorkspaces(queryClient, serverUrl)
  let opened = 0
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  const transport = streamTransport({ serverUrl, runtime: async () => {
    opened += 1
    return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { body = controller } }), { headers: { "content-type": "text/event-stream" } })
  } })
  const streams = createPlacementStreams({ transport, workspaces: catalog.workspaces, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_idle"))
  try {
    await settle()
    body?.close()
    await catalog.refresh
    await settle()
    expect(catalog.refreshed()).toBe(1)
    expect(opened).toBe(1)
    expect(streams.streams(ref("ses_idle"))).toBe(false)
  } finally { detach(); streams.close(); queryClient.clear() }
})

test("a shared placement streams with session scope and a revoked share closes the stream", async () => {
  let listed = true
  let signal: AbortSignal | undefined
  const routes: unknown[] = []
  const queryClient = new QueryClient()
  const transport = streamTransport({ serverUrl: "https://account.test", runtime: async (route: unknown, _path: string, init: RequestInit) => {
    routes.push(route); signal = init.signal ?? undefined; return openBody()
  } })
  const scoped = { ...record.route, sharedSession: { sessionId: "ses_shared", level: "follow" } }
  const workspaces = { catalog: () => ({ placements: [] }), streamRoute: () => listed ? scoped : undefined, home, onSessionHostLearned: () => () => undefined } as unknown as Workspaces
  const streams = createPlacementStreams({ transport, workspaces, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_shared"))
  try {
    await settle()
    expect(routes).toEqual([scoped])
    listed = false
    queryClient.setQueryData(queryKeys.sharedSessions(transport.serverUrl), [])
    await settle()
    expect(signal?.aborted).toBe(true)
  } finally { detach(); streams.close() }
})

test("remote streams request only attached session scopes, and a revoked session stream stays closed", async () => {
  const paths: string[] = []
  const transport = streamTransport({
    serverUrl: "http://127.0.0.1:1",
    runtime: async (_route: unknown, path: string) => {
      paths.push(path)
      if (path === "/api/wr/events") return Response.json({ error: { code: "workspace_event_stream_denied" } }, { status: 403 })
      if (path === "/api/wr/events?sessionID=ses_revoked") return Response.json({ error: { code: "session_event_stream_denied" } }, { status: 403 })
      return openBody()
    },
  })
  const streams = createPlacementStreams({ transport, workspaces, queryClient: new QueryClient(), onFrame: () => undefined, onGap: () => undefined })

  const detachShared = streams.attach(ref("ses_shared"))
  await settle()
  const detachRevoked = streams.attach(ref("ses_revoked"))
  await settle()
  await Bun.sleep(1_200)
  await settle()

  expect(paths).toEqual(["/api/wr/events?sessionID=ses_shared", "/api/wr/events?sessionID=ses_revoked"])
  detachShared()
  detachRevoked()
  streams.close()
})

for (const catalog of ["bootstrap", "accountCatalog"] as const) test(`a ${catalog} update that wakes a placement opens its attached stream, and stopping closes it without waking`, async () => {
  let reachable = false
  let signal: AbortSignal | undefined
  const paths: string[] = []
  const serverUrl = "http://127.0.0.1:1"
  const queryClient = new QueryClient()
  const workspaces = { streamRoute: () => reachable ? record.route : undefined, home, onSessionHostLearned: () => () => undefined } as unknown as Workspaces
  const transport = streamTransport({ serverUrl, runtime: async (_route: unknown, path: string, init: RequestInit) => {
    paths.push(path)
    signal = init.signal ?? undefined
    return openBody()
  } })
  const streams = createPlacementStreams({ transport, workspaces, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_shared"))
  await settle()
  expect(paths).toEqual([])
  reachable = true
  queryClient.setQueryData(queryKeys[catalog](serverUrl), { revision: 1 })
  await settle()
  expect(paths).toEqual(["/api/wr/events?sessionID=ses_shared"])
  reachable = false
  queryClient.setQueryData(queryKeys[catalog](serverUrl), { revision: 2 })
  await settle()
  expect(signal?.aborted).toBe(true)
  expect(paths).toHaveLength(1)
  detach()
  streams.close()
  queryClient.clear()
})

test("a placement stream's frames name that placement's workspace, whatever directory the runtime reports", async () => {
  const frame = { directory: "/sandbox/workspaces/claxedo-ws_shared", payload: { type: "runtime-frame", properties: { sessionID: "ses_shared" } } }
  const transport = streamTransport({
    serverUrl: "http://127.0.0.1:1",
    runtime: async () => new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify(frame)}\n\n`)) }), { headers: { "content-type": "text/event-stream" } }),
  })
  const frames: unknown[] = []
  const streams = createPlacementStreams({ transport, workspaces, queryClient: new QueryClient(), onFrame: (received) => frames.push(received), onGap: () => undefined })
  const detach = streams.attach(ref("ses_shared"))
  await settle()
  expect(frames).toEqual([{ ...frame, workspaceId: "ws_shared" }])
  detach()
  streams.close()
})

test("a watched remote placement streams its terminals once, with no session's frames, until the last watcher leaves or it stops", async () => {
  const queryClient = new QueryClient()
  const serverUrl = "https://account.test"
  let reachable = true
  const opened: Array<{ route: unknown; path: string; signal: AbortSignal | undefined }> = []
  const transport = streamTransport({ serverUrl, runtime: async (route: unknown, path: string, init: RequestInit) => {
    opened.push({ route, path, signal: init.signal ?? undefined })
    return openBody()
  } })
  const watching = { ...workspaces, workspaceStreamRoute: (id: string) => id === placement && reachable ? record.route : undefined } as unknown as Workspaces
  const streams = createPlacementStreams({ transport, workspaces: watching, queryClient, onFrame: () => undefined, onGap: () => undefined })
  try {
    const first = streams.watch(placement)
    const second = streams.watch(placement)
    const local = streams.watch(placementId("ws_local"))
    await settle()
    expect(opened.map(({ route, path }) => ({ route, path }))).toEqual([{ route: record.route, path: "/api/wr/events?sessions=none" }])
    first()
    await settle()
    expect(opened[0]?.signal?.aborted).toBe(false)
    reachable = false
    queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: 1 })
    await settle()
    expect(opened[0]?.signal?.aborted).toBe(true)
    reachable = true
    queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: 2 })
    await settle()
    expect(opened).toHaveLength(2)
    second()
    local()
    await settle()
    expect(opened[1]?.signal?.aborted).toBe(true)
  } finally { streams.close(); queryClient.clear() }
})

test("a stream to a runtime that is not running stays closed across catalog reads until the placement's row changes, then reopens", async () => {
  const queryClient = new QueryClient()
  const serverUrl = "https://account.test"
  let row = { ...record.placement, revision: 1 }
  let refreshed = 0
  let running = false
  let opened = 0
  const catalog = {
    streamRoute: () => record.route,
    byId: () => row,
    home,
    onSessionHostLearned: () => () => undefined,
    refresh: async () => {
      refreshed += 1
      queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: refreshed })
    },
  } as unknown as Workspaces
  const transport = streamTransport({ serverUrl, runtime: async () => {
    opened += 1
    return running ? openBody() : Response.json({ error: { code: "workspace_stopped", message: "The cloud workspace ws_shared is not running" } }, { status: 409 })
  } })
  const streams = createPlacementStreams({ transport, workspaces: catalog, queryClient, onFrame: () => undefined, onGap: () => undefined })
  const detach = streams.attach(ref("ses_asleep"))
  try {
    await settle()
    expect(opened).toBe(1)
    expect(refreshed).toBe(1)
    queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: "unrelated" })
    await settle()
    expect(opened).toBe(1)
    running = true
    row = { ...row, revision: 2 }
    queryClient.setQueryData(queryKeys.bootstrap(serverUrl), { revision: "woke" })
    await settle()
    expect(opened).toBe(2)
    expect(streams.streams(ref("ses_asleep"))).toBe(true)
  } finally { detach(); streams.close(); queryClient.clear() }
})
