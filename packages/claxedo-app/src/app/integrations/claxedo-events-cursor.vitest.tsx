import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { setHostAggregateDeclaration } from "@/platform/query/control-plane"
import { streamSyncLifecycleSnapshot } from "@/platform/runtime/stream-sync-status"
import {
  resetSessionEventScope,
  sessionEventStreamsOpen,
  setSessionEventLiveWorkspace,
} from "@/platform/runtime/session-event-scope"
import {
  __workspaceConnectionInternals as connections,
  workspaceConnection,
} from "@/features/workspaces/data/workspace-connection"
import { resetSessionHistoryResyncForTest, sessionHistoryResyncRequest } from "@/features/session/store/session-history-resync"
import { legacyDirectoryRouteKey } from "@/platform/identity/route"
import { HEARTBEAT_TIMEOUT_MS, MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS } from "../providers/claxedo-events-reconnect"

const SERVER_URL = "http://127.0.0.1:3001"

const transport = vi.hoisted(() => ({ request: vi.fn<typeof fetch>() }))

vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/api/api")>(),
  authFetch: transport.request,
}))

vi.mock("@/platform/sync/local-event-websocket", () => ({ openLocalEventWebSocket: transport.request }))

const account = vi.hoisted(() => ({
  available: false,
  open: vi.fn<(input: { operation: string; params?: Record<string, unknown>; signal?: AbortSignal }) => Promise<Response>>(),
}))

vi.mock("@/platform/account/account-stream-fetch", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/account/account-stream-fetch")>(),
  accountStreamAvailable: () => account.available,
  openAccountStreamResponse: account.open,
}))

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

const requestUrl = (input: RequestInfo | URL) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)

/** The daemon's own `/api/wr/events` is the host aggregate; a workspace's is its runtime's, under the workspace path. */
const isHostAggregate = (url: URL) => url.pathname === "/api/wr/events"
const isWorkspaceStream = (url: URL) => url.pathname.endsWith("/api/wr/events") && !isHostAggregate(url)

