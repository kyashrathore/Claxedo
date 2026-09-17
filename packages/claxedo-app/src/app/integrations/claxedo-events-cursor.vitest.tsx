import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import { resetSessionEventScope } from "@/platform/runtime/session-event-scope"
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

    for (const delay of [2_000, 2_000, 4_000, 8_000]) {
      const attempts = transport.request.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(transport.request).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(transport.request).toHaveBeenCalledTimes(attempts + 1)
    }
    expect(errors).toHaveBeenCalledTimes(1)

    const recovered = openStream()
    transport.request.mockResolvedValueOnce(recovered.response)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(screen.getByText("connected")).toBeInTheDocument()
    recovered.close()
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [2_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(delay)
    expect(errors).toHaveBeenCalledTimes(2)
  })
})
