import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-event-runtime/contracts"

export const MOCK_STREAM_FIXTURE_HEADER = "x-claxedo-perf-fixture"
const CENTRAL_HEARTBEAT_MS = 5_000

/** The route owner determines each stream's wire contract. */
export function mockStreamKind(pathname: string): "central" | "workspace-bus" | "runtime" | undefined {
  if (pathname === "/global/event" || pathname === "/api/claxedo/events") return "central"
  if (pathname === "/api/wr/events") return "workspace-bus"
  if (pathname === "/event" || pathname === "/api/wr/runtime-events") return "runtime"
  return undefined
}

type StreamFixture = {
  origin: string
  directories: readonly string[]
  sessionIds: readonly string[]
}

type FixtureLease = StreamFixture & { connections: Set<() => void> }

/**
 * route.fulfill buffers a complete body and therefore cannot represent a live
 * stream. Only SSE goes through this loopback server; ordinary API fixtures
 * remain owned by the page's route handler. Each page has an independent lease
 * so closing one page cannot retain its subscriptions or close another's.
 */
export function startMockStreamServer(input: { port: number }) {
  const fixtures = new Map<string, FixtureLease>()
  let stopped = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url)
      const kind = mockStreamKind(url.pathname)
      if (!kind) return Response.json({ error: "Unknown fixture stream" }, { status: 404 })
      const lease = fixtures.get(request.headers.get(MOCK_STREAM_FIXTURE_HEADER) ?? "")
      if (!lease) return Response.json({ error: "Unknown fixture lease" }, { status: 403 })
      const origin = request.headers.get("origin")
      if (origin && origin !== lease.origin) return Response.json({ error: "Wrong fixture origin" }, { status: 403 })
      const headers = {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": lease.origin,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? `authorization, content-type, last-event-id, ${MOCK_STREAM_FIXTURE_HEADER}`,
        "vary": "Origin",
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
      if (request.method !== "GET") return Response.json({ error: "Fixture streams require GET" }, { status: 405, headers })
      const directory = url.searchParams.get("directory")
      const sessionId = url.searchParams.get("parentSessionId") ?? url.searchParams.get("sessionID")
      if ((directory && !lease.directories.includes(directory)) || (sessionId && !lease.sessionIds.includes(sessionId))) {
        return Response.json({ error: "Stream scope does not belong to this fixture" }, { status: 404, headers })
      }

      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const encoder = new TextEncoder()
      const write = (payload: unknown, id?: string) => controller?.enqueue(
        encoder.encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(payload)}\n\n`),
      )
      let timer: ReturnType<typeof setInterval> | undefined
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        if (timer !== undefined) clearInterval(timer)
        request.signal.removeEventListener("abort", close)
        lease.connections.delete(close)
        try { controller?.close() } catch { /* The browser may have cancelled its reader first. */ }
      }
      const connected = () => ({
        directory: "global",
        payload: { id: crypto.randomUUID(), type: "server.connected", properties: {} },
      })
      const heartbeat = () => kind === "central" ? connected() : { type: "heartbeat" }
      const body = new ReadableStream<Uint8Array>({
        start(next) {
          controller = next
          lease.connections.add(close)
          request.signal.addEventListener("abort", close, { once: true })
          if (request.signal.aborted) return close()
          // Match central connectedFrame and runtimeBusEventsHandler. The
          // snapshot has an empty replay log; periodic heartbeats never advance
          // its cursor. Runtime/session event streams have no initial event.
          if (kind !== "runtime") write(heartbeat(), request.headers.get("last-event-id") ?? "0")
          // Bun buffers headers until the first body bytes. An SSE comment
          // flushes the transport without dispatching an event or cursor.
          else next.enqueue(encoder.encode(":\n\n"))
          timer = setInterval(() => {
            if (closed) return
            // An unread stream cannot grow an unbounded heartbeat queue.
            if ((next.desiredSize ?? 0) <= 0) return
            write(heartbeat())
          }, kind === "central" ? CENTRAL_HEARTBEAT_MS : EVENT_STREAM_HEARTBEAT_MS)
        },
        cancel: close,
      })
      return new Response(body, { headers })
    },
  })

  const unregister = (id: string) => {
    const fixture = fixtures.get(id)
    if (!fixture) return
    fixtures.delete(id)
    // Copied before iterating: each `close()` removes itself from the set.
    for (const close of Array.from(fixture.connections)) close()
  }
  return {
    port: server.port!,
    origin: `http://127.0.0.1:${server.port}`,
    registerFixture(fixture: StreamFixture) {
      if (stopped) throw new Error("Cannot register a fixture on a stopped stream server")
      const id = crypto.randomUUID()
      fixtures.set(id, { ...fixture, connections: new Set() })
      return { id, close: () => unregister(id) }
    },
    get activeConnections() {
      return [...fixtures.values()].reduce((count, fixture) => count + fixture.connections.size, 0)
    },
    stop() {
      if (stopped) return undefined
      stopped = true
      // Copied before iterating: `unregister` deletes from the same map.
      for (const id of Array.from(fixtures.keys())) unregister(id)
      // Awaited so the listener has released its port before the next fixture
      // binds one; the caller (`stopApp`) is already async.
      return server.stop(true)
    },
  }
}