/** A request that never settles: the target opens once and then neither fails, retries nor reports. */
const pending = () => new Promise<Response>(() => {})

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
  // Every case here mounts against a loopback daemon, and the aggregate exists
  // only where that daemon says so — the boot's answer, which `clear()` drops.
  setHostAggregateDeclaration(SERVER_URL, true)
  resetSessionEventScope()
  resetSessionHistoryResyncForTest()
  account.available = false
  account.open.mockReset()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  resetSessionEventScope()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("ClaxedoEventsProvider reconnects", () => {
  // A loopback surface also opens the host aggregate. These tests measure the
  // control plane's stream, so the aggregate's request is left unsettled: one
  // call, no failures of its own, no retry timers racing the ones under test.
  const cpCalls = () => transport.request.mock.calls.filter(([input]) => !isHostAggregate(requestUrl(input)))
  const controlPlaneOnly = (respond: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) =>
    (input: RequestInfo | URL, init?: RequestInit) => isHostAggregate(requestUrl(input)) ? pending() : respond(input, init)

  test("central SDK consumers share one connection and can unsubscribe independently", async () => {
    const stream = openStream()
    const shared: unknown[] = []
    const typed: unknown[] = []
    let unsubscribe!: () => void
    transport.request.mockImplementation(controlPlaneOnly(() => stream.response))
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
    expect(cpCalls()).toHaveLength(1)
    unsubscribe()
    stream.send({ directory: "/repo", payload: { ...payload, id: "event-2" } })
    await vi.advanceTimersByTimeAsync(0)
    expect(shared).toHaveLength(1)
    expect(typed).toHaveLength(2)
    stream.close()
  })

  test("resumes from the last cursor and stops reconnecting after unmount", async () => {
    transport.request.mockImplementation(controlPlaneOnly(() => new Response('id: 7\ndata: {"type":"heartbeat"}\n\n')))
    const { unmount } = mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(cpCalls()).toHaveLength(1)
    expect(new Headers(cpCalls()[0]?.[1]?.headers).get("Last-Event-ID")).toBeNull()

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1)
    expect(cpCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cpCalls()).toHaveLength(2)
    expect(new Headers(cpCalls()[1]?.[1]?.headers).get("Last-Event-ID")).toBe("7")

    unmount()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS)
    expect(cpCalls()).toHaveLength(2)
  })

  test("heartbeat expiry aborts the open stream and reconnects only after the retry delay", async () => {
    transport.request.mockImplementation(controlPlaneOnly((_input, init) => openStream(init?.signal).response))
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByText("connected")).toBeInTheDocument()
    const firstSignal = cpCalls()[0]?.[1]?.signal

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS)
    expect(firstSignal?.aborted).toBe(true)
    expect(screen.getByText("disconnected")).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1)
    expect(cpCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cpCalls()).toHaveLength(2)
    expect(screen.getByText("connected")).toBeInTheDocument()
  })

  test("backs off and escalates once per sustained failure run, resetting after a successful open", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    transport.request.mockImplementation(controlPlaneOnly(() => new Response("offline", { status: 503 })))
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(cpCalls()).toHaveLength(1)

    // Jitter pinned to the bottom of each window: 250, then 250, 500, 1000.
    for (const delay of [250, 250, 500, 1_000]) {
      const attempts = cpCalls().length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(cpCalls()).toHaveLength(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(cpCalls()).toHaveLength(attempts + 1)
    }
    expect(errors).toHaveBeenCalledTimes(1)

    const recovered = openStream()
    let recoveries = 0
    transport.request.mockImplementation(controlPlaneOnly(() =>
      (recoveries += 1) === 1 ? recovered.response : new Response("offline", { status: 503 })))
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
      .filter(({ url }) => isWorkspaceStream(url))
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
      if (!isWorkspaceStream(url)) return quiet()
      return url.searchParams.has("sessionID") ? quiet() : refusedAtWorkspaceLevel()
    })
    mountRoute(() => "/w/ws_shared/session/ses_shared")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const opens = workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))
    expect(opens).toEqual([null, "ses_shared"])
  })

  test("narrowing to the session drops the workspace ring's cursor: the session's ring is another numbering", async () => {
    let unscopedOpens = 0
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!isWorkspaceStream(url)) return quiet()
      if (url.searchParams.has("sessionID")) return quiet()
      // The first unscoped open is admitted and issues a cursor, then ends;
      // the reopen is refused: the reader's workspace access went away while
      // its session share stayed.
      unscopedOpens += 1
      return unscopedOpens === 1 ? new Response('id: 42\ndata: {"type":"heartbeat"}\n\n') : refusedAtWorkspaceLevel()
    })
    mountRoute(() => "/w/ws_shared/session/ses_shared")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const opens = workspaceRequests().map(({ url, init }) => [url.searchParams.get("sessionID"), new Headers(init?.headers).get("Last-Event-ID")])
    expect(opens).toEqual([[null, null], [null, "42"], ["ses_shared", null]])
  })

  test("refused on a route that names no session, the target waits for one instead of retrying as an outage", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!isWorkspaceStream(url)) return quiet()
      return url.searchParams.has("sessionID") ? quiet() : refusedAtWorkspaceLevel()
    })
    const [pathname, setPathname] = createSignal("/w/ws_shared/session")
    mountRoute(pathname)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS * 2)
    expect(workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))).toEqual([null])
    expect(errors).not.toHaveBeenCalled()
    // A session named later reopens at once, session-scoped.
    setPathname("/w/ws_shared/session/ses_shared")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))).toEqual([null, "ses_shared"])
  })

  test("a session the runtime itself refuses is parked, not retried as an outage; another session named reopens", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const refusedSession = () => Response.json({ error: { code: "session_event_stream_denied", message: "revoked", cause: "session_private" } }, { status: 403 })
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!isWorkspaceStream(url)) return quiet()
      const session = url.searchParams.get("sessionID")
      if (!session) return refusedAtWorkspaceLevel()
      return session === "ses_revoked" ? refusedSession() : quiet()
    })
    const [pathname, setPathname] = createSignal("/w/ws_shared/session/ses_revoked")
    mountRoute(pathname)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS * 2)
    expect(workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))).toEqual([null, "ses_revoked"])
    expect(errors).not.toHaveBeenCalled()
    setPathname("/w/ws_shared/session/ses_other")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))).toEqual([null, "ses_revoked", "ses_other"])
  })

  test("a parked session reopens on its re-grant notice, and on a navigation that names it afresh", async () => {
    let granted = false
    const refusedSession = () => Response.json({ error: { code: "session_event_stream_denied", message: "revoked", cause: "session_private" } }, { status: 403 })
    const notice = { type: "session.share.changed", phase: "granted", ownerUserId: "u", sessionId: "ses_a", workspaceId: "ws_shared", ts: 1 }
    let cp: ReturnType<typeof openStream> | undefined
    transport.request.mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname.endsWith("/api/cp/events")) {
        cp = openStream(init?.signal)
        return cp.response
      }
      if (!isWorkspaceStream(url)) return quiet()
      const session = url.searchParams.get("sessionID")
      if (!session) return refusedAtWorkspaceLevel()
      return granted ? quiet() : refusedSession()
    })
    const [pathname, setPathname] = createSignal("/w/ws_shared/session/ses_a")
    mountRoute(pathname)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const opens = () => workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))
    expect(opens()).toEqual([null, "ses_a"])
    // Re-granted while the reader sits on the session: the notice reopens it.
    granted = true
    cp?.send(notice)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(opens()).toEqual([null, "ses_a", "ses_a"])

    // Refused again, the notice missed: leaving and coming back is one more
    // open — a navigation, not a retry loop.
    granted = false
    setPathname("/w/ws_shared/session/ses_b")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    setPathname("/w/ws_shared/session/ses_a")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS * 2)
    expect(opens().filter((session) => session === "ses_a")).toHaveLength(3)
  })

  test("a re-grant that lands while the session-scoped attempt is in flight outranks that attempt's refusal", async () => {
    const refusedSession = () => Response.json({ error: { code: "session_event_stream_denied", message: "revoked", cause: "session_private" } }, { status: 403 })
    const notice = { type: "session.share.changed", phase: "granted", ownerUserId: "u", sessionId: "ses_a", workspaceId: "ws_shared", ts: 1 }
    let cp: ReturnType<typeof openStream> | undefined
    let releaseFirst: (() => void) | undefined
    const held = new Promise<void>((resolve) => { releaseFirst = resolve })
    let scopedOpens = 0
    transport.request.mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname.endsWith("/api/cp/events")) {
        cp = openStream(init?.signal)
        return cp.response
      }
      if (!isWorkspaceStream(url)) return quiet()
      if (!url.searchParams.has("sessionID")) return refusedAtWorkspaceLevel()
      scopedOpens += 1
      if (scopedOpens > 1) return quiet()
      // The first scoped attempt is answered only after the grant notice landed.
      await held
      return refusedSession()
    })
    mountRoute(() => "/w/ws_shared/session/ses_a")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(scopedOpens).toBe(1)
    cp?.send(notice)
    await vi.advanceTimersByTimeAsync(0)
    releaseFirst?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))).toEqual([null, "ses_a", "ses_a"])
  })

  test("a hole in the control plane's stream asks the runtime once more for a parked session", async () => {
    let granted = false
    const refusedSession = () => Response.json({ error: { code: "session_event_stream_denied", message: "revoked", cause: "session_private" } }, { status: 403 })
    let cp: ReturnType<typeof openStream> | undefined
    transport.request.mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname.endsWith("/api/cp/events")) {
        cp = openStream(init?.signal)
        return cp.response
      }
      if (!isWorkspaceStream(url)) return quiet()
      if (!url.searchParams.has("sessionID")) return refusedAtWorkspaceLevel()
      return granted ? quiet() : refusedSession()
    })
    mountRoute(() => "/w/ws_shared/session/ses_a")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const opens = () => workspaceRequests().map(({ url }) => url.searchParams.get("sessionID"))
    expect(opens()).toEqual([null, "ses_a"])
    // The grant notice fell into the hole; the gap frame is what the reader has.
    granted = true
    cp?.send({ type: "stream.replay-gap", code: "cp.sse_replay_gap", message: "", severity: "warn" })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(opens()).toEqual([null, "ses_a", "ses_a"])
  })

  test("a 403 minted elsewhere on the path is retried unscoped, not narrowed to the session", async () => {
    transport.request.mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (!isWorkspaceStream(url)) return quiet()
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
      if (!isWorkspaceStream(url)) return quiet()
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
    transport.request.mockImplementation((input) =>
      isHostAggregate(requestUrl(input)) ? pending() : Promise.resolve(new Response('id: 3\ndata: {"type":"heartbeat"}\n\n')))
    mountRoute(() => "/w/ws_owned/session/ses_a")
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionHistoryResyncRequest()).toMatchObject({ reason: "stream-open", directory: "workspace:ws_owned" })
    const first = sessionHistoryResyncRequest()?.sequence
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionHistoryResyncRequest()?.sequence).toBe(first)
  })

  test("a workspace stream's gap re-reads that workspace; the control plane's gap re-reads no session", async () => {
    transport.request.mockImplementation((input) => isHostAggregate(requestUrl(input)) ? pending() : Promise.resolve(gap()))
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
      { type: "stream.replay-gap", stream: "cp", transport: "server" },
      { type: "stream.replay-gap", stream: "wr", workspaceId: "ws_owned", directory: "workspace:ws_owned" },
    ]))
    expect(sessionHistoryResyncRequest()).toMatchObject({ reason: "sse-gap", directory: "workspace:ws_owned" })
  })
})

