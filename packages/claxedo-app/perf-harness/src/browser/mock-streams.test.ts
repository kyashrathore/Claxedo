import { afterEach, expect, test } from "bun:test"
import { MOCK_STREAM_FIXTURE_HEADER, mockStreamKind, startMockStreamServer } from "./mock-streams"

const servers: ReturnType<typeof startMockStreamServer>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop() })

function server() {
  const value = startMockStreamServer({ port: 0 })
  servers.push(value)
  return value
}

function fixture(target: ReturnType<typeof server>, id: string) {
  const lease = target.registerFixture({ origin: "http://127.0.0.1:47000", directories: [`/fixture/${id}`], sessionIds: [id] })
  return { ...lease, headers: { [MOCK_STREAM_FIXTURE_HEADER]: lease.id, origin: "http://127.0.0.1:47000" } }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Fixture stream did not release its connection")
}

function frame(bytes: Uint8Array | undefined) {
  const text = new TextDecoder().decode(bytes)
  const line = text.split("\n").find((line) => line.startsWith("data: "))
  return { text, payload: line ? JSON.parse(line.slice(6)) : undefined }
}

test("stream routing matches the actual central, workspace-bus, and runtime owners", () => {
  expect(mockStreamKind("/global/event")).toBe("central")
  expect(mockStreamKind("/api/claxedo/events")).toBe("central")
  expect(mockStreamKind("/api/wr/events")).toBe("workspace-bus")
  expect(mockStreamKind("/event")).toBe("runtime")
  expect(mockStreamKind("/api/wr/runtime-events")).toBe("runtime")
  expect(mockStreamKind("/api/wr/events/unknown")).toBeUndefined()
})

test("real streams expose headers immediately and preserve route-specific heartbeat and cursor contracts", async () => {
  const target = server()
  const lease = fixture(target, "session-a")
  const abort = new AbortController()
  const expiry = setTimeout(() => abort.abort(), 13_000)
  try {
    const paths = ["/api/claxedo/events", "/api/wr/events", "/api/wr/runtime-events"]
    const responses = await Promise.race([
      Promise.all(paths.map((path) => fetch(`${target.origin}${path}`, { headers: lease.headers, signal: abort.signal }))),
      Bun.sleep(1_000).then(() => { throw new Error("SSE headers waited for the first heartbeat") }),
    ])
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(response.headers.get("access-control-allow-origin")).toBe(lease.headers.origin)
    }
    const [central, bus, runtime] = responses.map((response) => response.body!.getReader())
    const connected = frame((await central.read()).value)
    expect(connected.text).toContain("id: 0\n")
    expect(connected.payload).toMatchObject({ directory: "global", payload: { type: "server.connected", properties: {} } })
    const initialBus = frame((await bus.read()).value)
    expect(initialBus.text).toContain("id: 0\n")
    expect(initialBus.payload).toEqual({ type: "heartbeat" })

    const runtimeFlush = frame((await runtime.read()).value)
    expect(runtimeFlush.text).toBe(":\n\n")
    expect(runtimeFlush.payload).toBeUndefined()
    expect(runtimeFlush.text).not.toContain("id:")

    let runtimeYielded = false
    const runtimeRead = runtime.read().then((result) => { runtimeYielded = true; return result })
    await Bun.sleep(30)
    expect(runtimeYielded).toBe(false)
    const [centralHeartbeat, busHeartbeat, runtimeHeartbeat] = await Promise.all([
      central.read(), bus.read(), runtimeRead,
    ])
    for (const result of [centralHeartbeat, busHeartbeat, runtimeHeartbeat]) {
      expect(result.done).toBe(false)
      expect(frame(result.value).text).not.toContain("id:")
    }
    expect(frame(centralHeartbeat.value).payload.payload.type).toBe("server.connected")
    expect(frame(busHeartbeat.value).payload).toEqual({ type: "heartbeat" })
    expect(frame(runtimeHeartbeat.value).payload).toEqual({ type: "heartbeat" })
    expect(target.activeConnections).toBe(3)
    abort.abort()
    await until(() => target.activeConnections === 0)
  } finally {
    clearTimeout(expiry)
    abort.abort()
  }
}, 15_000)

test("page leases isolate scopes, reject unknown clients, and release streams independently", async () => {
  const target = server()
  const first = fixture(target, "first")
  const second = fixture(target, "second")
  const url = `${target.origin}/api/wr/events`
  expect((await fetch(url)).status).toBe(403)
  expect((await fetch(url, { headers: { ...first.headers, origin: "http://other.test" } })).status).toBe(403)
  expect((await fetch(`${url}?sessionID=second`, { headers: first.headers })).status).toBe(404)
  expect((await fetch(`${url}?directory=/fixture/second`, { headers: first.headers })).status).toBe(404)
  expect((await fetch(url, { method: "POST", headers: first.headers })).status).toBe(405)
  expect((await fetch(`${target.origin}/unregistered`, { headers: first.headers })).status).toBe(404)
  const abort = new AbortController()
  const opened = await Promise.all([first, second].map((lease) => fetch(url, { headers: lease.headers, signal: abort.signal })))
  const readers = opened.map((response) => response.body!.getReader())
  await Promise.all(readers.map((reader) => reader.read()))
  expect(target.activeConnections).toBe(2)
  first.close()
  expect((await readers[0].read()).done).toBe(true)
  expect(target.activeConnections).toBe(1)
  expect((await fetch(url, { headers: first.headers })).status).toBe(403)
  abort.abort()
  await until(() => target.activeConnections === 0)
  target.stop()
  target.stop()
  expect(() => fixture(target, "late")).toThrow("stopped")
})

test("server stop closes active streams and releases its listening port", async () => {
  const target = server()
  const lease = fixture(target, "session-a")
  const response = await fetch(`${target.origin}/api/wr/events`, { headers: lease.headers })
  const reader = response.body!.getReader()
  await reader.read()
  expect(target.activeConnections).toBe(1)
  target.stop()
  expect(target.activeConnections).toBe(0)
  await reader.read().catch(() => undefined)
  const replacement = startMockStreamServer({ port: target.port })
  servers.push(replacement)
  expect(replacement.port).toBe(target.port)
})
