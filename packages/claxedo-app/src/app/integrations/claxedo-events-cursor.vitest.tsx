import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import { resetSessionEventScope, setSessionEventLiveWorkspace } from "@/platform/runtime/session-event-scope"
import { resetSessionHistoryResyncForTest, sessionHistoryResyncRequest } from "@/features/session/store/session-history-resync"
import { HEARTBEAT_TIMEOUT_MS, RECONNECT_DELAY_MS } from "../providers/claxedo-events-reconnect"

const transport = vi.hoisted(() => ({ request: vi.fn<typeof fetch>() }))

vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/api/api")>(),
  authFetch: transport.request,
}))

vi.mock("@/platform/sync/local-event-websocket", () => ({ openLocalEventWebSocket: transport.request }))

import { ClaxedoEventsProvider, useClaxedoEvents } from "./claxedo-events"

function ConnectionState() {
  const events = useClaxedoEvents()
  return <output>{events.centralConnected() ? "connected" : "disconnected"}</output>
}

function mount() {
  return render(() => (
    <ClaxedoEventsProvider
      pathname={() => "/"}
      serverUrl={() => "http://127.0.0.1:3001"}
      accountState={() => ({ status: "unsigned" })}
    >
      <ConnectionState />
    </ClaxedoEventsProvider>
  ))
}

function openStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (next) => { controller = next } })
  signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true })
  return { response: new Response(body), close: () => controller.close(), send: (data: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0)
  vi.spyOn(console, "debug").mockImplementation(() => {})
  transport.request.mockReset()
  queryClient.clear()
  resetSessionEventScope()
  resetSessionHistoryResyncForTest()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  resetSessionEventScope()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("ClaxedoEventsProvider reconnects", () => {
  test("central SDK consumers share one connection and can unsubscribe independently", async () => {
    const stream = openStream()
    const shared: unknown[] = []
    const typed: unknown[] = []
    let unsubscribe!: () => void
    transport.request.mockResolvedValue(stream.response)
    function Consumer() {
      const events = useClaxedoEvents()
      unsubscribe = events.listen((event) => shared.push(event))
      events.on("session.updated", (event) => typed.push(event))
      return null
    }
    render(() => <ClaxedoEventsProvider pathname={() => "/"} serverUrl={() => "http://127.0.0.1:3001"} accountState={() => ({ status: "unsigned" })}><Consumer /></ClaxedoEventsProvider>)
    await vi.advanceTimersByTimeAsync(0)
    const payload = { id: "event-1", type: "session.updated", properties: { info: { id: "session-1" } } }
    stream.send({ directory: "/repo", payload })
    await vi.advanceTimersByTimeAsync(0)
    expect(shared).toEqual([{ ...payload, directory: "/repo" }])
    expect(typed).toEqual(shared)
    expect(transport.request).toHaveBeenCalledTimes(1)
    unsubscribe()
    stream.send({ directory: "/repo", payload: { ...payload, id: "event-2" } })
    await vi.advanceTimersByTimeAsync(0)
    expect(shared).toHaveLength(1)
    expect(typed).toHaveLength(2)
    stream.close()
  })

  test("resumes from the last cursor and stops reconnecting after unmount", async () => {
    transport.request.mockImplementation(async () => new Response('id: 7\ndata: {"type":"heartbeat"}\n\n'))
    const { unmount } = mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(new Headers(transport.request.mock.calls[0]?.[1]?.headers).get("Last-Event-ID")).toBeNull()

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1)
    expect(transport.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.request).toHaveBeenCalledTimes(2)
    expect(new Headers(transport.request.mock.calls[1]?.[1]?.headers).get("Last-Event-ID")).toBe("7")

    unmount()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS)
    expect(transport.request).toHaveBeenCalledTimes(2)
  })

  test("heartbeat expiry aborts the open stream and reconnects only after the retry delay", async () => {
    transport.request.mockImplementation(async (_input, init) => openStream(init?.signal).response)
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByText("connected")).toBeInTheDocument()
    const firstSignal = transport.request.mock.calls[0]?.[1]?.signal

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS)
    expect(firstSignal?.aborted).toBe(true)
    expect(screen.getByText("disconnected")).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1)
    expect(transport.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.request).toHaveBeenCalledTimes(2)
    expect(screen.getByText("connected")).toBeInTheDocument()
  })

  test("backs off and escalates once per sustained failure run, resetting after a successful open", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    transport.request.mockImplementation(async () => new Response("offline", { status: 503 }))
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.request).toHaveBeenCalledTimes(1)

    // Jitter pinned to the bottom of each window: 250, then 250, 500, 1000.
    for (const delay of [250, 250, 500, 1_000]) {
      const attempts = transport.request.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(transport.request).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(transport.request).toHaveBeenCalledTimes(attempts + 1)
    }
    expect(errors).toHaveBeenCalledTimes(1)

    const recovered = openStream()
    transport.request.mockResolvedValueOnce(recovered.response)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(screen.getByText("connected")).toBeInTheDocument()
    recovered.close()
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [250, 250, 500]) await vi.advanceTimersByTimeAsync(delay)
    expect(errors).toHaveBeenCalledTimes(2)
  })
})