describe("the host aggregate the desktop opens for every local runtime", () => {
  const serverUrl = "http://127.0.0.1:3001"
  const catalog = [{
    id: "prj_local",
    worktree: "/repo/one",
    workspaces: {
      "/repo/one": { workspaceId: "ws_one", kind: "local", directory: "/repo/one" },
      "/repo/two": { workspaceId: "ws_two", kind: "local", directory: "/repo/two" },
      "/repo/cloud": { workspaceId: "ws_cloud", kind: "cloud", directory: "/repo/cloud" },
    },
  }]
  const live = () => openStream().response
  const refused = () => Response.json(
    { error: { code: "workspace_event_stream_denied", message: "denied", cause: "host_authority_denied" } },
    { status: 403 },
  )
  const hostRequests = () => transport.request.mock.calls.filter(([input]) => isHostAggregate(requestUrl(input)))

  function mountHost() {
    return render(() => (
      <ClaxedoEventsProvider pathname={() => "/"} serverUrl={() => serverUrl} accountState={() => ({ status: "unsigned" })}>
        <ConnectionState />
      </ClaxedoEventsProvider>
    ))
  }

  afterEach(() => connections.reset())

  test("registers one lane and reports it open for a session of any local workspace", async () => {
    let reachable = false
    transport.request.mockImplementation(async (input) => {
      if (!isHostAggregate(requestUrl(input))) return live()
      return reachable ? live() : new Response("offline", { status: 503 })
    })
    mountHost()
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionEventStreamsOpen("ses_in_one")).toBe(false)

    reachable = true
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionEventStreamsOpen("ses_in_one")).toBe(true)
    expect(sessionEventStreamsOpen("ses_in_two")).toBe(true)
    // It opened with no cursor, so every mounted workspace re-reads: naming
    // one directory would leave the others behind the hole.
    expect(sessionHistoryResyncRequest()).toMatchObject({ reason: "stream-open" })
    expect(sessionHistoryResyncRequest()?.directory).toBeUndefined()
  })

  test("a hole in it re-reads every mounted workspace and names none", async () => {
    transport.request.mockImplementation(async (input) => isHostAggregate(requestUrl(input))
      ? new Response('data: {"type":"stream.replay-gap","code":"runtime.sse_replay_gap","message":"","severity":"warn"}\n\n')
      : live())
    const gaps: Array<{ stream: string }> = []
    function Consumer() {
      const events = useClaxedoEvents()
      events.listen((event) => { if (event.type === "stream.replay-gap") gaps.push(event) })
      return null
    }
    render(() => (
      <ClaxedoEventsProvider pathname={() => "/"} serverUrl={() => serverUrl} accountState={() => ({ status: "unsigned" })}>
        <Consumer />
      </ClaxedoEventsProvider>
    ))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    // Strictly: a `workspaceId` key present but undefined addresses the gap at
    // a workspace all the same, and `toEqual` would not see it.
    expect(gaps.filter((event) => event.stream === "wr")).toStrictEqual([{ type: "stream.replay-gap", stream: "wr" }])
    expect(sessionHistoryResyncRequest()).toMatchObject({ reason: "sse-gap" })
    expect(sessionHistoryResyncRequest()?.directory).toBeUndefined()
  })

  test("the workspace whose own stream it is keeps the authority bridge; the aggregate holds none", async () => {
    queryClient.setQueryData(queryKeys.controlPlane.projects(serverUrl), catalog)
    // What a completed mint leaves behind: the state `markWorkspaceReconnecting`
    // requires, and the only one a relay-backed workspace's gate ever reaches.
    connections.setState("ws_cloud", {
      workspaceId: "ws_cloud",
      kind: "provisioner",
      status: "ready",
      logs: [],
      terminal: false,
      refs: 1,
      rolePlacement: { state: "role-known", workspaceId: "ws_cloud", role: "owner" },
    })
    vi.spyOn(console, "error").mockImplementation(() => {})

    let reachable = false
    transport.request.mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (!isWorkspaceStream(url)) return live()
      return reachable ? live() : new Response("offline", { status: 503 })
    })
    render(() => (
      <ClaxedoEventsProvider pathname={() => "/w/ws_cloud"} serverUrl={() => serverUrl} accountState={() => ({ status: "unsigned" })}>
        <ConnectionState />
      </ClaxedoEventsProvider>
    ))
    // The first failures are the tunnel settling; the authority only parks
    // queries once the run is sustained.
    for (const delay of [0, 250, 250, 500, 1_000]) await vi.advanceTimersByTimeAsync(delay)
    expect(workspaceConnection("ws_cloud")?.status).toBe("reconnecting")

    reachable = true
    await vi.advanceTimersByTimeAsync(4_000)
    expect(workspaceConnection("ws_cloud")?.status).toBe("ready")
  })

  test("a refusal on it is an outage to retry, never a park: loopback has no session arm", async () => {
    transport.request.mockImplementation(async (input) => isHostAggregate(requestUrl(input)) ? refused() : live())
    mountHost()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(hostRequests()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 4)
    expect(hostRequests().length).toBeGreaterThan(2)
    // A parked target clears its lifecycle and waits for a route it will
    // never get here; a retrying one keeps reporting.
    expect(streamSyncLifecycleSnapshot("wr:host")).toBeDefined()
  })
})

describe("the stream a route is owed while its catalog entry resolves", () => {
  const serverUrl = SERVER_URL
  // A desktop local project routes by its sidecar UUID, which names nothing
  // until the catalog places it — unlike a filesystem path, which the daemon
  // serves from this machine whatever the catalog knows.
  const directory = "6f1c9a52-3b47-4d18-9c2a-7e5b0d3f8a11"
  const pathname = () => `/${legacyDirectoryRouteKey(directory)}`
  const live = () => openStream().response

  const mountAt = (route = pathname) => render(() => (
    <ClaxedoEventsProvider pathname={route} serverUrl={() => serverUrl} accountState={() => ({ status: "unsigned" })}>
      <ConnectionState />
    </ClaxedoEventsProvider>
  ))

  const placed = (kind: "local" | "cloud") => [{
    id: "prj",
    worktree: directory,
    workspaces: { [directory]: { workspaceId: "ws_pending", kind, directory } },
  }]

  test("the aggregate does not answer it: a route the catalog has not placed still waits", async () => {
    transport.request.mockImplementation(async () => live())
    mountAt()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    // The aggregate is open and workspace-wide, so every lane that exists is
    // satisfied — and the route's own stream is still missing.
    expect(sessionEventStreamsOpen("ses_first")).toBe(false)

    queryClient.setQueryData(queryKeys.controlPlane.projects(serverUrl), placed("cloud"))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionEventStreamsOpen("ses_first")).toBe(true)
  })

  test("a workspace the catalog places as local is owed nothing: the aggregate already carries it", async () => {
    transport.request.mockImplementation(async () => live())
    queryClient.setQueryData(queryKeys.controlPlane.projects(serverUrl), placed("local"))
    mountAt()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.request.mock.calls.filter(([input]) => isWorkspaceStream(requestUrl(input)))).toHaveLength(0)
    expect(sessionEventStreamsOpen("ses_first")).toBe(true)
  })

  test("a filesystem path the catalog has not placed opens no second stream and waits for nothing", async () => {
    // What a real daemon answers before its workspace store has registered the
    // worktree: a project with a worktree and no `workspaces` map. A second,
    // directory-scoped connection here is the aggregate's own frames again —
    // `session.idle` twice, and the completion sound with it.
    const worktree = "/private/var/folders/claxedo-tier-real"
    transport.request.mockImplementation(async () => live())
    queryClient.setQueryData(queryKeys.controlPlane.projects(serverUrl), [{ id: "engine-hash", worktree }])
    mountAt(() => `/${legacyDirectoryRouteKey(worktree)}`)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.request.mock.calls.filter(([input]) => isWorkspaceStream(requestUrl(input)))).toHaveLength(0)
    expect(sessionEventStreamsOpen("ses_first")).toBe(true)
  })

  test("nothing opens until the server says whether it serves the aggregate", async () => {
    transport.request.mockImplementation(async () => live())
    queryClient.removeQueries({ queryKey: queryKeys.deployment.hostAggregateDeclaration(serverUrl) })
    queryClient.setQueryData(queryKeys.controlPlane.projects(serverUrl), placed("cloud"))
    mountAt()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.request.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/api/wr/events"))).toHaveLength(0)
    expect(sessionEventStreamsOpen("ses_first")).toBe(false)

    setHostAggregateDeclaration(serverUrl, true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.request.mock.calls.filter(([input]) => isHostAggregate(requestUrl(input)))).toHaveLength(1)
    expect(sessionEventStreamsOpen("ses_first")).toBe(true)
  })
})