describe("the workspace stream's two arms", () => {
  const workspaceRequests = () =>
    transport.request.mock.calls
      .map(([input, init]) => ({ url: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url), init }))
      .filter(({ url }) => url.pathname.endsWith("/api/wr/events"))
  const quiet = () => new Response('id: 3\ndata: {"type":"heartbeat"}\n\n')

  function mountRoute(pathname: () => string) {
    return render(() => (
      <ClaxedoEventsProvider pathname={pathname} serverUrl={() => "http://127.0.0.1:3001"} accountState={() => ({ status: "unsigned" })}>
        <ConnectionState />
      </ClaxedoEventsProvider>
    ))
  }

  const refusedAtWorkspaceLevel = () => Response.json(
    { error: { code: "workspace_event_stream_denied", message: "denied", cause: "host_authority_denied" } },
    { status: 403 },
  )

  test("opens unscoped; a runtime that refuses the workspace is asked again for the routed session", async () => {
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!url.pathname.endsWith("/api/wr/events")) return quiet()
      return url.searchParams.has("sessionID") ? quiet() : refusedAtWorkspaceLevel()
    })
    mountRoute(() => "/w/ws_shared/session/ses_shared")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const opens = workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))
    expect(opens).toEqual([null, "ses_shared"])
  })

  test("a 403 minted elsewhere on the path is retried unscoped, not narrowed to the session", async () => {
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!url.pathname.endsWith("/api/wr/events")) return quiet()
      return Response.json({ error: { code: "relay_target_unavailable", message: "host away" } }, { status: 403 })
    })
    mountRoute(() => "/w/ws_shared/session/ses_shared")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 4)
    const opens = workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))
    expect(opens.length).toBeGreaterThan(1)
    expect(opens.every((scope) => scope === null)).toBe(true)
  })

  test("a workspace-wide stream keeps its connection and cursor across a session navigation", async () => {
    transport.request.mockImplementation(async () => quiet())
    const [pathname, setPathname] = createSignal("/w/ws_owned/session/ses_a")
    mountRoute(pathname)
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests()).toHaveLength(1)
    setPathname("/w/ws_owned/session/ses_b")
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS)
    const second = workspaceRequests()[1]
    expect(second?.url.searchParams.get("sessionID")).toBeNull()
    expect(new Headers(second?.init?.headers).get("Last-Event-ID")).toBe("3")
  })

  test("a navigation to the bare session route of the same workspace keeps the stream", async () => {
    transport.request.mockImplementation(async () => quiet())
    const [pathname, setPathname] = createSignal("/w/ws_owned/session/ses_a")
    mountRoute(pathname)
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests()).toHaveLength(1)
    setSessionEventLiveWorkspace("ses_b", "workspace:ws_owned")
    setPathname("/s/ses_b")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests()).toHaveLength(1)
  })

  test("a session-scoped stream is reopened, cursor-less, for the session a navigation names", async () => {
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!url.pathname.endsWith("/api/wr/events")) return quiet()
      return url.searchParams.has("sessionID") ? quiet() : refusedAtWorkspaceLevel()
    })
    const [pathname, setPathname] = createSignal("/w/ws_shared/session/ses_a")
    mountRoute(pathname)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))).toEqual([null, "ses_a"])
    setPathname("/w/ws_shared/session/ses_b")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const opens = workspaceRequests()
    expect(opens.map(({ url }) => url.searchParams.get("sessionID"))).toEqual([null, "ses_a", null, "ses_b"])
    expect(new Headers(opens.at(-1)?.init?.headers).get("Last-Event-ID")).toBeNull()
  })
})

describe("what a stream's open and its gap ask the store to re-read", () => {
  const gap = () => new Response('data: {"type":"stream.replay-gap","code":"x","message":"","severity":"warn"}\n\n')

  function mountRoute(pathname: () => string) {
    return render(() => (
      <ClaxedoEventsProvider pathname={pathname} serverUrl={() => "http://127.0.0.1:3001"} accountState={() => ({ status: "unsigned" })}>
        <ConnectionState />
      </ClaxedoEventsProvider>
    ))
  }

  test("a cursor-less workspace stream open asks that workspace's controllers to re-read; a resumed open does not", async () => {
    transport.request.mockImplementation(async () => new Response('id: 3\ndata: {"type":"heartbeat"}\n\n'))
    mountRoute(() => "/w/ws_owned/session/ses_a")
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionHistoryResyncRequest()).toMatchObject({ reason: "stream-open", directory: "workspace:ws_owned" })
    const first = sessionHistoryResyncRequest()?.sequence
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionHistoryResyncRequest()?.sequence).toBe(first)
  })

  test("a workspace stream's gap re-reads that workspace; the control plane's gap re-reads no session", async () => {
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      return url.pathname.endsWith("/api/wr/events") ? gap() : gap()
    })
    const gaps: unknown[] = []
    function Consumer() {
      const events = useClaxedoEvents()
      events.listen((event) => { if (event.type === "stream.replay-gap") gaps.push(event) })
      return null
    }
    render(() => <ClaxedoEventsProvider pathname={() => "/w/ws_owned/session/ses_a"} serverUrl={() => "http://127.0.0.1:3001"} accountState={() => ({ status: "unsigned" })}><Consumer /></ClaxedoEventsProvider>)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(gaps).toEqual(expect.arrayContaining([
      { type: "stream.replay-gap", stream: "cp" },
      { type: "stream.replay-gap", stream: "wr", workspaceId: "ws_owned", directory: "workspace:ws_owned" },
    ]))
    expect(sessionHistoryResyncRequest()).toMatchObject({ reason: "sse-gap", directory: "workspace:ws_owned" })
  })
})