describe("a signed desktop's two control planes", () => {
  test("reads the daemon's cp/events over loopback and the hosted control plane's through the account bridge, and closes the bridge stream on sign-out", async () => {
    const daemon = openStream()
    transport.request.mockImplementation((input) => isHostAggregate(requestUrl(input)) ? pending() : Promise.resolve(daemon.response))
    account.available = true
    // The bridge ends its body the way the account transport does on abort:
    // as an error, not as a clean close a reader would reconnect after.
    let bridge!: ReturnType<typeof openStream>
    account.open.mockImplementation(async (input) => {
      bridge = openStream(input.signal)
      return bridge.response
    })
    const [accountState, setAccountState] = createSignal<{ status: "signed" | "unsigned" }>({ status: "signed" })
    render(() => (
      <ClaxedoEventsProvider pathname={() => "/"} serverUrl={() => "http://127.0.0.1:3001"} accountState={accountState}>
        <ConnectionState />
      </ClaxedoEventsProvider>
    ))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const daemonOpens = transport.request.mock.calls.filter(([input]) =>
      new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.endsWith("/api/cp/events"))
    expect(daemonOpens).toHaveLength(1)
    expect(account.open).toHaveBeenCalledTimes(1)
    expect(account.open.mock.calls[0]?.[0]).toMatchObject({ operation: "controlPlane.events" })
    daemon.send({ type: "heartbeat" })
    bridge.send({ type: "heartbeat" })
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByText("connected")).toBeInTheDocument()

    // Signing out removes the account target: its stream is aborted and not
    // reopened, while the daemon's stays.
    account.available = false
    setAccountState({ status: "unsigned" })
    await vi.advanceTimersByTimeAsync(0)
    expect(account.open.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 8)
    expect(account.open).toHaveBeenCalledTimes(1)
    expect(screen.getByText("connected")).toBeInTheDocument()
  })
})
